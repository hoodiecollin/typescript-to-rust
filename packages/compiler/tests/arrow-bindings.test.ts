/**
 * Specs for series 058 — arrow binding deferrals.
 *
 * A `let`/`var`/local-`const` arrow lifts to a free `fn` (top-level, non-reassigned)
 * or a hoisted `fn __arrow_n` + `fn`-pointer binding (nested / reassigned). Multiple
 * declarators split per binding; a `({x, y}: Point)` destructuring param becomes a
 * Rust struct-pattern param. Rest params, capturing arrows, and anonymous-object
 * destructured params stay fail-loud.
 *
 * Differential: emitted Rust compiles AND matches the TS run, plus emitted-text and
 * fail-loud checks.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { runRust } from "../src/harness";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

function runTs(src: string): string {
  const proc = Bun.spawnSync(["bun", "run", "-"], {
    stdin: new TextEncoder().encode(src),
  });
  return new TextDecoder().decode(proc.stdout).trim();
}

async function behaves(src: string, expected: string): Promise<void> {
  const rust = compile(src);
  const rr = await runRust(rust);
  expect(rr.ok).toBe(true);
  expect(rr.stdout.trim()).toBe(runTs(src));
  expect(rr.stdout.trim()).toBe(expected);
}

describe("058 arrow binding deferrals", () => {
  test("`let`-bound arrow → direct free fn", async () => {
    const src = `let f = (n: number): number => n + 1;\nconsole.log(f(2));`;
    await behaves(src, "3");
    expect(compile(src)).toContain("fn f(n: f64) -> f64");
  });

  test("reassigned fn-value binding → `let mut` fn-pointer", async () => {
    const src = `function add(a: number, b: number): number { return a + b; }
function sub(a: number, b: number): number { return a - b; }
let op = add;
op = sub;
console.log(op(5, 2));`;
    await behaves(src, "3");
    expect(compile(src)).toContain("let mut op: fn(f64, f64) -> f64 = add");
  });

  test("multiple declarators split per binding", async () => {
    const src = `const f = (x: number): number => x + 1, g = (x: number): number => x * 2;
console.log(f(3));
console.log(g(3));`;
    await behaves(src, "4\n6");
  });

  test("destructuring param → struct-pattern param", async () => {
    const src = `interface Point { x: number; y: number; }
const dist = ({ x, y }: Point): number => x * x + y * y;
const p: Point = { x: 3, y: 4 };
console.log(dist(p));`;
    await behaves(src, "25");
    expect(compile(src)).toContain("fn dist(Point { x, y }: Point)");
  });

  test("local (nested-scope) arrow → hoisted `__arrow_n` + fn-pointer binding", async () => {
    const src = `function run(): number {
  const f = (n: number): number => n + 1;
  return f(2);
}
console.log(run());`;
    await behaves(src, "3");
    const rust = compile(src);
    expect(rust).toContain("fn __arrow_0(n: f64) -> f64");
    expect(rust).toContain("let f: fn(f64) -> f64 = __arrow_0");
  });

  test("async top-level `let` arrow → direct `async fn`", async () => {
    const src = `let load = async (): Promise<number> => 1;\nconsole.log(await load());`;
    await behaves(src, "1");
    expect(compile(src)).toContain("async fn load() -> f64");
  });

  test("rest param → UnsupportedError", () => {
    expect(() =>
      compile(`const sum = (...xs: number[]): number => xs.length;\nconsole.log(sum(1, 2, 3));`),
    ).toThrow();
  });

  test("capturing arrow → rejected (cargo cannot resolve the captured name)", async () => {
    // A promoted/hoisted arrow becomes a free fn, which cannot capture — the
    // captured name is out of scope, so cargo rejects (unchanged from 048).
    const src = `const base = 10;
const addBase = (n: number): number => n + base;
console.log(addBase(5));`;
    let rejected = false;
    try {
      const rr = await runRust(compile(src));
      rejected = !rr.ok;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  test("anonymous-object destructured param → fail-loud", () => {
    expect(() =>
      compile(`const f = ({ x, y }: { x: number; y: number }): number => x + y;\nconst p = { x: 1, y: 2 };\nconsole.log(f(p));`),
    ).toThrow();
  });

  test("regression: top-level `const` arrow still promotes to a direct fn", async () => {
    const src = `const inc = (n: number): number => n + 1;\nconsole.log(inc(4));`;
    await behaves(src, "5");
    expect(compile(src)).toContain("fn inc(n: f64) -> f64");
  });
});
