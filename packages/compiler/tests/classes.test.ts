/**
 * Specs for `class` → `struct` + `impl` (series 012). Drives the public
 * `emit(...)` entry and asserts the emitted shape: a `struct` + `impl`, a `new`
 * constructor building a struct literal, a `&mut self` method, and `this`/`new`
 * translation. The cargo-backed COMPILES/BEHAVES proof lives in compiler.test.ts.
 * IDs map to series 012.
 *
 * RED against the scaffold seam in `src/lower.ts`: a `ClassDeclaration` throws
 * `UnsupportedError` "class → struct/impl lowering pending" until `lowerClass`
 * and friends land. CLS5 is a green control (no class) proving the seam, the
 * `HirClass` node, and the `recv` receiver don't regress existing lowering.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

const COUNTER = `class Counter {
  count: number;
  constructor(start: number) {
    this.count = start;
  }
  increment(): void {
    this.count = this.count + 1;
  }
}`;

describe("data structures: class → struct + impl", () => {
  test("CLS1 the class lowers to a struct and an impl block", () => {
    const rust = compile(COUNTER);
    expect(rust).toContain("struct Counter {");
    expect(rust).toContain("count: f64,");
    expect(rust).toContain("impl Counter {");
  });

  test("CLS2 the constructor lowers to an associated `new` returning a literal", () => {
    const rust = compile(COUNTER);
    expect(rust).toContain("fn new(start: f64) -> Counter {");
    expect(rust).toContain("Counter { count: start }");
  });

  test("CLS3 a mutating method takes `&mut self` and uses `self`", () => {
    const rust = compile(COUNTER);
    expect(rust).toContain("fn increment(&mut self) {");
    expect(rust).toContain("self.count = self.count + 1.0;");
  });

  test("CLS4 `new` translates at a use site", () => {
    expect(compile(`${COUNTER}\nconst c: Counter = new Counter(5);`)).toContain(
      "Counter::new(5.0)",
    );
  });

  test("CLS5 (green control) a non-class program emits unchanged, no self", () => {
    const rust = compile(`function id(n: number): number { return n; }`);
    expect(rust).toContain("fn id(n: f64) -> f64 {");
    expect(rust).not.toContain("self");
  });
});
