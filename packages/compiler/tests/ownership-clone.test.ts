/**
 * Specs for series 034 — inter-procedural ownership, first increment:
 * use-after-move → `.clone()`. A non-Copy, Clone-able binding (String, Vec) that
 * is *moved* (bound to another `let`, or passed as an owned call/ctor argument)
 * and then **used again** is cloned at the move site, so the original stays live.
 * The textually-last use is left as a bare move (no needless clone).
 *
 * Differential: emitted Rust compiles AND matches the TS run.
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

describe("034 use-after-move → clone", () => {
  test("a String moved into a let, then reused, is cloned", async () => {
    const src = `const a: string = "hello";
const b: string = a;
console.log(a);
console.log(b);`;
    await behaves(src, "hello\nhello");
    expect(compile(src)).toContain("a.clone()");
  });

  test("a Vec moved into a let, then reused, is cloned", async () => {
    await behaves(
      `const xs: Array<number> = [1, 2, 3];
const ys: Array<number> = xs;
console.log(xs.length);
console.log(ys.length);`,
      "3\n3",
    );
  });

  test("the last use is NOT cloned (no needless clone)", () => {
    const src = `const a: string = "x";
const b: string = a;
console.log(b);`;
    const rust = compile(src);
    expect(rust).not.toContain("a.clone()");
    expect(rust).toContain("= a;");
  });

  test("an owned argument moved then reused is cloned", async () => {
    // `take` doesn't use its param → it takes ownership (a `move` param), so the
    // first call moves `s`; the reuse forces a clone at the first call site.
    await behaves(
      `function take(s: string): void {}
const s: string = "hi";
take(s);
console.log(s);`,
      "hi",
    );
  });

  test("two moves of the same binding clone all but the last", async () => {
    await behaves(
      `function take(s: string): void {}
const s: string = "hi";
take(s);
take(s);
console.log(s.length);`,
      "2",
    );
  });
});
