/**
 * Series 049a specs — the whole-program `AppError` enum + throw construction
 * (ERR1–ERR6). The oracle is a real cargo toolchain: substring assertions pin the
 * cargo-checked *representation*, never a golden `.rs` file. IDs map to
 * docs/work/049-error-enums-discrimination/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { checkRust } from "../src/harness";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

const ONE_CLASS = `class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
  }
}
function lookup(id: number): number {
  if (id < 0) {
    throw new NotFoundError("nope");
  }
  if (id === 0) {
    throw new Error("plain");
  }
  if (id === 1) {
    throw "bare";
  }
  return id * 2;
}`;

describe("049a: AppError enum + throw", () => {
  test("ERR1 one custom class → a thiserror AppError enum with that variant + Other, no hand impls", () => {
    const rust = compile(ONE_CLASS);
    expect(rust).toContain("#[derive(thiserror::Error, Debug)]");
    expect(rust).toContain("enum AppError {");
    expect(rust).toContain("NotFoundError { message: String },");
    expect(rust).toContain("Other { message: String },");
    expect(rust).toContain('#[error("{message}")]');
    expect(rust).not.toContain("impl std::fmt::Display");
    expect(rust).not.toContain("impl std::error::Error");
  });

  test("ERR2 every fallible fn's error type is AppError (not boxError, not String)", () => {
    const rust = compile(ONE_CLASS);
    expect(rust).toContain("fn lookup(id: f64) -> Result<f64, AppError> {");
    expect(rust).not.toContain("Box<dyn");
    expect(rust).not.toContain("Result<f64, String>");
  });

  test("ERR3 a custom throw constructs the named variant", () => {
    expect(compile(ONE_CLASS)).toContain(
      'return Err(AppError::NotFoundError { message: "nope".to_string() });',
    );
  });

  test("ERR4 a plain Error throw and a bare string throw both → AppError::Other", () => {
    const rust = compile(ONE_CLASS);
    expect(rust).toContain(
      'return Err(AppError::Other { message: "plain".to_string() });',
    );
    expect(rust).toContain(
      'return Err(AppError::Other { message: "bare".to_string() });',
    );
  });

  test("ERR5 thiserror::Error is fully-qualified — no `use thiserror` prelude", () => {
    const rust = compile(ONE_CLASS);
    expect(rust).toContain("thiserror::Error");
    expect(rust).not.toContain("use thiserror");
  });

  test("ERR6 (compat guard) no custom error class keeps E = String — no AppError, no enum", () => {
    const rust = compile(
      `function half(n: number): number { if (n < 0) { throw new Error("neg"); } return n / 2; }`,
    );
    expect(rust).toContain("Result<f64, String>");
    expect(rust).not.toContain("AppError");
    expect(rust).not.toContain("enum ");
    expect(rust).not.toContain("thiserror");
  });

  test("ERR1/ERR2 cargo: the emitted enum + fallible signature type-check", async () => {
    const r = await checkRust(compile(ONE_CLASS));
    expect(r.ok).toBe(true);
  });
});
