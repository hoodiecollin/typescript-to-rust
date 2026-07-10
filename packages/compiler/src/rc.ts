/**
 * `"use rc"` refinement (series 028b) — the sanctioned Option-B fallback.
 *
 * A post-lowering HIR → HIR pass (like `numeric.ts` / `ownership.ts`). Within a
 * scope opted in by a leading `"use rc"` directive, a binding of a **class** type
 * is translated under `Rc<RefCell<T>>` instead of a plain move. This turns
 * shared-mutable aliasing — which Option A's idiomatic borrows cannot express
 * (`const b = a; a.x = …; use(b.x)` is a move error) — into working Rust:
 *
 *   - `const a: C = new C(…)`  →  `let a: Rc<RefCell<C>> = Rc::new(RefCell::new(C::new(…)))`
 *   - `const b: C = a`         →  `let b: Rc<RefCell<C>> = Rc::clone(&a)`   (shared handle)
 *   - read  `a.field`          →  `a.borrow().field`
 *   - write `a.field = v`      →  `a.borrow_mut().field = v`               (interior mutability)
 *
 * Scope of this first increment: class-typed bindings, straight-line over a body
 * in document order (`rc` accumulates like `ownership.ts`'s `movable`). Interior
 * mutability means these bindings are never `mut`. **Deferred (cargo-loud, never a
 * silent miscompile):** calling a method on an `rc` binding (`a.foo()` stays bare
 * → `Rc<RefCell<C>>` has no `C` methods → cargo `E0599`), `rc` fields/params,
 * nested-scope shadowing, and passing an `rc` value across a call boundary.
 */

import { SCRIPT_SCOPE } from "./analysis";
import { UnsupportedError } from "./errors";
import type { HirExpr, HirModule, HirStmt } from "./hir";

export interface RcOpts {
  rcScopes: ReadonlySet<string>;
  classes: ReadonlySet<string>;
}

export function refineRc(module: HirModule, opts: RcOpts): HirModule {
  if (opts.rcScopes.size === 0) return module;
  if (opts.rcScopes.has(SCRIPT_SCOPE)) rcBody(module.main, opts.classes);
  for (const item of module.items) {
    if (item.kind === "fn" && opts.rcScopes.has(item.name)) {
      rcBody(item.body, opts.classes);
    }
  }
  return module;
}

/**
 * Rewrite one `"use rc"` body in place. `rc` holds the names bound to an
 * `Rc<RefCell<…>>` so far (document order); field/index accesses of those names
 * are routed through `.borrow()` / `.borrow_mut()`, and a bare-ident alias of one
 * becomes an `Rc::clone`.
 */
function rcBody(body: HirStmt[], classes: ReadonlySet<string>): void {
  const rc = new Set<string>();

  /** Route a possibly-`rc` object through `.borrow()` (read) / `.borrow_mut()` (write). */
  const maybeBorrow = (object: HirExpr, write: boolean): HirExpr => {
    if (object.kind === "ident" && rc.has(object.name)) {
      return {
        kind: "method",
        receiver: object,
        name: write ? "borrow_mut" : "borrow",
        args: [],
      };
    }
    return object;
  };

  /**
   * Rewrite reads (and, when `write`, the outermost object of an assignment
   * target) so `rc` accesses go through the `RefCell`. Pure structural recursion
   * over every `HirExpr` kind; only `field`/`index` on an `rc` ident change.
   */
  const rewrite = (e: HirExpr, write = false): HirExpr => {
    switch (e.kind) {
      case "field":
        return { ...e, object: maybeBorrow(rewrite(e.object), write) };
      case "index":
        return {
          ...e,
          object: maybeBorrow(rewrite(e.object), write),
          index: rewrite(e.index),
        };
      case "assign":
        return {
          ...e,
          target: rewrite(e.target, true),
          value: rewrite(e.value),
        };
      case "binary": {
        // Struct identity under `"use rc"` (series 047b): `a === b` over two `rc`
        // handles compares the handles with `Rc::ptr_eq` (JS identity — an alias
        // is equal, a fresh equal value is not), not structural `==`. `!==` wraps
        // in `!`. Mixing an `rc` handle with a non-`rc` operand can't compare a
        // handle to a value → fail loud rather than guess.
        if (e.op === "===" || e.op === "!==") {
          const lRc = e.left.kind === "ident" && rc.has(e.left.name);
          const rRc = e.right.kind === "ident" && rc.has(e.right.name);
          if (lRc && rRc) {
            const ptrEq: HirExpr = {
              kind: "call",
              callee: "Rc::ptr_eq",
              args: [
                { borrow: "ref", expr: e.left },
                { borrow: "ref", expr: e.right },
              ],
            };
            return e.op === "===" ? ptrEq : { kind: "unary", op: "!", operand: ptrEq };
          }
          if (lRc !== rRc) {
            throw new UnsupportedError({
              type: "identity comparison mixes an rc binding with a non-rc operand",
            });
          }
        }
        return { ...e, left: rewrite(e.left), right: rewrite(e.right) };
      }
      case "unary":
        return { ...e, operand: rewrite(e.operand) };
      case "call":
        return {
          ...e,
          args: e.args.map((a) => ({ ...a, expr: rewrite(a.expr) })),
        };
      case "println":
        return { ...e, args: e.args.map((a) => rewrite(a)) };
      case "method":
        // The receiver of a *method* call is left bare: an `rc` method call is a
        // deferred case (cargo-loud), not silently borrow-wrapped.
        return {
          ...e,
          receiver: rewrite(e.receiver),
          args: e.args.map((a) => rewrite(a)),
        };
      case "len":
        return { ...e, object: rewrite(e.object) };
      case "array":
        return { ...e, elements: e.elements.map((el) => rewrite(el)) };
      case "hashmap":
        return {
          ...e,
          entries: e.entries.map((en) => ({
            key: rewrite(en.key),
            value: rewrite(en.value),
          })),
        };
      case "structLit":
        return {
          ...e,
          fields: e.fields.map((f) => ({ ...f, value: rewrite(f.value) })),
        };
      case "ok":
        return e.value ? { ...e, value: rewrite(e.value) } : e;
      case "try":
      case "await":
        return { ...e, expr: rewrite(e.expr) };
      case "iterMap":
      case "iterFilter":
        return {
          ...e,
          receiver: rewrite(e.receiver),
          forwarded: e.forwarded.map((f) => rewrite(f)),
        };
      case "rcNew":
        return { ...e, inner: rewrite(e.inner) };
      case "rcClone":
        return { ...e, expr: rewrite(e.expr) };
      case "ref":
        return { ...e, expr: rewrite(e.expr) };
      case "collectVec":
        return { ...e, iter: rewrite(e.iter) };
      // Leaves: number, string, bool, ident, path.
      default:
        return e;
    }
  };

  const walkStmt = (s: HirStmt): void => {
    switch (s.kind) {
      case "let": {
        // Rewrite reads in the initializer *before* this binding is in scope.
        s.init = rewrite(s.init);
        const classTy =
          s.ty?.kind === "struct" && classes.has(s.ty.name) ? s.ty : null;
        const alias = s.init.kind === "ident" && rc.has(s.init.name);
        if (classTy || alias) {
          s.init = alias
            ? { kind: "rcClone", expr: s.init }
            : { kind: "rcNew", inner: s.init };
          if (classTy) s.ty = { kind: "rc", inner: classTy };
          s.mut = false; // RefCell gives interior mutability — the handle is not `mut`.
          rc.add(s.name);
        }
        return;
      }
      case "expr":
        s.expr = rewrite(s.expr);
        return;
      case "return":
        if (s.value) s.value = rewrite(s.value);
        return;
      case "throw":
        s.value = rewrite(s.value);
        return;
      case "if":
        s.cond = rewrite(s.cond);
        s.conseq.forEach(walkStmt);
        if (s.alt) s.alt.forEach(walkStmt);
        return;
      case "while":
        s.cond = rewrite(s.cond);
        s.body.forEach(walkStmt);
        return;
      case "block":
        s.body.forEach(walkStmt);
        return;
      case "forIn":
        s.iter = rewrite(s.iter);
        s.body.forEach(walkStmt);
        return;
      case "forRange":
        s.start = rewrite(s.start);
        s.end = rewrite(s.end);
        s.body.forEach(walkStmt);
        return;
      case "match":
        s.disc = rewrite(s.disc);
        for (const arm of s.arms) {
          if (arm.guard) arm.guard = rewrite(arm.guard);
          arm.body.forEach(walkStmt);
        }
        return;
      case "tryCatch":
        s.tryBody.forEach(walkStmt);
        s.catchBody.forEach(walkStmt);
        if (s.finallyBody) s.finallyBody.forEach(walkStmt);
        return;
      // break / continue: no operands.
    }
  };

  body.forEach(walkStmt);
}
