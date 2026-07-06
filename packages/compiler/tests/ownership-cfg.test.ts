/**
 * Specs for series 037a — ownership analysis via CFG + backward liveness.
 *
 * Replaces the straight-line `refineMoves` (034) heuristic (last *textual* use)
 * with real liveness over a control-flow graph. This fixes the two shapes the
 * heuristic gets wrong:
 *   - a **loop-carried move** (live across the back-edge) — straight-line leaves it
 *     bare → cargo E0382; the engine clones it;
 *   - a **branch join** — straight-line over-clones a move that's dead after a
 *     mutually-exclusive branch; the engine proves it dead and leaves it bare.
 *
 * The pass still only ever *adds* clones (fail-loud preserved). Differential:
 * emitted Rust compiles AND matches the TS run; clone *placement* is asserted on
 * the emitted source. See docs/work/037-ownership-cfg-liveness/specs.md.
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

describe("037a CFG + liveness ownership", () => {
  test("L1 owned-arg move inside a for, no textual use after, is cloned", async () => {
    // Straight-line sees `score(s)`'s single occurrence as a last use → bare move
    // → E0382 on iteration 2. The back-edge makes `s` live at the loop bottom.
    const src = `function score(s: string): number { return 1; }
const s: string = "hi";
let total: number = 0;
for (let i = 0; i < 3; i = i + 1) {
  total = total + score(s);
}
console.log(total);`;
    await behaves(src, "3");
    expect(compile(src)).toContain("score(s.clone())");
  });

  test("L2 `let`-alias move inside a while is cloned", async () => {
    const src = `function score(s: string): number { return 1; }
const s: string = "hello";
let total: number = 0;
let i: number = 0;
while (i < 3) {
  const t: string = s;
  total = total + score(t);
  i = i + 1;
}
console.log(total);`;
    await behaves(src, "3");
    // `const t = s` inside the loop moves `s` each iteration → must clone.
    expect(compile(src)).toContain("s.clone()");
  });

  test("B1 mutually-exclusive branches: a then-move dead after the join is NOT cloned", async () => {
    // `s` is moved in the `then` and only *read* in the mutually-exclusive `else`;
    // nothing uses it after the join. Straight-line (document order) sees the
    // else-read as a later use and clones needlessly. Liveness proves it dead.
    const src = `function score(s: string): number { return 1; }
const s: string = "hi";
const flag: boolean = true;
if (flag) {
  console.log(score(s));
} else {
  console.log(s);
}`;
    await behaves(src, "1");
    expect(compile(src)).not.toContain("s.clone()");
  });

  test("B2 a move read after the join is still cloned", async () => {
    const src = `function score(s: string): number { return 1; }
const s: string = "hi";
const flag: boolean = true;
let out: number = 0;
if (flag) {
  out = score(s);
}
console.log(out);
console.log(s.length);`;
    await behaves(src, "1\n2");
    expect(compile(src)).toContain("score(s.clone())");
  });

  test("P1 a straight-line last use stays bare (no needless clone)", () => {
    const rust = compile(`const a: string = "x";
const b: string = a;
console.log(b);`);
    expect(rust).not.toContain("a.clone()");
    expect(rust).toContain("= a;");
  });

  test("P2 straight-line reuse is still cloned + behaves", async () => {
    const src = `const a: string = "hello";
const b: string = a;
console.log(a);
console.log(b);`;
    await behaves(src, "hello\nhello");
    expect(compile(src)).toContain("a.clone()");
  });

  test("P3 nested loops exercise the fixpoint — move cloned", async () => {
    const src = `function score(s: string): number { return 1; }
const s: string = "hi";
let total: number = 0;
let i: number = 0;
while (i < 2) {
  let j: number = 0;
  while (j < 2) {
    total = total + score(s);
    j = j + 1;
  }
  i = i + 1;
}
console.log(total);`;
    await behaves(src, "4");
    expect(compile(src)).toContain("score(s.clone())");
  });
});
