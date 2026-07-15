/**
 * Specs for series 083 slice 8 (+9) — Array-access tail methods over the unified
 * `receiverTypeOf` / `elementTypeOf` backbone: `join`, `concat`, `reverse`,
 * `flat` (depth 1). Each differential-matches. Residuals (`flatMap`, deep
 * `flat(n)`, `splice`) stay fail-loud (ARR-FL*). IDs map to
 * docs/work/083-library-methods-oracle/specs.md.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("library-methods-array", [
  {
    name: "ARR1 join(sep) — coerces elements to strings (number array)",
    src: `const xs: Array<number> = [1, 2, 3];
console.log(xs.join("-"));
const ss: Array<string> = ["a", "b"];
console.log(ss.join(", "));`,
    expected: "1-2-3\na, b",
    extra: ({ rust }) => expect(rust).toContain("tslib::array::join"),
  },
  {
    name: "ARR2 concat(ys) — a new array, receiver unchanged",
    src: `const xs: Array<number> = [1, 2, 3];
const ys: Array<number> = [4, 5];
const zs: Array<number> = xs.concat(ys);
console.log(zs.length, xs.length);
console.log(zs[3]);`,
    expected: "5 3\n4",
    extra: ({ rust }) => expect(rust).toContain("tslib::array::concat"),
  },
  {
    name: "ARR3 reverse() — in place (native Vec::reverse)",
    src: `const xs: Array<number> = [1, 2, 3];
xs.reverse();
console.log(xs[0], xs[2]);`,
    expected: "3 1",
    extra: ({ rust }) => expect(rust).toContain(".reverse()"),
  },
  {
    name: "FLAT2a flat() (depth 1) — flatten an array of arrays",
    src: `const xss: Array<Array<number>> = [[1, 2], [3, 4]];
const flat: Array<number> = xss.flat();
console.log(flat.length, flat[0], flat[3]);`,
    expected: "4 1 4",
    extra: ({ rust }) => expect(rust).toContain("tslib::array::flat"),
  },
  {
    name: "ARR-INF join over a getX() array receiver (elementTypeOf oracle tier)",
    src: `function getRows(): Array<number> { return [1, 2, 3]; }
console.log(getRows().join("+"));`,
    expected: "1+2+3",
  },
  {
    // A non-literal depth is unmodeled → generic method fallthrough emits
    // `.flat(n)`, which `Vec` has no method for. Fail-loud at cargo (never a wrong
    // value) — only literal-constant `flat(k)` is claimed (series 085).
    name: "ARR-FL2 dynamic-depth flat(n) (variable) stays fail-loud (cargo rejects)",
    src: `const n: number = 2;
const xss: Array<Array<Array<number>>> = [[[1]], [[2]]];
const flat: Array<number> = xss.flat(n);
console.log(flat.length);`,
    expectFail: true,
  },
]);

// NOTE: the uniform `flatMap(U[])` callback and literal-constant `flat(k)` forms
// shipped in series 085; the `flatMap` ternary `cond ? U : U[]`, `flat(Infinity)`,
// and over-deep `flat(k)` graduated **statically** in series 092 (see
// flatmap-flat.test.ts). The fail-loud boundary here is now the genuinely-dynamic
// residual deferred to the JsonValue increment (→ #59): a heterogeneous
// `(U | U[])[]` return and a runtime-variable-depth `flat(n)`.
test("ARR-FL1 flatMap returning a heterogeneous `(U | U[])[]` stays fail-loud (→ #59)", () => {
  // A typed binding so the failure is the callback's dynamic return, not the
  // binding — `[x, [x]]` is a scalar next to an array (genuinely jagged).
  const src = `const xs: Array<number> = [1, 2, 3];
const ys: Array<number> = xs.flatMap((x: number) => [x, [x]]);
console.log(ys.length);`;
  expect(() => compile(src)).toThrow();
});
