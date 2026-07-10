/**
 * Specs for a top-level `const f = (…) => …` arrow → a free `fn` (series 015).
 * Drives the public `emit(...)` entry and asserts the emitted shape: the `fn`
 * keyword and signature, the expression-body `return` desugar, call-site
 * participation, a non-arrow green control, and the fail-loud rejections. The
 * cargo-backed COMPILES/BEHAVES proof lives in compiler.test.ts. IDs map to
 * docs/work/015-arrow-functions/specs.md.
 *
 * RED against the scaffold seam in `src/lower.ts`: a qualifying top-level `const`
 * arrow throws `UnsupportedError` "arrow normalization pending" until the
 * synthetic `FunctionDeclaration` rewrite lands. ARROW4 is a green control (no
 * arrow) proving normalization doesn't touch a `function` declaration.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

const SUB = `const sub = (a: number, b: number): number => {
  return a - b;
};`;

describe("arrow: top-level const arrow → free fn", () => {
  test("ARROW1 a block-body arrow emits a free fn (not a closure)", () => {
    const rust = compile(SUB);
    expect(rust).toContain("fn sub(a: f64, b: f64) -> f64 {");
    expect(rust).toContain("return a - b;");
    expect(rust).not.toContain("let sub");
    expect(rust).not.toContain("|a");
  });

  test("ARROW2 an expression-body arrow desugars to { return <expr>; }", () => {
    const rust = compile(
      `const add = (a: number, b: number): number => a + b;`,
    );
    expect(rust).toContain("fn add(a: f64, b: f64) -> f64 {");
    expect(rust).toContain("return a + b;");
  });

  test("ARROW3 a normalized arrow is a module item, callable from the script", () => {
    const rust = compile(
      `const inc = (n: number): number => { return n + 1; };\n` +
        `const r: number = inc(4);\nconsole.log(r);`,
    );
    expect(rust).toContain("fn inc(n: f64) -> f64 {");
    expect(rust).toContain("inc(4");
    expect(rust).toContain("println!");
  });

  test("ARROW4 (green control) a function declaration is untouched", () => {
    const rust = compile(`function id(n: number): number { return n; }`);
    expect(rust).toContain("fn id(n: f64) -> f64 {");
    expect(rust).not.toContain("|n");
  });

  test("ARROW5 a top-level const async arrow normalizes to a free async fn (series 054b)", () => {
    // Series 054b graduated this: an `async` top-level const arrow carries `async`
    // through `arrowToFunctionDecl` and lowers as a free `async fn` (awaitable via
    // `.await`).
    const rust = compile(`const ping = async (): Promise<void> => { };`);
    expect(rust).toContain("async fn ping() {");
  });

  test("ARROW6 a let-bound arrow promotes to a free fn (graduated, series 058)", () => {
    // Series 058 graduated this: a top-level non-reassigned `let` arrow promotes to
    // a direct free `fn` (same as a `const` arrow).
    const rust = compile(`let f = (n: number): number => { return n; };`);
    expect(rust).toContain("fn f(n: f64) -> f64");
  });

  test("ARROW7 a nested/local arrow hoists to `__arrow_n` + a fn-pointer (graduated, series 058)", () => {
    // Series 058 graduated this: the local arrow hoists to a top-level `fn
    // __arrow_n` and the binding holds a `fn`-pointer.
    const rust = compile(
      `const g = (n: number): number => { ` +
        `const h = (m: number): number => { return m; }; return h(n); };`,
    );
    expect(rust).toContain("fn __arrow_0(m: f64) -> f64");
    expect(rust).toContain("let h: fn(f64) -> f64 = __arrow_0");
  });
});
