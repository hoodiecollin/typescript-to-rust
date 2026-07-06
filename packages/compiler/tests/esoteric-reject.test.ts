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
  test("EF1 sync generator is rejected", () => {
    expect(() => compile(`function* g(): void { console.log("x"); }`)).toThrow(
      DialectError,
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

  test("EF4 `using` declaration is rejected", () => {
    expect(() =>
      compile(`function f(): void { using r = acquire(); }`),
    ).toThrow(DialectError);
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
  test("EF10 enum is not implemented", () => {
    expect(() => compile(`enum E { A, B }`)).toThrow(UnsupportedError);
  });

  test("EF11 namespace is not implemented", () => {
    expect(() => compile(`namespace N {}`)).toThrow(UnsupportedError);
  });

  test("EF12 parameter property is not implemented", () => {
    expect(() =>
      compile(`class C { constructor(public x: number) {} }`),
    ).toThrow(UnsupportedError);
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
