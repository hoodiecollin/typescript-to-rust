/**
 * Specs for records → `HashMap` (series 010). Drives the public `emit(...)` entry
 * and asserts the emitted shape: a `HashMap<String, V>` type, a
 * `HashMap::from([…])` construction, a bare-`&str` keyed lookup, and the std
 * import. The cargo-backed COMPILES/BEHAVES proof lives in compiler.test.ts. IDs
 * map to docs/work/010-records-hashmap/specs.md.
 *
 * RED against the scaffold seam in `src/lower.ts`: a `Record` type throws
 * `UnsupportedError` "Record → HashMap lowering pending" until `lowerType`/
 * `lowerHashMapLiteral` land. REC5 is a green control (no record) proving the
 * seam and the new `hashmap` node don't regress existing lowering nor leak the
 * prelude.
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

describe("data structures: records → HashMap", () => {
  test("REC1 the record type lowers to `HashMap<String, f64>`", () => {
    expect(compile(RECORD)).toContain("let map: HashMap<String, f64> =");
  });

  test("REC2 the object literal lowers to a `HashMap::from` construction", () => {
    expect(compile(RECORD)).toContain(
      `HashMap::from([("a".to_string(), 1.0), ("b".to_string(), 2.0)])`,
    );
  });

  test("REC3 a string-literal lookup is a bare `&str` index", () => {
    const rust = compile(RECORD);
    expect(rust).toContain(`let val: f64 = map["a"];`);
    expect(rust).not.toContain(`map["a".to_string()]`);
  });

  test("REC4 a module using a HashMap gets the std import prepended", () => {
    expect(compile(RECORD)).toStartWith("use std::collections::HashMap;");
  });

  test("REC5 (green control) a non-record program emits unchanged, no import", () => {
    const rust = compile(`const n: number = 1;`);
    expect(rust).toContain("let n: f64 = 1.0;");
    expect(rust).not.toContain("HashMap");
  });
});
