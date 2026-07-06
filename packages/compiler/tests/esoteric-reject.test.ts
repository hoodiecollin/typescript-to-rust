/**
 * Specs for series 024 — fail loud on esoteric constructs (default-deny
 * validator). Drives the public `emit(...)` entry so the whole pipeline runs.
 *
 * Two rules under test:
 *   - Forbidden *flags* on modeled nodes (generator, `for await`, `using`,
 *     decorators, `abstract`, `declare`) → `DialectError`. These currently slip
 *     through and are silently mistranslated, so EF1–EF9 are RED until the real
 *     `validate` lands.
 *   - Default-deny on an unmodeled node *type* (enum, namespace, parameter
 *     property) → `UnsupportedError` ("not implemented yet").
 *
 * IDs map to docs/work/024-fail-loud-esoteric/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { DialectError, UnsupportedError, emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

describe("024: forbidden flags → DialectError", () => {
  // EF1: sync generators graduated to supported in series 025d — a straight-line
  // finite-yield `function*` → `impl Iterator` (see generators.test.ts). This
  // shape (a non-yield body, no `Generator<T>` annotation) is still fail-loud,
  // but now as an `UnsupportedError` (unimplemented shape), not a `DialectError`
  // (forbidden). Async generators (EF2) remain forbidden.
  test("EF1 sync generator with an unsupported shape is still rejected", () => {
    expect(() => compile(`function* g(): void { console.log("x"); }`)).toThrow(
      UnsupportedError,
    );
  });

  test("EF2 async generator is rejected", () => {
    expect(() =>
      compile(`async function* g(): void { console.log("x"); }`),
    ).toThrow(DialectError);
  });

  test("EF3 `for await` is rejected", () => {
    expect(() =>
      compile(
        `async function f(xs: Array<number>): Promise<void> { for await (const x of xs) { console.log(x); } }`,
      ),
    ).toThrow(DialectError);
  });

  // EF4: sync `using` graduated to supported in series 025 (→ `Drop`); see
  // esoteric.test.ts. Only `await using` (async disposal) remains forbidden.
  test("EF4 sync `using` is now accepted (025 → Drop)", () => {
    expect(() =>
      compile(`function f(): void { using r = acquire(); }`),
    ).not.toThrow(DialectError);
  });

  test("EF5 `await using` declaration is rejected", () => {
    expect(() =>
      compile(
        `async function f(): Promise<void> { await using r = acquire(); }`,
      ),
    ).toThrow(DialectError);
  });

  test("EF6 class decorator is rejected", () => {
    expect(() => compile(`@sealed class C {}`)).toThrow(DialectError);
  });

  test("EF7 method decorator is rejected", () => {
    expect(() => compile(`class C { @log m(): void {} }`)).toThrow(
      DialectError,
    );
  });

  test("EF8 abstract class is rejected", () => {
    expect(() => compile(`abstract class C { m(): void {} }`)).toThrow(
      DialectError,
    );
  });

  test("EF9 ambient `declare` is rejected", () => {
    expect(() => compile(`declare const x: number;`)).toThrow(DialectError);
  });
});

describe("024: default-deny on unmodeled node type → UnsupportedError", () => {
  // EF10/EF12: `enum` and parameter properties graduated to supported in series
  // 025; see esoteric.test.ts for their behavioral specs.
  test("EF10 enum is now accepted (025 → Rust enum)", () => {
    expect(() => compile(`enum E { A, B }`)).not.toThrow();
  });

  test("EF11 namespace is not implemented", () => {
    expect(() => compile(`namespace N {}`)).toThrow(UnsupportedError);
  });

  test("EF12 parameter property is now accepted (025)", () => {
    expect(() =>
      compile(`class C { constructor(public x: number) {} }`),
    ).not.toThrow();
  });
});

describe("024: regression guards", () => {
  test("EF13 a normal function with for…of still compiles", () => {
    expect(() =>
      compile(
        `function sumArray(arr: Array<number>): number {\n  let total: number = 0;\n  for (const val of arr) {\n    total = total + val;\n  }\n  return total;\n}`,
      ),
    ).not.toThrow();
  });

  test("EF14 the two error classes are distinct", () => {
    expect(DialectError.prototype).not.toBeInstanceOf(UnsupportedError);
    expect(UnsupportedError.prototype).not.toBeInstanceOf(DialectError);
  });
});
