/**
 * Specs for `throw` → `Result<T, E>` + `?` (series 013). Drives the public
 * `emit(...)` entry and asserts the emitted shape: the return-type wrap, `throw`
 * → `return Err(...)`, a normal `return` wrapped in `Ok`, `?` propagation with
 * `main` returning `Result`, and a non-throwing green control. The cargo-backed
 * COMPILES/BEHAVES proof lives in compiler.test.ts. IDs map to
 * series 013.
 *
 * RED against the scaffold seam in `src/lower.ts`: a `ThrowStatement` throws
 * `UnsupportedError` "throw → Result lowering pending" until `lowerThrow`,
 * `analysis.fallible`, `makeFallible`, and the `?`-wrap land. ERR5 is a green
 * control (no throw) proving the seam, the `result`/`ok`/`try`/`throw` nodes, and
 * `mainRet` don't regress existing lowering.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

const HALF = `function half(n: number): number {
  if (n < 0) {
    throw new Error("negative");
  }
  return n / 2;
}`;

describe("errors: throw → Result + ?", () => {
  test("ERR1 a throwing function's return type wraps in Result", () => {
    expect(compile(HALF)).toContain("fn half(n: f64) -> Result<f64, String> {");
  });

  test("ERR2 throw new Error(msg) lowers to return Err(msg)", () => {
    expect(compile(HALF)).toContain('return Err("negative".to_string());');
  });

  test("ERR3 a normal return inside a fallible function wraps in Ok", () => {
    expect(compile(HALF)).toContain("return Ok(n / 2.0);");
  });

  test("ERR4 a fallible call propagates with `?` and main returns Result", () => {
    const rust = compile(`${HALF}\nconst x: number = half(10);\nconsole.log(x);`);
    expect(rust).toContain("half(10.0)?");
    expect(rust).toContain("fn main() -> Result<(), String> {");
    expect(rust).toContain("return Ok(());");
  });

  test("ERR5 (green control) a non-throwing program emits unchanged", () => {
    const rust = compile(`function id(n: number): number { return n; }`);
    expect(rust).toContain("fn id(n: f64) -> f64 {");
    expect(rust).not.toContain("Result");
    expect(rust).not.toContain("?");
  });
});
