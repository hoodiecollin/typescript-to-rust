/**
 * Specs for series 046b — homogeneous scalar arrays. The untyped-binding
 * exception widens from scalar literals to a *non-empty, same-`typeof`*
 * scalar-literal array (`[1, 2, 3]` → `Vec<f64>`, `["a", "b"]` → `Vec<String>`,
 * `[true, false]` → `Vec<bool>`). Empty, heterogeneous, and non-scalar-element
 * arrays stay fail-loud — their element type is not statically obvious in one
 * pass.
 *
 * IDs map to docs/work/046-type-annotation-enforcement/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";
import { UnsupportedError } from "../src/lower";

defineDifferential("type-annot-arrays", [
  {
    name: "TYP9 an untyped number array → Vec<f64>",
    src: `const xs = [1, 2, 3];\nconsole.log(xs.length);`,
    expected: "3",
    extra: ({ rust }) => expect(rust).toContain("vec![1.0, 2.0, 3.0]"),
  },
  {
    name: "TYP10 an untyped string array → Vec<String>",
    src: `const ss = ["a", "b"];\nconsole.log(ss[0]);`,
    expected: "a",
  },
  {
    name: "TYP11 an untyped bool array → Vec<bool>",
    src: `const bs = [true, false];\nconsole.log(bs.length);`,
    expected: "2",
  },
]);

describe("046b non-obvious arrays fail loud", () => {
  test("TYP12 an empty array with no annotation is rejected", () => {
    expect(() => compile(`const xs = [];`)).toThrow(UnsupportedError);
  });

  test("TYP13 a mixed/heterogeneous array is rejected", () => {
    expect(() => compile(`const xs = [1, "a"];`)).toThrow(UnsupportedError);
  });

  test("TYP14 a non-scalar-element array is rejected", () => {
    expect(() => compile(`const xs = [[1, 2], [3]];`)).toThrow(UnsupportedError);
    expect(() =>
      compile(`function f(): number { return 1; }\nconst xs = [f(), f()];`),
    ).toThrow(UnsupportedError);
  });
});
