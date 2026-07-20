/**
 * Specs for idiomatic `for i in a..b` ranges (series 020). Drives the public
 * `emit(...)` entry and asserts that a canonical `usize` counting `for` — an
 * index-driven loop — is rewritten from the while-desugar (series 006/018) into a
 * native range, while non-eligible loops keep the correct while-desugar. The
 * cargo-backed COMPILES/BEHAVES proof lives in compiler.test.ts. IDs map to
 * docs/work/020-for-range/specs.md.
 *
 * RED against the while-desugar: until `promoteRanges` lands, an index-driven
 * counting loop still emits `let mut i: usize = 0; while i < arr.len()`. RANGE5/6
 * are non-promotions (kept as `while`).
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

describe("for-range: canonical usize counting for → range", () => {
  test("RANGE1 an index-driven `.length` loop promotes to `for i in 0..arr.len()`", () => {
    const rust = compile(
      `function f(arr: Array<number>): void {\n` +
        `  for (let i = 0; i < arr.length; i = i + 1) { console.log(arr[i]); }\n` +
        `}`,
    );
    expect(rust).toContain("for i in 0..arr.len()");
    expect(rust).not.toContain("while i <");
  });

  test("RANGE2 a literal bound emits a bare integer range", () => {
    const rust = compile(
      `function f(arr: Array<number>): void {\n` +
        `  for (let i = 0; i < 3; i = i + 1) { console.log(arr[i]); }\n` +
        `}`,
    );
    expect(rust).toContain("for i in 0..3");
    expect(rust).not.toContain("0.0..3.0");
    expect(rust).not.toContain("while");
  });

  test("RANGE3 a `<=` test emits an inclusive range", () => {
    const rust = compile(
      `function f(arr: Array<number>): void {\n` +
        `  for (let i = 0; i <= 2; i = i + 1) { console.log(arr[i]); }\n` +
        `}`,
    );
    expect(rust).toContain("for i in 0..=2");
  });

  test("RANGE4 a `break` in the body is preserved and stays a native range", () => {
    const rust = compile(
      `function f(arr: Array<number>): void {\n` +
        `  for (let i = 0; i < arr.length; i = i + 1) { if (arr[i] > 100) { break; } console.log(arr[i]); }\n` +
        `}`,
    );
    expect(rust).toContain("for i in 0..arr.len()");
    expect(rust).toContain("break;");
    expect(rust).not.toContain("while");
  });

  test("RANGE5 (non-promotion) the i64 accumulator loop stays a `while`", () => {
    // Series 103b-1 retypes `i` and `total` to `i64` (a pure-integer accumulator
    // loop), so this is native integer arithmetic — but it stays a `while`, because
    // `promoteRanges` still only lifts a `usize` counter to a range (103b-2
    // generalizes range promotion to `i64`). The `f64` return is bridged with a cast.
    const rust = compile(
      `function sum(): number {\n` +
        `  let total: number = 0;\n` +
        `  for (let i = 0; i < 5; i = i + 1) { total = total + i; }\n` +
        `  return total;\n` +
        `}`,
    );
    expect(rust).toContain("let mut i: i64 = 0");
    expect(rust).toContain("let mut total: i64 = 0");
    expect(rust).toContain("while i < 5 {");
    expect(rust).toContain("return (total as f64)");
    expect(rust).not.toContain("for i in");
  });

  test("RANGE6 an own `continue` now promotes to a range with a native `continue` (series 064)", () => {
    // Series 064 graduates the 018 residual: `continue` is native in a range (it
    // advances the counter automatically), so the counting loop still promotes and
    // the desugar's inlined update is stripped back to a bare `continue`.
    const rust = compile(
      `function f(arr: Array<number>): void {\n` +
        `  for (let i = 0; i < arr.length; i = i + 1) { if (arr[i] > 100) { continue; } console.log(arr[i]); }\n` +
        `}`,
    );
    expect(rust).toContain("for i in 0..arr.len()");
    expect(rust).toContain("continue;");
    expect(rust).not.toContain("while i <");
  });
});
