/**
 * Specs for series 024 — fail loud on esoteric constructs (default-deny
 * validator). Drives the public `emit(...)` entry so the whole pipeline runs.
 *
 * Two rules under test:
 *   - Flagged rejections on modeled nodes. Since #80's wall re-examination these
 *     split by kind: decorators + `declare` are **permanent** (`DialectError`);
 *     async generators, `for await`, `await using`, and `abstract` classes are
 *     in-dialect-but-unbuilt **deferrals** (`UnsupportedError`). Sync `using` is
 *     supported (025 → `Drop`).
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

describe("024: flagged rejections — permanent (DialectError) vs deferral (UnsupportedError)", () => {
  // #80 re-examined the flag-based walls: decorators + `declare` stay permanent
  // (DialectError); async generators, `for await`, `await using`, and `abstract`
  // classes are in-dialect-but-unbuilt and reclassified to deferrals
  // (UnsupportedError). See docs/dialect.md and #80.
  //
  // EF1: sync generators graduated to supported in series 025d — a straight-line
  // finite-yield `function*` → `impl Iterator` (see generators.test.ts). This
  // shape (a non-yield body, no `Generator<T>` annotation) is fail-loud as an
  // `UnsupportedError` (unimplemented shape).
  test("EF1 sync generator with an unsupported shape is still rejected", () => {
    expect(() => compile(`function* g(): void { console.log("x"); }`)).toThrow(
      UnsupportedError,
    );
  });

  test("EF2 async generator → deferral (needs Stream, out of std)", () => {
    expect(() =>
      compile(`async function* g(): void { console.log("x"); }`),
    ).toThrow(UnsupportedError);
  });

  test("EF3 `for await` → deferral (needs async-iteration lowering)", () => {
    expect(() =>
      compile(
        `async function f(xs: Array<number>): Promise<void> { for await (const x of xs) { console.log(x); } }`,
      ),
    ).toThrow(UnsupportedError);
  });

  // EF4: sync `using` graduated to supported in series 025 (→ `Drop`); see
  // esoteric.test.ts. `await using` (async disposal) is a deferral (opt-in
  // experimental, #84), not accepted by default.
  test("EF4 sync `using` is now accepted (025 → Drop)", () => {
    expect(() =>
      compile(`function f(): void { using r = acquire(); }`),
    ).not.toThrow(DialectError);
  });

  test("EF5 `await using` → deferral (opt-in experimental, #84)", () => {
    expect(() =>
      compile(
        `async function f(): Promise<void> { await using r = acquire(); }`,
      ),
    ).toThrow(UnsupportedError);
  });

  test("EF6 class decorator is rejected (permanent)", () => {
    expect(() => compile(`@sealed class C {}`)).toThrow(DialectError);
  });

  test("EF7 method decorator is rejected (permanent)", () => {
    expect(() => compile(`class C { @log m(): void {} }`)).toThrow(
      DialectError,
    );
  });

  test("EF8 abstract class → deferral (trait + impls once built)", () => {
    expect(() => compile(`abstract class C { m(): void {} }`)).toThrow(
      UnsupportedError,
    );
  });

  test("EF9 ambient `declare` is rejected (permanent)", () => {
    expect(() => compile(`declare const x: number;`)).toThrow(DialectError);
  });
});

describe("024: default-deny on unmodeled node type → UnsupportedError", () => {
  // EF10/EF12: `enum` and parameter properties graduated to supported in series
  // 025; EF11 (`namespace`) graduated in series 050d (Axis 4) — see
  // module-namespace.test.ts for its behavioral specs.
  test("EF10 enum is now accepted (025 → Rust enum)", () => {
    expect(() => compile(`enum E { A, B }`)).not.toThrow();
  });

  test("EF11 namespace is now accepted (050d → inline Rust mod)", () => {
    // `namespace N { … }` → an inline `mod N { … }` (Axis 4). An empty namespace
    // is a well-formed empty `mod`.
    expect(() => compile(`namespace N {}`)).not.toThrow();
    expect(compile(`namespace N { export function f(): number { return 1; } }`)).toContain(
      "mod N {",
    );
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
