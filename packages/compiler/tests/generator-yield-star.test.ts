/**
 * Specs for series 065 — generator `yield*` delegation & non-`for-of` collecting
 * consumption. Rides the 052 state machine: `yield* <iter>` becomes a delegating
 * state (a boxed `Iterator` field pumped to exhaustion); `[...g()]` and
 * `Array.from(g())` collect an `impl Iterator` into a `Vec`. Manual `.next()`
 * stays fail-loud (pull-only `Option<T>`, no `{value, done}`).
 *
 * Each spec differential-matches (compile → cargo run → TS-via-Bun). IDs map to
 * docs/work/065-yield-star-consumption/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { lower } from "../src/lower";
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

function rejects(src: string, re: RegExp): void {
  expect(() =>
    lower(parseSync("t.ts", src).program as unknown as Program),
  ).toThrow(re);
}

describe("065 yield* delegation & collecting consumption", () => {
  test("YS1 `yield* inner()` delegates to another generator", async () => {
    const src = `function* inner(): Generator<number> { yield 1; yield 2; }
function* outer(): Generator<number> { yield 0; yield* inner(); yield 3; }
for (const x of outer()) { console.log(x); }`;
    await behaves(src, "0\n1\n2\n3");
    const rust = compile(src);
    expect(rust).toContain("Box<dyn Iterator<Item = f64>>");
    expect(rust).toContain("inner().into_iter()");
  });

  test("YS2 `yield* [array]` delegates to a non-generator iterable", async () => {
    const src = `function* g(): Generator<number> { yield 10; yield* [20, 30]; yield 40; }
for (const x of g()) { console.log(x); }`;
    await behaves(src, "10\n20\n30\n40");
  });

  test("YS3 chained `yield*` compose", async () => {
    const src = `function* a(): Generator<number> { yield 1; }
function* b(): Generator<number> { yield* a(); yield 2; }
function* c(): Generator<number> { yield* b(); yield 3; }
let sum: number = 0;
for (const x of c()) { sum = sum * 10 + x; }
console.log(sum);`;
    await behaves(src, "123");
  });

  test("CON1 `[...g()]` collects a generator into a `Vec`", async () => {
    const src = `function* g(): Generator<number> { yield 5; yield 6; yield 7; }
const arr: Array<number> = [...g()];
console.log(arr.length, arr[0], arr[2]);`;
    await behaves(src, "3 5 7");
    expect(compile(src)).toContain(".collect::<Vec<_>>()");
  });

  test("CON2 `Array.from(g())` collects a generator into a `Vec`", async () => {
    const src = `function* g(): Generator<number> { yield 1; yield 2; }
const arr: Array<number> = Array.from(g());
let sum: number = 0;
for (const x of arr) { sum = sum + x; }
console.log(arr.length, sum);`;
    await behaves(src, "2 3");
    expect(compile(src)).toContain(".collect::<Vec<_>>()");
  });

  test("FL1 manual generator `.next()` is fail-loud", () => {
    rejects(
      `function* g(): Generator<number> { yield 1; }
g().next();`,
      /next|pull-only|Iterator/i,
    );
  });
});
