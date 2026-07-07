/**
 * Specs for records → `IndexMap` (series 010, retargeted to `IndexMap` in 041).
 * Drives the public `emit(...)` entry and asserts the emitted shape: an
 * `IndexMap<String, V>` type, an `IndexMap::from([…])` construction, a
 * bare-`&str` keyed lookup, and the `indexmap` import. The backing type is
 * `IndexMap` (not `HashMap`) so key/value iteration matches JS insertion order
 * (series 041). The cargo-backed COMPILES/BEHAVES proof lives in compiler.test.ts.
 *
 * REC5 is a green control (no record) proving the map node doesn't regress
 * existing lowering nor leak the prelude.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

const RECORD = `const map: Record<string, number> = { "a": 1, "b": 2 };
let val: number = map["a"];`;

describe("data structures: records → IndexMap", () => {
  test("REC1 the record type lowers to `IndexMap<String, f64>`", () => {
    expect(compile(RECORD)).toContain("let map: IndexMap<String, f64> =");
  });

  test("REC2 the object literal lowers to an `IndexMap::from` construction", () => {
    expect(compile(RECORD)).toContain(
      `IndexMap::from([("a".to_string(), 1.0), ("b".to_string(), 2.0)])`,
    );
  });

  test("REC3 a string-literal lookup is a bare `&str` index", () => {
    const rust = compile(RECORD);
    expect(rust).toContain(`let val: f64 = map["a"];`);
    expect(rust).not.toContain(`map["a".to_string()]`);
  });

  test("REC4 a module using a record gets the `indexmap` import prepended", () => {
    expect(compile(RECORD)).toStartWith("use indexmap::IndexMap;");
  });

  test("REC5 (green control) a non-record program emits unchanged, no import", () => {
    const rust = compile(`const n: number = 1;`);
    expect(rust).toContain("let n: f64 = 1.0;");
    expect(rust).not.toContain("IndexMap");
  });
});
