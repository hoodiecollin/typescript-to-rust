/**
 * Specs for series 048c — `fn`-pointer values (LIFT9–12). A function-type
 * annotation `(n: number) => number` lowers to a bare `fn`-pointer `fn(f64) ->
 * f64` (a `Copy` value, passed by value). A non-capturing top-level fn / normalized
 * arrow passed as an argument coerces to that pointer. The fail-loud boundary: an
 * inline arrow that captures an outer local as a function *value* has no pointer
 * form (`UnsupportedError`), and the shipped mutable-capture `forEach` still works
 * (it is not lifted — decision 2026-07-08).
 *
 * IDs map to docs/work/048-lambda-lifting-closures/specs.md.
 */

import { expect, test } from "bun:test";
import { UnsupportedError } from "../src/lower";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("lift-fnptr", [
  {
    name: "LIFT9 a function-value param → fn(f64) -> f64; bare fn coerces",
    src: `function double(n: number): number { return n * 2; }
function apply(f: (n: number) => number, x: number): number { return f(x); }
console.log(apply(double, 5));`,
    expected: "10",
    extra: ({ rust }) => {
      expect(rust).toContain("f: fn(f64) -> f64");
      expect(rust).toContain("apply(double, 5.0)");
    },
  },
  {
    name: "LIFT10 a non-capturing normalized arrow coerces to the pointer",
    src: `function apply(f: (n: number) => number, x: number): number { return f(x); }
const inc = (n: number): number => n + 1;
console.log(apply(inc, 5));`,
    expected: "6",
    // 015's normalized arrow is a free `fn inc`, which coerces to `fn(f64) -> f64`.
    extra: ({ rust }) => expect(rust).toContain("fn inc(n: f64) -> f64"),
  },
  {
    name: "LIFT11 mutable-capture forEach still works (not lifted, not rejected)",
    src: `let total = 0;
[1, 2, 3].forEach(x => { total = total + x; });
console.log(total);`,
    expected: "6",
  },
]);

test("LIFT12 a capturing arrow passed as a value is fail-loud", () => {
  expect(() =>
    compile(
      `function apply(f: (n: number) => number, x: number): number { return f(x); }
const y = 3;
console.log(apply(x => x + y, 5));`,
    ),
  ).toThrow(UnsupportedError);
});
