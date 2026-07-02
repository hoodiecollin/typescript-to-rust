/**
 * Numeric inference: refine `number` (default `f64`) into `usize` where array
 * indexing demands it, so variable/expression indices compile.
 *
 * ⚠ MOCK / SCAFFOLD (series 003). This is the identity passthrough the real pass
 * will supersede: it establishes the `refineNumerics` seam and is wired into
 * `lower()`, but performs no refinement yet, so the spec-first RED specs in
 * `tests/numeric.test.ts` fail against it. The real fixpoint (seed index
 * positions → propagate `usize` through initializers, assignments, and arithmetic
 * operands → tag literals / bindings, throwing `UnsupportedError` on an
 * int/float conflict) lands in the GREEN step. See docs/work/003-numeric-inference.
 */

import type { HirModule } from "./hir";

/**
 * Refine numeric types in a lowered module, tagging index-reached values as
 * `usize`. Pure HIR → HIR.
 * @throws {UnsupportedError} when a value is forced to be both `usize` and float.
 */
export function refineNumerics(module: HirModule): HirModule {
  // MOCK: identity. Replaced by the real refinement in the GREEN step.
  return module;
}
