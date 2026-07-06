/**
 * Ownership refinement — inter-procedural moves, first increment (series 034):
 * **use-after-move → `.clone()`**.
 *
 * A post-lowering HIR → HIR pass (like `numeric.ts`/`strings.ts`). Option A emits
 * plain moves; a non-Copy value that is *moved* (bound to another `let`, or
 * passed as an owned call/ctor argument) and then **used again** would be a Rust
 * E0382 (use of moved value). This pass inserts a `.clone()` at every move site
 * that has a later use in the same body, leaving the textually-last use a bare
 * move (no needless clone).
 *
 * Scope of this increment: straight-line reasoning over a body in document order.
 * Only `Clone`-able non-Copy types participate — `String` and `Vec`/`HashMap` of
 * Clone-able elements. Structs are excluded (no `#[derive(Clone)]` yet); a move of
 * a non-cloneable value is left bare and the oracle (cargo) flags it — loud, never
 * a silent miscompile. Loops (a move live across iterations) and nested-scope
 * shadowing are deferred to later increments; being conservative there means a
 * cargo error, not a wrong value.
 */

import type {
  HirExpr,
  HirFn,
  HirModule,
  HirParam,
  HirStmt,
  RustType,
} from "./hir";

export function refineMoves(module: HirModule): HirModule {
  for (const item of module.items) {
    if (item.kind === "fn") {
      refineBody(item.params, item.body);
    } else if (item.kind === "class") {
      if (item.ctor) refineBody(item.ctor.params, item.ctor.body);
      for (const method of item.methods) refineBody(method.params, method.body);
    }
  }
  refineBody([], module.main);
  return module;
}

/** A `Clone`-able non-Copy type: cloning is both needed (non-Copy) and legal. */
function isCloneableMovable(ty: RustType | null): boolean {
  if (!ty) return false;
  switch (ty.kind) {
    case "String":
      return true;
    case "vec":
      return isCloneScalarOrString(ty.elem);
    case "hashmap":
      return isCloneScalarOrString(ty.key) && isCloneScalarOrString(ty.value);
    // Copy scalars need no clone; refs can't move; structs have no Clone derive.
    default:
      return false;
  }
}

/** Cloneable leaf/element types (excludes struct, which has no Clone derive). */
function isCloneScalarOrString(ty: RustType): boolean {
  switch (ty.kind) {
    case "String":
    case "f64":
    case "usize":
    case "i64":
    case "bool":
      return true;
    case "vec":
      return isCloneScalarOrString(ty.elem);
    default:
      return false;
  }
}

/** Wrap an expression in a `.clone()` method call. */
function cloneOf(e: HirExpr): HirExpr {
  return { kind: "method", receiver: e, name: "clone", args: [] };
}

interface MoveSite {
  name: string;
  seq: number;
  /** Rewrite this site's operand to a `.clone()`. */
  apply: () => void;
}

/**
 * Walk a body in document order. `movable` holds the names whose type is a
 * cloneable non-Copy (params + `let` bindings). For each such name we record the
 * sequence number of its last occurrence and every move site; a move site with a
 * later occurrence is then cloned.
 */
function refineBody(params: HirParam[], body: HirStmt[]): void {
  const movable = new Set<string>();
  for (const p of params) if (isCloneableMovable(p.ty)) movable.add(p.name);
  collectLetBindings(body, movable);
  if (movable.size === 0) return;

  let seq = 0;
  const lastUse = new Map<string, number>();
  const moves: MoveSite[] = [];

  const useIdent = (name: string): number => {
    seq += 1;
    lastUse.set(name, seq);
    return seq;
  };

  const visitExpr = (e: HirExpr): void => {
    switch (e.kind) {
      case "ident":
        if (movable.has(e.name)) useIdent(e.name);
        return;
      case "binary":
        visitExpr(e.left);
        visitExpr(e.right);
        return;
      case "unary":
        visitExpr(e.operand);
        return;
      case "assign":
        visitExpr(e.target);
        visitExpr(e.value);
        return;
      case "call":
        for (const a of e.args) {
          if (
            a.borrow === "owned" &&
            a.expr.kind === "ident" &&
            movable.has(a.expr.name)
          ) {
            const arg = a;
            const at = useIdent(a.expr.name);
            moves.push({
              name: (a.expr as { name: string }).name,
              seq: at,
              apply: () => {
                arg.expr = cloneOf(arg.expr);
              },
            });
          } else {
            visitExpr(a.expr);
          }
        }
        return;
      case "println":
        for (const a of e.args) visitExpr(a);
        return;
      case "method":
        visitExpr(e.receiver);
        for (const a of e.args) visitExpr(a);
        return;
      case "index":
        visitExpr(e.object);
        visitExpr(e.index);
        return;
      case "field":
      case "len":
        visitExpr(e.object);
        return;
      case "array":
        for (const el of e.elements) visitExpr(el);
        return;
      case "hashmap":
        for (const en of e.entries) {
          visitExpr(en.key);
          visitExpr(en.value);
        }
        return;
      case "structLit":
        for (const f of e.fields) visitExpr(f.value);
        return;
      case "ok":
        if (e.value) visitExpr(e.value);
        return;
      case "try":
      case "await":
        visitExpr(e.expr);
        return;
      case "iterMap":
      case "iterFilter":
        visitExpr(e.receiver);
        visitExpr(e.body);
        return;
      // Leaves: number, string, bool, path.
    }
  };

  const visitStmt = (s: HirStmt): void => {
    switch (s.kind) {
      case "let": {
        // A `let b = a` where `a` is a bare movable ident is a move of `a`.
        const init = s.init;
        if (init.kind === "ident" && movable.has(init.name)) {
          const at = useIdent(init.name);
          moves.push({
            name: init.name,
            seq: at,
            apply: () => {
              s.init = cloneOf(s.init);
            },
          });
        } else {
          visitExpr(init);
        }
        return;
      }
      case "return":
        if (s.value) visitExpr(s.value);
        return;
      case "expr":
        visitExpr(s.expr);
        return;
      case "if":
        visitExpr(s.cond);
        s.conseq.forEach(visitStmt);
        if (s.alt) s.alt.forEach(visitStmt);
        return;
      case "while":
        visitExpr(s.cond);
        s.body.forEach(visitStmt);
        return;
      case "block":
        s.body.forEach(visitStmt);
        return;
      case "forIn":
        visitExpr(s.iter);
        s.body.forEach(visitStmt);
        return;
      case "forRange":
        visitExpr(s.start);
        visitExpr(s.end);
        s.body.forEach(visitStmt);
        return;
      case "match":
        visitExpr(s.disc);
        for (const arm of s.arms) {
          if (arm.guard) visitExpr(arm.guard);
          if (arm.pat) visitExpr(arm.pat);
          arm.body.forEach(visitStmt);
        }
        return;
      case "throw":
        visitExpr(s.value);
        return;
      case "tryCatch":
        s.tryBody.forEach(visitStmt);
        s.catchBody.forEach(visitStmt);
        if (s.finallyBody) s.finallyBody.forEach(visitStmt);
        return;
      // break / continue: no operands.
    }
  };

  body.forEach(visitStmt);

  // Clone a move that is not the binding's last use.
  for (const mv of moves) {
    if (mv.seq < (lastUse.get(mv.name) ?? mv.seq)) mv.apply();
  }
}

/** Add every `let`-bound name with a cloneable-movable type to `movable`. */
function collectLetBindings(body: HirStmt[], movable: Set<string>): void {
  for (const s of body) {
    switch (s.kind) {
      case "let":
        if (isCloneableMovable(s.ty)) movable.add(s.name);
        break;
      case "if":
        collectLetBindings(s.conseq, movable);
        if (s.alt) collectLetBindings(s.alt, movable);
        break;
      case "while":
      case "block":
      case "forIn":
      case "forRange":
        collectLetBindings(s.body, movable);
        break;
      case "match":
        for (const arm of s.arms) collectLetBindings(arm.body, movable);
        break;
      case "tryCatch":
        collectLetBindings(s.tryBody, movable);
        collectLetBindings(s.catchBody, movable);
        if (s.finallyBody) collectLetBindings(s.finallyBody, movable);
        break;
    }
  }
}

/** Re-exported for callers that pass an `HirFn` directly (tests). */
export type { HirFn };
