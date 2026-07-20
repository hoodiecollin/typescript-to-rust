/**
 * Specs for C-style `for` (series 007). Drives the public `emit(...)` entry and
 * asserts the *desugared* structure: a scope-containing block wrapping the loop
 * variable and a `while` whose body ends with the loop's `update`. The
 * cargo-backed COMPILES/BEHAVES proof lives in compiler.test.ts. IDs map to
 * docs/work/007-for-loops/specs.md.
 *
 * RED against the scaffold seam in `src/lower.ts`: `ForStatement` throws
 * `UnsupportedError` "for-loop lowering pending" until `lowerFor` lands. FOR6 is
 * a green control (an if/while program, no `for`) proving the seam and the new
 * `block` node don't regress series-006 lowering.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

// A *doubling* counter (`i = i * 2`): a non-linear update, so it is never lifted
// to a `for i in a..b` range (series 020/103b-2 promote only `+`/`-` unit-ish
// steps). It keeps exercising the raw C-style-`for` → `block { let; while }`
// desugar these specs pin. Series 103b-1 still retypes the pure-integer counter to
// `i64` (`while i < 100`, `i = i * 2`), not the former `f64` (`i < 100.0`).
const SUM = `function sum(): number {
  let total: number = 0;
  for (let i: number = 1; i < 100; i = i * 2) { total = total + i; }
  return total;
}`;

describe("control flow: C-style for", () => {
  test("FOR1 the loop variable is hoisted as `let mut i`", () => {
    expect(compile(SUM)).toContain("let mut i: i64 = 1;");
  });

  test("FOR2 the test becomes the `while` condition", () => {
    expect(compile(SUM)).toContain("while i < 100 {");
  });

  test("FOR3 the update is the loop body's last statement", () => {
    // `total = total + i;` then `i = i * 2;`, in that order, inside the loop.
    expect(compile(SUM)).toMatch(/total = total \+ i;\n {12}i = i \* 2;/);
  });

  test("FOR4 the loop variable's scope is contained by a block", () => {
    const rust = compile(SUM);
    // `total` sits at function-body indent (4); the hoisted `i` is one level
    // deeper (8), i.e. inside the wrapping block — not at function top level.
    expect(rust).toMatch(/\n {4}let mut total: i64 = 0;/);
    expect(rust).toMatch(/\n {8}let mut i: i64 = 1;/);
  });

  test("FOR5 an empty-body `for` still emits a well-formed loop", () => {
    const rust = compile(
      `function f(): void { for (let i: number = 1; i < 3; i = i * 2) {} }`,
    );
    expect(rust).toContain("let mut i: i64 = 1;");
    expect(rust).toContain("while i < 3 {");
    expect(rust).toContain("i = i * 2;");
  });

  test("FOR6 (green control) an if/while program still emits", () => {
    const rust = compile(
      `function f(): void { let i: number = 0; while (i < 10) { i = i + 1; } }`,
    );
    expect(rust).toContain("while i < 10 {");
  });
});
