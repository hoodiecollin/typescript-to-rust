/**
 * Specs for series 046c — mandatory return types. A *missing* return type used
 * to default silently to `-> ()`; it now fails loud (`UnsupportedError`) on
 * functions, methods, and `const`-bound arrows. An explicit `: void` still
 * lowers to `-> ()`, and an annotated return still works.
 *
 * IDs map to docs/work/046-type-annotation-enforcement/specs.md.
 */

import { expect, test } from "bun:test";
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

// 046c's "missing return type fails loud" rule was RELAXED by series 099: a
// return type the lib-backed oracle infers to a modeled `RustType` now compiles.
// TYP15/TYP18/TYP19 (formerly fail-loud pins) now infer `-> f64` — the graduation
// is covered by inference-tier.test.ts (INF3-5). A parameter still has no
// inferable type, so `parameter '<name>' without a type annotation` stays loud
// (INF-FL7); a return whose inferred type is out of surface stays loud (INF-FL5/6).
test("TYP15 a function with no return type infers (graduated by 099)", () => {
  expect(() =>
    compile(`function f(x: number) { return x; }\nconsole.log(f(2));`),
  ).not.toThrow();
});

test("TYP18 a method with no return type infers (graduated by 099)", () => {
  expect(() =>
    compile(`class C { m(x: number) { return x; } }`),
  ).not.toThrow();
});

test("TYP19 a const-bound arrow with no return type infers (graduated by 099)", () => {
  expect(() =>
    compile(`const f = (x: number) => x + 1;\nconsole.log(f(3));`),
  ).not.toThrow();
});
