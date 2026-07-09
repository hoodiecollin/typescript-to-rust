/**
 * Specs for series 052a — single counting-loop generators (GEN1-4). A
 * `function*` whose body has a `yield` inside a loop lowers to a resumable
 * state-machine `struct` + `impl Iterator` (not the 035 `vec![…].into_iter()`).
 * This slice establishes the whole subsystem: intra-fn CFG, live-variable
 * analysis across yields (loop counter + param → struct fields), state
 * numbering, the `loop { match self.state { … } }` `next()`, and the public
 * wrapper fn (which keeps the 035 `impl Iterator` shape, so `for-of` composes).
 *
 * IDs map to docs/work/_archive/052-generator-state-machines/specs.md.
 * Differential specs assert Rust stdout === TS stdout; substring specs pin the
 * generated state-machine shape.
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

describe("052a generator state machines — single counting loop", () => {
  test("GEN1 (differential) a counting-loop generator consumed by for-of yields the sequence", async () => {
    const src = `function* range(n: number): Generator<number> {
  for (let i = 0; i < n; i = i + 1) { yield i; }
}
for (const x of range(3)) { console.log(x); }`;
    await behaves(src, "0\n1\n2");
    const rust = compile(src);
    // A generated state-machine struct with a `state: u32` discriminant …
    expect(rust).toContain("state: u32");
    expect(rust).toContain("impl Iterator for RangeGen");
    expect(rust).toContain("match self.state");
    // … and the wrapper keeps the 035 `impl Iterator<Item = f64>` surface.
    expect(rust).toContain("fn range(n: f64) -> impl Iterator<Item = f64>");
  });

  test("GEN2 (differential) the while-loop equivalent produces the same sequence", async () => {
    const src = `function* range(n: number): Generator<number> {
  let i = 0;
  while (i < n) { yield i; i = i + 1; }
}
for (const x of range(3)) { console.log(x); }`;
    await behaves(src, "0\n1\n2");
  });

  test("GEN3 (differential) an empty range yields nothing", async () => {
    const src = `function* range(n: number): Generator<number> {
  for (let i = 0; i < n; i = i + 1) { yield i; }
}
for (const x of range(0)) { console.log(x); }
console.log("done");`;
    await behaves(src, "done");
  });

  test("GEN4 the across-yield local `i` and param `n` are struct fields; a non-carried local stays a bare `let`", () => {
    const src = `function* g(n: number): Generator<number> {
  for (let i = 0; i < n; i = i + 1) {
    const doubled: number = i * 2;
    yield doubled;
  }
}
for (const x of g(2)) { console.log(x); }`;
    const rust = compile(src);
    // `i` and `n` survive suspend → struct fields (`self.i`, `self.n`).
    expect(rust).toContain("self.i");
    expect(rust).toContain("self.n");
    // `doubled` is read only inside its own arm (before the yield) → a bare
    // `let`, never a `self.` field.
    expect(rust).toContain("let doubled");
    expect(rust).not.toContain("self.doubled");
  });
});
