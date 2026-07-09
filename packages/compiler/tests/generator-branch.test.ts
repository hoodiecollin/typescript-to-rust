/**
 * Specs for series 052b — conditional / branch yields (GEN5-7). Adds branch
 * blocks to the generator CFG: an `if`/`else` whose arms yield routes to distinct
 * resume states, and a local live across a yield on only one branch is carried
 * (a struct field) without disturbing the other branch.
 *
 * IDs map to docs/work/_archive/052-generator-state-machines/specs.md.
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

describe("052b generator state machines — conditional / branch yields", () => {
  test("GEN5 (differential) a conditional-yield generator picks the right branch", async () => {
    const src = `function* pick(p: boolean): Generator<number> {
  if (p) { yield 1; } else { yield 2; }
}
for (const x of pick(true)) { console.log(x); }
for (const x of pick(false)) { console.log(x); }`;
    await behaves(src, "1\n2");
  });

  test("GEN6 (differential) a yield guarded by an `if` inside a loop yields only the passing elements", async () => {
    const src = `function* evens(n: number): Generator<number> {
  for (let i = 0; i < n; i = i + 1) {
    if (i % 2 === 0) { yield i; }
  }
}
for (const x of evens(5)) { console.log(x); }`;
    await behaves(src, "0\n2\n4");
  });

  test("GEN7 (differential) a local live across a yield on only one branch is carried correctly", async () => {
    const src = `function* g(p: boolean, n: number): Generator<number> {
  if (p) {
    let a: number = 0;
    while (a < n) { yield a; a = a + 1; }
  } else {
    yield 99;
  }
}
for (const x of g(true, 3)) { console.log(x); }
for (const x of g(false, 3)) { console.log(x); }`;
    await behaves(src, "0\n1\n2\n99");
  });
});
