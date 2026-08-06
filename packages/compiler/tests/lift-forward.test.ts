/**
 * Specs for series 048b — read-only scalar forwarding (LIFT5–8). A callback's
 * read-only Copy free variables become explicit trailing params of the lifted
 * `fn`, forwarded by value in the shim (`__cb_map_1(*x, bump)`). Covers `map`
 * with a captured scalar, the differential when that scalar changes the result,
 * `reduce`'s two-param shape (its `acc` typed by the init), and two callbacks in
 * one module getting distinct hoisted names from the shared counter.
 *
 * IDs map to series 048. The loggable
 * `console.log(...)` forms keep the spirit of the specs' illustrations (a whole
 * Vec has no Rust `Display`).
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("lift-forward", [
  {
    name: "LIFT5 map forwards a read-only scalar free var by value",
    src: `const bump = 10;
const ys: Array<number> = [1, 2, 3].map(x => x + bump);
console.log(ys[0], ys[1], ys[2]);`,
    expected: "11 12 13",
    extra: ({ rust }) => {
      expect(rust).toContain("fn __cb_map_1(x: f64, bump: f64) -> f64");
      expect(rust).toContain("return x + bump;");
      expect(rust).toContain(".iter().map(|x| __cb_map_1(*x, bump))");
    },
  },
  {
    name: "LIFT6 the forwarded scalar changes the differential result",
    src: `const bump = 100;
const ys: Array<number> = [1, 2, 3].map(x => x + bump);
console.log(ys[0], ys[1], ys[2]);`,
    expected: "101 102 103",
  },
  {
    name: "LIFT7 reduce lifts its two-param body; init seeds acc",
    src: `const seed = 5;
console.log([1, 2, 3].reduce((a, x) => a + x, seed));`,
    expected: "11",
    extra: ({ rust }) => {
      expect(rust).toContain("fn __cb_reduce_1(a: f64, x: f64) -> f64");
      expect(rust).toContain(".fold(seed, |a, x| __cb_reduce_1(a, *x))");
    },
  },
]);

test("LIFT8 two callbacks get distinct hoisted names from one counter", () => {
  const rust = compile(
    `const xs = [1, 2, 3];
const ys: Array<number> = xs.map(x => x * 2);
const zs: Array<number> = xs.filter(x => x > 1);
console.log(ys[0], zs.length);`,
  );
  expect(rust).toContain("fn __cb_map_1");
  expect(rust).toContain("fn __cb_filter_2");
});
