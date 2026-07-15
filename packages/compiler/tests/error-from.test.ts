/**
 * Series 049d specs — the `Other` catch-all + `From` glue (ERR17–ERR20). The
 * `From<String>`/`From<&str>` impls let a `String`/`&str` compose into `AppError`
 * (`.into()`, `?` on a `Result<_, String>`). ERR19 is the mixed-throw + opaque
 * Display differential (021/022 compat); ERR20 is the #16 boundary (per-branch
 * returning discriminator stays fail-loud). IDs map to
 * docs/work/049-error-enums-discrimination/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { checkRust } from "../src/harness";
import { compile, defineDifferential } from "./_support/differential";

const CUSTOM = `class NotFoundError extends Error {
  constructor(message: string) { super(message); }
}
function lookup(id: number): number {
  if (id < 0) { throw new NotFoundError("nope"); }
  return id;
}`;

defineDifferential("error-from", [
  {
    name: "ERR19 (differential) a mixed custom + plain throw + opaque-Displayed catch runs end-to-end",
    // NB: `throw "lit"` (not `throw new Error(...)`) for the plain path — Bun's
    // `console.log(errObj)` renders a stack trace, so it can't be a clean
    // differential; a thrown string prints bare, exactly as our AppError::Other
    // Display does (thiserror #[error("{message}")] == 021/022 Display). The
    // point stands: the custom `throw` (a variant), the plain `throw` (the Other
    // catch-all), and the opaque-Displayed catch all compose.
    src: `class NotFoundError extends Error {
  constructor(message: string) { super(message); }
}
function lookup(id: number): number {
  if (id < 0) { throw new NotFoundError("missing item"); }
  if (id === 0) { throw "zero not allowed"; }
  return id * 2;
}
function run(id: number): void {
  try {
    const r: number = lookup(id);
    console.log(r);
  } catch (e) {
    console.log(e);
  }
}
run(0);`,
    expected: "zero not allowed",
  },
]);

describe("049d: catch-all + From glue", () => {
  test("ERR17 an AppError program emits From<String> and From<&str> → Other", () => {
    const rust = compile(CUSTOM);
    expect(rust).toContain("impl From<String> for AppError {");
    expect(rust).toContain("impl From<&str> for AppError {");
    expect(rust).toContain("AppError::Other { message }");
  });

  test("ERR18 the From impls type-check (a String flows to Other via .into())", async () => {
    const r = await checkRust(compile(CUSTOM));
    expect(r.ok).toBe(true);
  });

  test("ERR20 (series 063) a per-branch-returning discriminator lowers to a labeled block", () => {
    // The #16 boundary was graduated by series 063: an escaping/value-yielding
    // `try`/`catch` (per-branch `return`) → a labeled block, and a discriminating
    // `instanceof` ladder still lowers to a native `match` over the owned error.
    const src = `class NotFoundError extends Error {
  constructor(message: string) { super(message); }
}
class ValidationError extends Error {
  constructor(message: string) { super(message); }
}
function lookup(id: number): number {
  if (id < 0) { throw new NotFoundError("a"); }
  if (id === 0) { throw new ValidationError("b"); }
  return id;
}
function pick(id: number): number {
  try {
    return lookup(id);
  } catch (e) {
    if (e instanceof NotFoundError) { return 1; }
    else { return 2; }
  }
}`;
    const rust = compile(src);
    expect(rust).toContain("'try_0: {");
    expect(rust).toContain("AppError::NotFoundError");
  });
});
