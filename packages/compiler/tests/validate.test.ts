/**
 * Specs for dialect validation (series 005). Drives the public `emit(...)` entry
 * — so the whole pipeline is exercised — and asserts that `any`/`unknown` are
 * rejected with `DialectError` (forbidden input), distinct from `UnsupportedError`
 * (not-yet-implemented). IDs map to series 005.
 *
 * These are RED against the no-op mock in `src/validate.ts`: `any`/`unknown`
 * currently throw `UnsupportedError` from lowering's type `default`, not
 * `DialectError`. They go GREEN when the real `validate` lands.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { DialectError, UnsupportedError, emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

describe("dialect validation: reject any/unknown", () => {
  test("V1 `any` on a variable is rejected", () => {
    expect(() => compile(`const x: any = 1;`)).toThrow(DialectError);
  });

  test("V2 `any` on a parameter is rejected", () => {
    expect(() => compile(`function f(x: any): void {}`)).toThrow(DialectError);
  });

  test("V3 `any` in return position is rejected", () => {
    expect(() => compile(`function f(): any { return 1; }`)).toThrow(
      DialectError,
    );
  });

  test("V4 `unknown` is rejected the same way", () => {
    expect(() => compile(`const x: unknown = 1;`)).toThrow(DialectError);
  });

  test("V5 `any` nested in a type argument is rejected", () => {
    expect(() => compile(`const xs: Array<any> = [];`)).toThrow(DialectError);
  });

  test("V6 a fully-annotated valid program is not rejected", () => {
    expect(() =>
      compile(`const n: number = 5;\nconsole.log(n);`),
    ).not.toThrow();
    // The two gates are distinct classes.
    expect(DialectError.prototype).not.toBeInstanceOf(UnsupportedError);
  });
});
