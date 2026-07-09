/**
 * Specs for series 052c — interleaved / multiple loops + non-yield statements
 * (GEN8-9). Stress tests across-yield liveness of a mutated accumulator and
 * state numbering across multiple loop regions with a lazy side-effecting
 * statement between them.
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

describe("052c generator state machines — interleaved / multiple loops", () => {
  test("GEN8 (differential) a mutated accumulator carried across yields", async () => {
    const src = `function* sums(n: number): Generator<number> {
  let sum: number = 0;
  for (let i = 0; i < n; i = i + 1) { sum = sum + i; yield sum; }
}
for (const x of sums(4)) { console.log(x); }`;
    await behaves(src, "0\n1\n3\n6");
  });

  test("GEN9 (differential) two sequential loops with a lazy statement between them", async () => {
    const src = `function* two(n: number): Generator<number> {
  for (let i = 0; i < n; i = i + 1) { yield i; }
  console.log("mid");
  for (let j = 0; j < n; j = j + 1) { yield j + 10; }
}
for (const x of two(2)) { console.log(x); }`;
    // Lazy consumption: 0, 1, then "mid" prints as the generator crosses into
    // the second loop, then 10, 11. TS and Rust agree on this interleaving.
    await behaves(src, "0\n1\nmid\n10\n11");
  });
});
