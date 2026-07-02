/**
 * Specs for `for…of` (series 008). Drives the public `emit(...)` entry and
 * asserts the emitted shape: a Rust `for <pat> in <iterable>.iter() { … }`,
 * iterating by reference. The cargo-backed COMPILES/BEHAVES proof lives in
 * compiler.test.ts. IDs map to docs/work/008-for-of/specs.md.
 *
 * RED against the scaffold seam in `src/lower.ts`: `ForOfStatement` throws
 * `UnsupportedError` "for-of lowering pending" until `lowerForOf` lands. FOF5 is
 * a green control (a C-style `for`, no `for…of`) proving the seam and the new
 * `forIn` node don't regress series-007 lowering.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

const SUM_ARRAY = `function sumArray(arr: Array<number>): number {
  let total: number = 0;
  for (const val of arr) { total = total + val; }
  return total;
}`;

describe("control flow: for…of", () => {
  test("FOF1 the iterable is iterated by reference via `.iter()`", () => {
    expect(compile(SUM_ARRAY)).toContain("for val in arr.iter() {");
  });

  test("FOF2 the loop body nests inside the loop braces", () => {
    expect(compile(SUM_ARRAY)).toMatch(
      /for val in arr\.iter\(\) \{\n {8}total = total \+ val;/,
    );
  });

  test("FOF3 the read-only array parameter is borrowed (`&Vec<f64>`)", () => {
    expect(compile(SUM_ARRAY)).toContain("arr: &Vec<f64>");
  });

  test("FOF4 an empty-body `for…of` still emits a well-formed loop", () => {
    const rust = compile(
      `function f(xs: Array<number>): void { for (const x of xs) {} }`,
    );
    expect(rust).toContain("for x in xs.iter() {");
  });

  test("FOF5 (green control) a C-style for program still emits", () => {
    const rust = compile(
      `function f(): void { for (let i: number = 0; i < 3; i = i + 1) {} }`,
    );
    expect(rust).toContain("while i < 3.0 {");
  });
});
