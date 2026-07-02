/**
 * String-borrow inference: refine a read-only `string` parameter's Rust type
 * from `&String` into the idiomatic `&str` (the borrowed string slice).
 *
 * The ownership pass (`analysis.ts`) already decides `ref` vs `refMut` vs `move`
 * for each parameter from how the callee uses it, and lowering folds that into
 * the parameter type: a read-only string parameter arrives here as `&String`, a
 * mutated one as `&mut String`, a moved one as owned `String`. This pass rewrites
 * only the first — `&String` → `&str` — leaving `&mut String` (can't grow a
 * `str`) and owned `String` (keeps ownership) alone. Call sites are unchanged:
 * a `&String` argument coerces to a `&str` parameter by deref coercion.
 *
 * Like `refineNumerics`, this is a standalone, pure, idempotent HIR → HIR pass
 * invoked as the final gate step in `lower()`. It mutates the module in place.
 */

import type { HirModule, HirParam } from "./hir";

export function refineStrings(module: HirModule): HirModule {
  for (const fn of module.items) {
    for (const param of fn.params) refineParam(param);
  }
  return module;
}

/**
 * A read-only `&String` parameter becomes `&str`. Mutable `&mut String`
 * (can't grow a `str`) and owned `String` (keeps ownership) are left alone, as is
 * any non-string type — so this is safe to run on already-refined params.
 */
function refineParam(param: HirParam): void {
  const ty = param.ty;
  if (ty.kind === "ref" && !ty.mut && ty.inner.kind === "String") {
    ty.inner = { kind: "str" };
  }
}
