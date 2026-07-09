/**
 * Specs for series 054b — top-level `const` `async` arrows (AM9–AM13). A
 * `const f = async (…) => …` normalizes (before analysis) into an `async fn`,
 * flowing through the async free-fn path (awaitable via `.await`). The `=> expr`
 * body desugars to `{ return <expr>; }`. A `let`-bound / value-position async
 * arrow stays fail-loud (the arrow deferral boundary). IDs map to
 * docs/work/054-async-methods-arrows/specs.md.
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

describe("054b top-level const async arrows", () => {
  test("AM9 a top-level async arrow emits a free async fn", () => {
    const rust = compile(
      `const f = async (id: number): Promise<string> => { return "row"; };\nconst x: string = await f(3);\nconsole.log(x);`,
    );
    expect(rust).toContain("async fn f(id: f64) -> String");
  });

  test("AM10 (differential) a normalized async arrow is awaitable", async () => {
    const src = `const f = async (id: number): Promise<number> => { return id + 100; };\nconst x: number = await f(3);\nconsole.log(x);`;
    await behaves(src, "103");
    expect(compile(src)).toContain("f(3.0).await");
  });

  test("AM11 (differential) an expression-body async arrow desugars + behaves", async () => {
    const src = `const dbl = async (n: number): Promise<number> => n * 2;\nconst x: number = await dbl(4);\nconsole.log(x);`;
    await behaves(src, "8");
    expect(compile(src)).toContain("async fn dbl(n: f64) -> f64");
  });

  test("AM12 a top-level await of an async arrow makes a tokio runtime main", () => {
    const rust = compile(
      `const f = async (): Promise<number> => 1;\nconst x: number = await f();\nconsole.log(x);`,
    );
    expect(rust).toContain("#[tokio::main]");
    expect(rust).toContain("async fn main()");
  });

  test("AM13 (fail-loud) a value-position async arrow stays rejected", () => {
    // An async arrow that is not a top-level `const` binding (here passed as an
    // argument) is not normalized and hits the arrow deferral boundary.
    const src = `function run(cb: () => number): number { return cb(); }\nrun(async () => 1);`;
    expect(() => compile(src)).toThrow();
  });
});
