/**
 * Specs for series 046c — mandatory return types. A *missing* return type used
 * to default silently to `-> ()`; it now fails loud (`UnsupportedError`) on
 * functions, methods, and `const`-bound arrows. An explicit `: void` still
 * lowers to `-> ()`, and an annotated return still works.
 *
 * IDs map to docs/work/046-type-annotation-enforcement/specs.md.
 */

import { expect, test } from "bun:test";
import { UnsupportedError } from "../src/lower";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("type-annot-returns", [
  {
    name: "TYP16 an explicit `: void` lowers to a unit fn (return arrow elided)",
    src: `function log(x: number): void { console.log(x); }\nlog(7);`,
    expected: "7",
    extra: ({ rust }) => {
      // `: void` → `UNIT`; the emitter idiomatically elides a `-> ()` return.
      expect(rust).toContain("fn log(x: f64) {");
      expect(rust).not.toContain("->");
    },
  },
  {
    name: "TYP17 an annotated return still works (regression)",
    src: `function f(x: number): number { return x; }\nconsole.log(f(2));`,
    expected: "2",
  },
  {
    name: "TYP20 an annotated arrow still lowers",
    src: `const f = (x: number): number => x;\nconsole.log(f(3));`,
    expected: "3",
  },
]);

test("TYP15 a function with no return type is rejected", () => {
  expect(() => compile(`function f(x: number) { return x; }`)).toThrow(
    UnsupportedError,
  );
});

test("TYP18 a method with no return type is rejected", () => {
  expect(() =>
    compile(`class C { m(x: number) { return x; } }`),
  ).toThrow(UnsupportedError);
});

test("TYP19 a const-bound arrow with no return type is rejected", () => {
  expect(() => compile(`const f = (x: number) => x;`)).toThrow(
    UnsupportedError,
  );
});
