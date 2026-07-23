/**
 * Series 049b specs — field-carrying error variants (ERR7–ERR11). A custom error
 * class may declare typed data fields (message + `field: T`, one per ctor param,
 * `super(message);` then identity `this.f = f;`); anything richer is fail-loud.
 * ERR9 is the differential headline — a caught field is read and printed, Rust
 * stdout == Bun. IDs map to docs/work/049-error-enums-discrimination/specs.md.
 */

import { expect, test } from "bun:test";
import { UnsupportedError } from "../src/errors";
import { compile, defineDifferential } from "./_support/differential";

const VALIDATION = `class ValidationError extends Error {
  field: string;
  constructor(message: string, field: string) {
    super(message);
    this.field = field;
  }
}
function check(n: number): number {
  if (n < 0) {
    throw new ValidationError("bad", "email");
  }
  return n;
}`;

defineDifferential("error-fields", [
  {
    name: "ERR9 (differential) a caught field is read and printed — Rust stdout == Bun",
    src: `class ValidationError extends Error {
  field: string;
  constructor(message: string, field: string) {
    super(message);
    this.field = field;
  }
}
function check(n: number): number {
  if (n < 0) {
    throw new ValidationError("bad input", "email");
  }
  return n * 2;
}
function run(n: number): void {
  try {
    const r: number = check(n);
    console.log(r);
  } catch (e) {
    if (e instanceof ValidationError) {
      console.log(e.field);
    }
  }
}
run(-1);`,
    expected: "email",
  },
]);

test("ERR7 a declared field → a struct variant carrying it (message first)", () => {
  expect(compile(VALIDATION)).toContain(
    "ValidationError { message: String, field: String },",
  );
});

test("ERR8 a field-carrying throw carries the fields, message first", () => {
  expect(compile(VALIDATION)).toContain(
    'return Err(AppError::ValidationError { message: "bad".to_string(), field: "email".to_string() });',
  );
});

test("ERR10 (fail-loud) an error class with an extra method is rejected", () => {
  const src = `class E extends Error {
  code(): number { return 1; }
  constructor(message: string) { super(message); }
}`;
  expect(() => compile(src)).toThrow(UnsupportedError);
});

test("ERR11 (fail-loud) a computed constructor body (this.f = f.toUpperCase()) is rejected", () => {
  const src = `class E extends Error {
  field: string;
  constructor(message: string, field: string) {
    super(message);
    this.field = field.toUpperCase();
  }
}`;
  expect(() => compile(src)).toThrow(UnsupportedError);
});
