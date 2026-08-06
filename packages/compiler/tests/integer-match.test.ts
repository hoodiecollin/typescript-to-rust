/**
 * Specs for integer `switch` → literal-pattern `match` (series 019). Drives the
 * public `emit(...)` entry and asserts that an integer discriminant is retyped to
 * `i64` and its cases become bare literal-pattern arms (`1 => …`), superseding the
 * series-009 guarded-wildcard form (`_ if x == 1.0`). The cargo-backed
 * COMPILES/BEHAVES proof lives in compiler.test.ts. IDs map to
 * series 019.
 *
 * RED against the existing guarded-wildcard behaviour: until `promoteIntegerMatches`
 * lands, an integer `switch` still emits `_ if x == 1.0 => …`. IMATCH4/5 are
 * fallbacks (kept f64); IMATCH6 proves a `usize` discriminant still promotes.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

const MATCH_NUM = `function matchNum(x: number): string {
  switch (x) {
    case 1: return "one";
    case 2: return "two";
    default: return "other";
  }
}
console.log(matchNum(1));
console.log(matchNum(2));
console.log(matchNum(9));`;

describe("integer match: switch → literal-pattern match", () => {
  test("IMATCH1 an integer switch retypes the discriminant param to i64", () => {
    expect(compile(MATCH_NUM)).toContain("fn matchNum(x: i64)");
  });

  test("IMATCH2 each integer case becomes a bare literal-pattern arm", () => {
    const rust = compile(MATCH_NUM);
    expect(rust).toContain("1 => {");
    expect(rust).toContain("2 => {");
    expect(rust).not.toContain("_ if x == 1.0");
  });

  test("IMATCH3 `default` stays the wildcard arm", () => {
    const rust = compile(MATCH_NUM);
    expect(rust).toContain("_ => {");
    expect(rust).toContain(`return "other".to_string();`);
  });

  test("IMATCH4 a discriminant used fractionally is not promoted (fallback)", () => {
    // `x / 2` — i64 division would truncate, so the guarded f64 form is kept.
    const rust = compile(
      `function f(x: number): number { switch (x) { case 1: return x / 2; default: return x; } }`,
    );
    expect(rust).toContain("_ if x == 1.0");
    expect(rust).toContain("x: f64");
    expect(rust).not.toContain("i64");
  });

  test("IMATCH5 (fallback) a caller passing a non-integer literal keeps f64", () => {
    // `classify(n)` — the arg is a variable, not an integer literal, so the param
    // can't be retyped to i64; the guarded f64 match is kept.
    const rust = compile(
      `function classify(x: number): string { switch (x) { case 1: return "one"; default: return "other"; } }\n` +
        `const n: number = 1;\nconsole.log(classify(n));`,
    );
    expect(rust).toContain("_ if x == 1.0");
    expect(rust).toContain("fn classify(x: f64)");
  });

  test("IMATCH6 a `usize` (index) discriminant still promotes to literal patterns", () => {
    // `i` indexes `arr`, so it is `usize`; the switch on `i` promotes with `usize`
    // literal patterns (no `i64`, no call boundary).
    const rust = compile(
      `function pick(arr: Array<number>, i: number): number {\n` +
        `  const x: number = arr[i];\n` +
        `  switch (i) { case 0: return x; default: return 0; }\n` +
        `}`,
    );
    expect(rust).toContain("i: usize");
    expect(rust).toContain("0 => {");
    expect(rust).not.toContain("_ if i ==");
  });
});
