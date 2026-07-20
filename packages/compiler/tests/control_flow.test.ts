/**
 * Specs for control flow (series 006): `if` / `else if` / `else` and `while`.
 * Drives the public `emit(...)` entry (parse → lower → emit) and asserts the
 * *structure* of the emitted Rust. The cargo-backed COMPILES/BEHAVES proof lives
 * in compiler.test.ts; these pin the emitted shape. IDs map to
 * docs/work/006-control-flow/specs.md.
 *
 * RED against the scaffold seam in `src/lower.ts`: `IfStatement`/`WhileStatement`
 * throw `UnsupportedError` "control flow lowering pending" until real lowering
 * lands. CF7 is a green control (no control flow) proving the seam doesn't
 * regress existing lowering.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

describe("control flow: if / else / while", () => {
  test("CF1 a bare `if` lowers and emits", () => {
    const rust = compile(
      `function f(x: number): void { if (x > 0) { console.log(x); } }`,
    );
    expect(rust).toContain("if x > 0.0 {");
    expect(rust).not.toContain("else");
  });

  test("CF2 `if` / `else` emits both arms", () => {
    const rust = compile(
      `function f(x: number): void { if (x > 0) { console.log(1); } else { console.log(2); } }`,
    );
    expect(rust).toContain("if x > 0.0 {");
    expect(rust).toContain("} else {");
  });

  test("CF3 `else if` emits an idiomatic chain, not `else { if }`", () => {
    const rust = compile(
      `function f(x: number): void {
         if (x > 0) { console.log(1); }
         else if (x < 0) { console.log(2); }
         else { console.log(3); }
       }`,
    );
    expect(rust).toContain("} else if ");
    // No nested-block else-if: an `if` must not open immediately inside an
    // `else {` block.
    expect(rust).not.toMatch(/else \{\s*if /);
  });

  test("CF4 a `while` loop lowers and emits", () => {
    const rust = compile(
      `function f(): void { let i: number = 0; while (i < 10) { i = i + 1; } }`,
    );
    // `i` retypes to `i64` (series 103b-1) — a pure-integer counter.
    expect(rust).toContain("while i < 10 {");
  });

  test("CF5 control-flow bodies are real, indented blocks", () => {
    const rust = compile(
      `function f(): void { let i: number = 0; while (i < 10) { i = i + 1; } }`,
    );
    // The body statement nests inside the loop braces, indented one level.
    expect(rust).toMatch(/while i < 10 \{\n {8}i = i \+ 1;\n {4}\}/);
  });

  test("CF6 an if/else-if/else function emits all three return arms", () => {
    const rust = compile(
      `function check(x: number): string {
         if (x > 0) { return "positive"; }
         else if (x < 0) { return "negative"; }
         else { return "zero"; }
       }`,
    );
    expect(rust).toContain(`return "positive".to_string();`);
    expect(rust).toContain(`return "negative".to_string();`);
    expect(rust).toContain(`return "zero".to_string();`);
  });

  test("CF7 (green control) a control-flow-free program still emits", () => {
    const rust = compile(`const n: number = 5;\nconsole.log(n);`);
    expect(rust).toContain("fn main()");
    expect(rust).toContain("let n: f64 = 5.0;");
  });
});
