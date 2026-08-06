/**
 * Specs for `switch → match` (series 009). Drives the public `emit(...)` entry.
 * A `switch` lowers to a guarded-wildcard `match` (Rust forbids `f64` literal
 * patterns, so cases compare in a guard) — but series 019 now promotes an
 * *integer* discriminant to `i64` with idiomatic literal-pattern arms, so SW2
 * asserts the promoted form (see tests/integer-match.test.ts for the full 019
 * specs). The cargo-backed COMPILES/BEHAVES proof lives in compiler.test.ts. IDs
 * map to series 009.
 *
 * RED against the scaffold seam in `src/lower.ts`: `SwitchStatement` throws
 * `UnsupportedError` until `lowerSwitch` lands. SW6 is a green control.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { UnsupportedError, emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

const MATCH_NUM = `function matchNum(x: number): string {
  switch (x) {
    case 1: return "one";
    case 2: return "two";
    default: return "other";
  }
}`;

describe("control flow: switch → match", () => {
  test("SW1 the switch lowers to a `match` over the discriminant", () => {
    expect(compile(MATCH_NUM)).toContain("match x {");
  });

  test("SW2 an integer `case` becomes a literal-pattern arm (series 019)", () => {
    // An integer discriminant promotes to `i64` with bare literal patterns,
    // superseding the guarded-wildcard form (`_ if x == 1.0`).
    const rust = compile(MATCH_NUM);
    expect(rust).toContain("1 => {");
    expect(rust).toContain("2 => {");
    expect(rust).not.toContain("_ if x ==");
  });

  test("SW3 `default` becomes the wildcard arm", () => {
    const rust = compile(MATCH_NUM);
    expect(rust).toContain("_ => {");
    expect(rust).toContain(`return "other".to_string();`);
  });

  test("SW4 a switch with no default gets a synthetic exhaustive catch-all", () => {
    const rust = compile(
      `function f(x: number): void { switch (x) { case 1: break; } }`,
    );
    // Synthetic `_ => {}` arm present; the case-terminating `break` is stripped.
    expect(rust).toContain("_ => {");
    expect(rust).not.toContain("break;");
  });

  test("SW5 a non-terminating, non-final case is rejected (no fall-through)", () => {
    expect(() =>
      compile(
        `function f(x: number): void { switch (x) { case 1: console.log(1); case 2: break; } }`,
      ),
    ).toThrow(UnsupportedError);
  });

  test("SW6 (green control) an if/else program still emits", () => {
    const rust = compile(
      `function f(x: number): void { if (x > 0) { console.log(x); } }`,
    );
    expect(rust).toContain("if x > 0.0 {");
  });
});
