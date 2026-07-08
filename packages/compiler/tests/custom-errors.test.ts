/**
 * Specs for custom error types → the whole-program `AppError` enum (series 049,
 * superseding series 022's `Box<dyn Error>`). Drives the public `emit(...)` entry
 * and asserts the emitted shape: the `#[derive(thiserror::Error, Debug)]` enum
 * with a variant per custom class + the `Other` catch-all, the `AppError` program
 * error type, an `AppError::Foo` custom `throw`, an `AppError::Other` plain
 * `throw`, and — critically — that a program with no custom error class stays
 * `E = String`. The cargo proof lives in error-enum.test.ts / compiler.test.ts.
 *
 * CE6 is a green control (no custom error → unchanged String behaviour).
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

const CUSTOM = `class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
  }
}
function lookup(id: number): number {
  if (id < 0) {
    throw new NotFoundError("no such id");
  }
  if (id === 0) {
    throw new Error("zero reserved");
  }
  return id * 2;
}`;

describe("errors: custom error types → AppError enum", () => {
  test("CE1 a custom error class lowers to an AppError enum variant (thiserror, no hand-impls)", () => {
    const rust = compile(CUSTOM);
    expect(rust).toContain("#[derive(thiserror::Error, Debug)]");
    expect(rust).toContain("enum AppError {");
    expect(rust).toContain("NotFoundError { message: String },");
    expect(rust).toContain("Other { message: String },");
    // thiserror derives Display/Error — no hand-written impls.
    expect(rust).not.toContain("impl std::fmt::Display");
    expect(rust).not.toContain("impl std::error::Error");
  });

  test("CE2 each variant carries a #[error(\"{message}\")] Display attribute", () => {
    const rust = compile(CUSTOM);
    expect(rust).toContain('#[error("{message}")]');
  });

  test("CE3 with a custom error present, a fallible fn's error type is AppError", () => {
    expect(compile(CUSTOM)).toContain("fn lookup(id: f64) -> Result<f64, AppError> {");
    expect(compile(CUSTOM)).not.toContain("Box<dyn");
  });

  test("CE4 a custom throw constructs the enum variant directly (no Box)", () => {
    expect(compile(CUSTOM)).toContain(
      'return Err(AppError::NotFoundError { message: "no such id".to_string() });',
    );
  });

  test("CE5 a plain throw in the same program constructs the Other variant", () => {
    expect(compile(CUSTOM)).toContain(
      'return Err(AppError::Other { message: "zero reserved".to_string() });',
    );
  });

  test("CE6 (compat control) no custom error class keeps E = String", () => {
    const rust = compile(
      `function half(n: number): number { if (n < 0) { throw new Error("neg"); } return n / 2; }`,
    );
    expect(rust).toContain("Result<f64, String>");
    expect(rust).not.toContain("AppError");
    expect(rust).not.toContain("Box<dyn");
    expect(rust).not.toContain("thiserror");
  });
});

describe("errors: custom error types — deferred (fail-loud)", () => {
  test("CEX1 an error class with a method is rejected", () => {
    const src = `class E extends Error {
  code(): number { return 1; }
  constructor(message: string) {
    super(message);
  }
}`;
    expect(() => compile(src)).toThrow();
  });
});
