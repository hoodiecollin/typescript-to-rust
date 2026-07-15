/**
 * Series 049c specs — `instanceof` catch ladder → native `match` over the owned
 * bound error (ERR12–ERR16). ERR14 is the headline differential: one `try` throws
 * either variant by input, and the catch prints a distinct string per variant;
 * Rust stdout == Bun on *both* branches. IDs map to
 * docs/work/049-error-enums-discrimination/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

const TWO_CLASSES = `class NotFoundError extends Error {
  constructor(message: string) { super(message); }
}
class ValidationError extends Error {
  field: string;
  constructor(message: string, field: string) { super(message); this.field = field; }
}
function lookup(id: number): number {
  if (id < 0) { throw new NotFoundError("missing"); }
  if (id === 0) { throw new ValidationError("bad", "id"); }
  return id;
}
function run(id: number): void {
  try {
    lookup(id);
  } catch (e) {
    if (e instanceof NotFoundError) {
      console.log("not-found");
    } else if (e instanceof ValidationError) {
      console.log(e.field);
    } else {
      console.log("other");
    }
  }
}`;

defineDifferential("error-discriminate", [
  {
    name: "ERR14 (differential) discriminates the correct variant per branch — Rust stdout == Bun (variant 1)",
    src: `${TWO_CLASSES}\nrun(-1);`,
    expected: "not-found",
  },
  {
    name: "ERR14 (differential) discriminates the correct variant per branch — Rust stdout == Bun (variant 2)",
    src: `${TWO_CLASSES}\nrun(0);`,
    expected: "id",
  },
  {
    name: "ERR15 a ladder with no trailing else appends a `_ => {}` and compiles (JS swallow parity)",
    src: `class NotFoundError extends Error {
  constructor(message: string) { super(message); }
}
function lookup(id: number): number {
  if (id < 0) { throw new Error("plain"); }
  return id;
}
function run(id: number): void {
  try {
    lookup(id);
  } catch (e) {
    if (e instanceof NotFoundError) {
      console.log("nf");
    }
  }
  console.log("after");
}
run(-1);`,
    // A plain Error (Other) is swallowed by the ladder; execution continues.
    expected: "after",
    extra: ({ rust }) => {
      expect(rust).toContain("_ => {");
    },
  },
]);

describe("049c: instanceof → match", () => {
  test("ERR12 an instanceof ladder → a match with a variant arm each + wildcard, no downcast_ref", () => {
    const rust = compile(TWO_CLASSES);
    expect(rust).toContain("match e {");
    expect(rust).toContain("AppError::NotFoundError { .. } =>");
    expect(rust).toContain("other =>");
    expect(rust).not.toContain("downcast_ref");
  });

  test("ERR13 an arm reading e.field binds it owned (Foo { field, .. } => … field …)", () => {
    const rust = compile(TWO_CLASSES);
    expect(rust).toContain("AppError::ValidationError { field, .. } =>");
    expect(rust).toContain('println!("{}", field)');
  });

  test("ERR16 a non-instanceof catch (e.message === …) keeps the opaque bind — no match", () => {
    const src = `class NotFoundError extends Error {
  constructor(message: string) { super(message); }
}
function lookup(id: number): number {
  if (id < 0) { throw new NotFoundError("x"); }
  return id;
}
function run(id: number): void {
  try {
    lookup(id);
  } catch (e) {
    console.log(e);
  }
}
run(1);`;
    const rust = compile(src);
    expect(rust).toContain("if let Err(e) =");
    expect(rust).not.toContain("match e {");
  });
});
