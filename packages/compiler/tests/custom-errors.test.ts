/**
 * Specs for custom error types → `Box<dyn Error>` (series 022). Drives the
 * public `emit(...)` entry and asserts the emitted shape: the error `struct` +
 * `Display`/`Debug`/`Error` impls, the `Box<dyn Error>` program error type, a
 * boxed custom `throw`, a boxed plain `throw` via `.into()`, and — critically —
 * that a program with no custom error class stays `E = String`. The cargo proof
 * lives in compiler.test.ts. IDs map to docs/work/022-custom-error-types/specs.md.
 *
 * RED until `lowerErrorClass` + the program-error-type threading land (a
 * `class … extends Error` currently hits the generic inheritance rejection).
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

describe("errors: custom error types → Box<dyn Error>", () => {
  test("CE1 a custom error class lowers to a struct implementing Error", () => {
    const rust = compile(CUSTOM);
    expect(rust).toContain("struct NotFoundError {");
    expect(rust).toContain("impl std::error::Error for NotFoundError {}");
  });

  test("CE2 it gets an associated `new` and a Display impl writing the message", () => {
    const rust = compile(CUSTOM);
    expect(rust).toContain("fn new(message: String) -> NotFoundError {");
    expect(rust).toContain("impl std::fmt::Display for NotFoundError");
    expect(rust).toContain('write!(f, "{}", self.message)');
  });

  test("CE3 with a custom error present, a fallible fn's error type is Box<dyn Error>", () => {
    expect(compile(CUSTOM)).toContain(
      "fn lookup(id: f64) -> Result<f64, Box<dyn std::error::Error>> {",
    );
  });

  test("CE4 a custom throw boxes the constructed error", () => {
    expect(compile(CUSTOM)).toContain(
      'return Err(Box::new(NotFoundError::new("no such id".to_string())));',
    );
  });

  test("CE5 a plain throw in the same (boxed) program converts via `.into()`", () => {
    expect(compile(CUSTOM)).toContain(
      'return Err("zero reserved".to_string().into());',
    );
  });

  test("CE6 (compat control) no custom error class keeps E = String", () => {
    const rust = compile(
      `function half(n: number): number { if (n < 0) { throw new Error("neg"); } return n / 2; }`,
    );
    expect(rust).toContain("Result<f64, String>");
    expect(rust).not.toContain("Box<dyn");
    expect(rust).not.toContain(".into()");
  });
});

describe("errors: custom error types — deferred (fail-loud)", () => {
  test("CEX1 an error class with extra members is rejected", () => {
    const src = `class E extends Error {
  code: number;
  constructor(message: string) {
    super(message);
  }
}`;
    expect(() => compile(src)).toThrow();
  });
});
