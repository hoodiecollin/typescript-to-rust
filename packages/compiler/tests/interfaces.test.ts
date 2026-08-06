/**
 * Specs for `interface` → `struct` literals (series 011). Drives the public
 * `emit(...)` entry and asserts the emitted shape: a `struct` definition, a named
 * struct literal, the named-type binding, and a field read. The cargo-backed
 * COMPILES/BEHAVES proof lives in compiler.test.ts. IDs map to
 * series 011.
 *
 * RED against the scaffold seam in `src/lower.ts`: a `TSInterfaceDeclaration`
 * throws `UnsupportedError` "interface → struct lowering pending" until
 * `lowerInterface` + the `structs` registry + `lowerStructLiteral` land. INT5 is
 * a green control (no interface) proving the seam and the new `struct`/`structLit`
 * nodes don't regress existing lowering.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

const POINT = `interface Point {
  x: number;
  y: number;
}
const p: Point = { x: 10, y: 20 };`;

describe("data structures: interface → struct", () => {
  test("INT1 the interface lowers to a struct with typed fields", () => {
    const rust = compile(POINT);
    expect(rust).toContain("struct Point {");
    expect(rust).toContain("x: f64,");
    expect(rust).toContain("y: f64,");
  });

  test("INT2 the object literal lowers to a named struct literal", () => {
    expect(compile(POINT)).toContain("Point { x: 10.0, y: 20.0 }");
  });

  test("INT3 the named-type binding resolves to the struct name", () => {
    expect(compile(POINT)).toContain("let p: Point = Point { x: 10.0, y: 20.0 };");
  });

  test("INT4 a field read lowers to Rust field access", () => {
    expect(compile(`${POINT}\nconst gx: number = p.x;`)).toContain(
      "let gx: f64 = p.x;",
    );
  });

  test("INT5 (green control) a non-interface program emits unchanged", () => {
    expect(compile(`function id(n: number): number { return n; }`)).toContain(
      "fn id(n: f64) -> f64 {",
    );
  });
});
