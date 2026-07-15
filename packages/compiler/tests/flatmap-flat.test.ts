/**
 * Specs for series 085 — `flatMap` (uniform `U[]`-returning callback) + literal-
 * constant `flat(k)` — extended by series 092 (epic #59, increment 3), which
 * graduates three residuals **statically** (no `JsonValue`): `flat(Infinity)`,
 * over-deep/no-op `flat(k)`, and a `flatMap` ternary `cond ? U : U[]` callback.
 * Genuinely-dynamic shapes (runtime-variable depth, heterogeneous `(U|U[])[]`,
 * empty-arm) stay fail-loud → the deferred JsonValue increment. IDs map to
 * docs/work/085-flatmap-flat/specs.md and docs/work/092-static-flat-flatmap/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("flatmap-flat", [
  {
    name: "FM1 flatMap(x => [x, x*10]) — one-level flatten to Vec<f64>",
    src: `const xs: Array<number> = [1, 2, 3];
const ys: Array<number> = xs.flatMap((x: number): Array<number> => [x, x * 10]);
console.log(ys.length, ys[0], ys[1], ys[5]);`,
    expected: "6 1 10 30",
    extra: ({ rust }) => expect(rust).toContain(".flat_map("),
  },
  {
    name: "FM2 flatMap with a captured free var forwards through the lift",
    src: `const k: number = 2;
const xs: Array<number> = [1, 2, 3];
const ys: Array<number> = xs.flatMap((x: number): Array<number> => [x, x * k]);
console.log(ys.length, ys[1], ys[3]);`,
    expected: "6 2 4",
  },
  {
    name: "FM3 flatMap(x => [x]) — degenerate one-to-one identity flatten",
    src: `const xs: Array<number> = [5, 6, 7];
const ys: Array<number> = xs.flatMap((x: number): Array<number> => [x]);
console.log(ys.length, ys[0], ys[2]);`,
    expected: "3 5 7",
    extra: ({ rust }) => expect(rust).toContain(".flat_map("),
  },
  {
    name: "FLATK1 flat(2) on number[][][] — two chained flattens",
    src: `const xss: Array<Array<Array<number>>> = [[[1, 2], [3]], [[4]]];
const flat: Array<number> = xss.flat(2);
console.log(flat.length, flat[0], flat[3]);`,
    expected: "4 1 4",
    extra: ({ rust }) => {
      // Two nested tslib flattens (depth-1 composed).
      expect(rust.split("tslib::array::flat").length - 1).toBe(2);
    },
  },
  {
    name: "FLATK2 flat(1) equals the depth-1 flat()",
    src: `const xss: Array<Array<number>> = [[1, 2], [3, 4]];
const flat: Array<number> = xss.flat(1);
console.log(flat.length, flat[0], flat[3]);`,
    expected: "4 1 4",
    extra: ({ rust }) => expect(rust).toContain("tslib::array::flat"),
  },
  {
    name: "FLATK3 flat(3) on number[][][][] — three chained flattens",
    src: `const xsss: Array<Array<Array<Array<number>>>> = [[[[1], [2]]], [[[3]]]];
const flat: Array<number> = xsss.flat(3);
console.log(flat.length, flat[0], flat[2]);`,
    expected: "3 1 3",
    extra: ({ rust }) => {
      expect(rust.split("tslib::array::flat").length - 1).toBe(3);
    },
  },
  // ── Graduated in 092 (were fail-loud in 085) ────────────────────────────────
  {
    name: "FLATK-FL2 flat(Infinity) → flatten all levels to the scalar leaf",
    src: `const xss: Array<Array<Array<number>>> = [[[1]], [[2]]];
const flat: Array<number> = xss.flat(Infinity);
console.log(flat.length, flat[0], flat[1]);`,
    expected: "2 1 2",
    extra: ({ rust }) =>
      // Nesting N=2 → two chained flattens (Infinity clamped to the static depth).
      expect(rust.split("tslib::array::flat").length - 1).toBe(2),
  },
  {
    name: "FLATK-FL3 flat(2) on a shallower array → min(2, depth) (no under-nested error)",
    src: `const xss: Array<Array<number>> = [[1, 2], [3, 4]];
const flat: Array<number> = xss.flat(2);
console.log(flat.length, flat[0], flat[3]);`,
    expected: "4 1 4",
    extra: ({ rust }) =>
      // Only one level to flatten (N=1), so exactly one flatten despite flat(2).
      expect(rust.split("tslib::array::flat").length - 1).toBe(1),
  },
  {
    name: "FLAT-NOOP flat() on an already-flat array → no-op shallow copy",
    src: `const xs: Array<number> = [1, 2, 3];
const flat: Array<number> = xs.flat();
console.log(flat.length, flat[0], flat[2]);`,
    expected: "3 1 3",
    extra: ({ rust }) => expect(rust).not.toContain("tslib::array::flat"),
  },
  {
    name: "FM-FL1 flatMap ternary `cond ? U[] : U` → homogeneous Vec<f64>",
    src: `const xs: Array<number> = [1, 2, 3];
const ys: Array<number> = xs.flatMap((x: number): Array<number> => (x % 2 === 0 ? [x, x] : x));
console.log(ys.length, ys[0], ys[1], ys[2], ys[3]);`,
    expected: "4 1 2 2 3",
    extra: ({ rust }) => expect(rust).toContain(".flat_map("),
  },
  {
    name: "FM-TERN2 flatMap ternary with both arms arrays",
    src: `const xs: Array<number> = [1, 2, 3];
const ys: Array<number> = xs.flatMap((x: number): Array<number> => (x > 2 ? [x] : [x, x]));
console.log(ys.length, ys[0], ys[4]);`,
    expected: "5 1 3",
  },
  {
    name: "FM-TERN3 flatMap ternary with a captured free var in an arm",
    src: `const k: number = 10;
const xs: Array<number> = [1, 2, 3];
const ys: Array<number> = xs.flatMap((x: number): Array<number> => (x % 2 === 0 ? [x, x * k] : x));
console.log(ys.length, ys[2]);`,
    expected: "4 20",
  },
  // ── Still fail-loud: runtime-variable depth ─────────────────────────────────
  {
    name: "FLATK-FL1 dynamic-depth flat(n) (variable) stays fail-loud (cargo rejects)",
    src: `const n: number = 2;
const xss: Array<Array<Array<number>>> = [[[1]], [[2]]];
const flat: Array<number> = xss.flat(n);
console.log(flat.length);`,
    expectFail: true,
  },
]);

describe("092 fail-loud residuals (deferred to the JsonValue increment → #59)", () => {
  test("FM-FL-HET flatMap returning a heterogeneous `(U | U[])[]` stays fail-loud", () => {
    // `[x, [x]]` is a genuinely dynamic array (a scalar next to an array) — the
    // homogeneous dialect can't type it; deferred to a JsonValue-backed increment.
    const src = `const xs: Array<number> = [1, 2, 3];
const ys = xs.flatMap((x: number) => [x, [x]]);
console.log(ys.length);`;
    expect(() => compile(src)).toThrow();
  });

  test("FM-FL-EMPTY flatMap ternary with an empty-array arm stays fail-loud", () => {
    // An empty arm has no element to infer `U` from → fail-loud.
    const src = `const xs: Array<number> = [1, 2, 3];
const ys = xs.flatMap((x: number) => (x > 0 ? [] : [x]));
console.log(ys.length);`;
    expect(() => compile(src)).toThrow();
  });
});
