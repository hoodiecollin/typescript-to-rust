/**
 * Specs for generalized `throw` values (series 017): the built-in Error
 * subclasses and a bare string literal, each → `return Err(<String>);`. Drives
 * the public `emit(...)` entry and asserts the emitted shape plus the still
 * fail-loud deferrals. The cargo-backed BEHAVES proof lives in compiler.test.ts.
 * IDs map to series 017.
 *
 * RED against the existing non-`Error` rejection in `lowerThrow` (only
 * `throw new Error(msg)` is accepted today) until it widens to the subclass set
 * and string literals.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

const guard = (thrown: string) =>
  `function f(n: number): number { if (n < 0) { ${thrown} } return n; }`;

describe("throw values: built-in Error subclasses + string literals", () => {
  test("THROWV1 throw new TypeError(msg) → Err(msg) in a Result fn", () => {
    const rust = compile(guard(`throw new TypeError("bad");`));
    expect(rust).toContain("-> Result<f64, String>");
    expect(rust).toContain('return Err("bad".to_string());');
  });

  test("THROWV2 throw new RangeError(msg) → Err(msg)", () => {
    expect(compile(guard(`throw new RangeError("oor");`))).toContain(
      'return Err("oor".to_string());',
    );
  });

  test("THROWV3 throw \"boom\" (string literal) → Err(\"boom\".to_string())", () => {
    expect(compile(guard(`throw "boom";`))).toContain(
      'return Err("boom".to_string());',
    );
  });

  test("THROWV4 (green control) plain throw new Error(msg) is unchanged", () => {
    expect(compile(guard(`throw new Error("x");`))).toContain(
      'return Err("x".to_string());',
    );
  });

  test("THROWV5 (fail-loud) a non-built-in error class is rejected", () => {
    expect(() => compile(guard(`throw new Foo("x");`))).toThrow();
  });

  test("THROWV6 (fail-loud) a bare variable throw is rejected", () => {
    expect(() =>
      compile(`function f(s: string): void { throw s; }`),
    ).toThrow();
  });

  test("THROWV7 (fail-loud) a two-argument Error (a cause) is rejected", () => {
    expect(() => compile(guard(`throw new Error("x", {});`))).toThrow();
  });
});
