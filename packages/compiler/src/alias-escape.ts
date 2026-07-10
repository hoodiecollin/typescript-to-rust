/**
 * Alias-escape analysis (series 062) — auto-`Rc<RefCell<T>>` for escaping
 * shared-mutable aliasing.
 *
 * A JS object *is* a shared mutable reference: `const b = a; a.inc(); use(b)`
 * expects `b` to observe the mutation. Option A lowers `const b = a` as a move (or,
 * once the value is `Clone`, an independent `.clone()`), so a later mutation of one
 * alias is invisible to the other — a divergence the 059 `aliased`-guard keeps
 * cargo-loud pending this series. This pass detects that pattern and promotes the
 * whole alias closure to `Rc<RefCell<T>>` (via the existing `refineRc` machinery),
 * the faithful model of JS reference semantics.
 *
 * Rule (per the design's "a false positive is cheap" calculus — over-`Rc` is
 * working-but-slower, never a rejected valid program): a class-typed binding is
 * promoted when it is **aliased** (a bare-ident `const b = a` copy links two class
 * bindings) **and** some member of that alias closure is **mutated** (a field write
 * `x.f = …` or a `&mut self` method call). A binding never shared-mutated stays a
 * plain owned value — the promotion is surgical, per-binding, not the scope-wide
 * `"use rc"` blunt wrap.
 *
 * Reuses `ownership.ts`'s syntactic structure; the promoted set feeds `refineRc`.
 */

import { SCRIPT_SCOPE } from "./analysis";
import type { HirExpr, HirModule, HirStmt } from "./hir";

/** Unwrap a `try` (fallible-ctor `?`) around a construction init. */
function unwrapTry(e: HirExpr): HirExpr {
  return e.kind === "try" ? e.expr : e;
}

/** The class name a `let` initializer constructs (`new C()` / a struct literal), or null. */
function constructedClass(
  init: HirExpr,
  classes: ReadonlySet<string>,
): string | null {
  const e = unwrapTry(init);
  if (e.kind === "structLit" && classes.has(e.name)) return e.name;
  if (e.kind === "call") {
    const seg = e.callee.split("::");
    if (seg.length === 2 && seg[1] === "new" && classes.has(seg[0] as string)) {
      return seg[0] as string;
    }
  }
  return null;
}

/** The root identifier of a projection chain (`a.b[c].d` → `a`), or null. */
function rootIdent(e: HirExpr): string | null {
  let cur = e;
  while (cur.kind === "field" || cur.kind === "index") cur = cur.object;
  return cur.kind === "ident" ? cur.name : null;
}

/**
 * The auto-`Rc` promoted binding set for one scope body. Detects class bindings,
 * their bare-ident aliases, and mutations; promotes every alias closure that has
 * ≥2 members and at least one mutated member.
 */
function analyzeScope(
  body: HirStmt[],
  classes: ReadonlySet<string>,
  mutatingMethods: ReadonlySet<string>,
): Set<string> {
  const classBindings = new Set<string>();
  const parent = new Map<string, string>(); // union-find over aliased class bindings
  const mutated = new Set<string>();

  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) {
      r = parent.get(r) as string;
    }
    return r;
  };
  const unite = (a: string, b: string): void => {
    parent.set(a, parent.get(a) ?? a);
    parent.set(b, parent.get(b) ?? b);
    parent.set(find(a), find(b));
  };

  const noteMutations = (e: HirExpr): void => {
    if (e.kind === "assign") {
      // A write whose target projects off an identifier (`x.f = …`, `x[i] = …`).
      if (e.target.kind === "field" || e.target.kind === "index") {
        const root = rootIdent(e.target);
        if (root) mutated.add(root);
      }
    }
    if (e.kind === "method" && mutatingMethods.has(e.name)) {
      const root = rootIdent(e.receiver);
      if (root) mutated.add(root);
    }
    // Recurse into sub-expressions (mutations can be nested in args/values).
    for (const child of subExprs(e)) noteMutations(child);
  };

  const walk = (s: HirStmt): void => {
    if (s.kind === "let" && !s.names) {
      const cls = constructedClass(s.init, classes);
      if (cls) {
        classBindings.add(s.name);
        parent.set(s.name, s.name);
      } else if (s.init.kind === "ident" && classBindings.has(s.init.name)) {
        classBindings.add(s.name);
        unite(s.name, s.init.name);
      }
      noteMutations(s.init);
    } else {
      for (const e of stmtExprs(s)) noteMutations(e);
    }
    for (const b of childBodies(s)) for (const c of b) walk(c);
  };
  for (const s of body) walk(s);

  // Promote every alias closure (≥2 members) that contains a mutated binding.
  const componentOf = new Map<string, string[]>();
  for (const name of classBindings) {
    const root = find(name);
    const members = componentOf.get(root) ?? [];
    members.push(name);
    componentOf.set(root, members);
  }
  const promoted = new Set<string>();
  for (const members of componentOf.values()) {
    if (members.length < 2) continue;
    if (members.some((m) => mutated.has(m))) {
      for (const m of members) promoted.add(m);
    }
  }
  return promoted;
}

/** Direct sub-expressions of an expression (shallow, for mutation recursion). */
function subExprs(e: HirExpr): HirExpr[] {
  switch (e.kind) {
    case "assign":
      return [e.target, e.value];
    case "binary":
      return [e.left, e.right];
    case "unary":
      return [e.operand];
    case "call":
      return e.args.map((a) => a.expr);
    case "println":
      return e.args;
    case "method":
      return [e.receiver, ...e.args];
    case "index":
      return [e.object, e.index];
    case "field":
    case "len":
      return [e.object];
    case "array":
      return e.elements;
    case "structLit":
      return e.fields.map((f) => f.value);
    case "ok":
      return e.value ? [e.value] : [];
    case "try":
    case "await":
    case "tryBreak":
      return [e.expr];
    case "ref":
      return [e.expr];
    case "collectVec":
      return [e.iter];
    default:
      return [];
  }
}

/** The expressions directly held by a statement (not its nested bodies). */
function stmtExprs(s: HirStmt): HirExpr[] {
  switch (s.kind) {
    case "let":
      return [s.init];
    case "expr":
      return [s.expr];
    case "return":
      return s.value ? [s.value] : [];
    case "throw":
    case "breakTry":
      return [s.value];
    case "if":
    case "while":
      return [s.cond];
    case "forIn":
      return [s.iter];
    case "forRange":
      return [s.start, s.end];
    case "match":
      return [s.disc, ...s.arms.flatMap((a) => (a.guard ? [a.guard] : []))];
    default:
      return [];
  }
}

/** The nested statement bodies of a statement (for the recursive walk). */
function childBodies(s: HirStmt): HirStmt[][] {
  switch (s.kind) {
    case "if":
      return s.alt ? [s.conseq, s.alt] : [s.conseq];
    case "while":
    case "block":
    case "forIn":
    case "forRange":
      return [s.body];
    case "match":
      return s.arms.map((a) => a.body);
    case "tryCatch":
      return [
        s.tryBody,
        s.catchBody,
        ...(s.finallyBody ? [s.finallyBody] : []),
      ];
    case "tryBlock":
      return [
        s.tryBody,
        ...(s.catchBody ? [s.catchBody] : []),
        ...(s.finallyBody ? [s.finallyBody] : []),
      ];
    default:
      return [];
  }
}

/**
 * Compute the auto-`Rc` promoted binding set per scope (series 062). Keyed by the
 * free-fn name / `SCRIPT_SCOPE`, matching `refineRc`'s scope iteration.
 */
export function computeAutoRc(
  module: HirModule,
  classes: ReadonlySet<string>,
  mutatingMethods: ReadonlySet<string>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const main = analyzeScope(module.main, classes, mutatingMethods);
  if (main.size > 0) out.set(SCRIPT_SCOPE, main);
  for (const item of module.items) {
    if (item.kind === "fn") {
      const promoted = analyzeScope(item.body, classes, mutatingMethods);
      if (promoted.size > 0) out.set(item.name, promoted);
    }
  }
  return out;
}
