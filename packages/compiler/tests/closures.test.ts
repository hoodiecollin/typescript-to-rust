/**
 * Specs for series 027-cl — value-position closures over arrays (the "hard gate"
 * for 027). A single-param arrow passed to `map`/`filter`/`forEach` lowers to a
 * Rust iterator chain:
 *   xs.map(x => e)     → xs.iter().map(|&x| e).collect::<Vec<_>>()
 *   xs.filter(x => c)  → xs.iter().filter(|&&x| c).copied().collect::<Vec<_>>()
 *   xs.forEach(x => s) → for &x in xs.iter() { s }
 *
 * First slice: `Array<number>` (Copy elements). Differential-verified.
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

describe("027-cl value-position closures over arrays", () => {
  test("map doubles each element", async () => {
    await behaves(
      `const xs: Array<number> = [1, 2, 3];
const ys: Array<number> = xs.map(x => x * 2);
console.log(ys[2]);`,
      "6",
    );
  });

  test("filter keeps a predicate's matches", async () => {
    await behaves(
      `const xs: Array<number> = [1, 2, 3, 4];
const big: Array<number> = xs.filter(x => x > 2);
console.log(big.length);`,
      "2",
    );
  });

  test("forEach runs a side effect per element", async () => {
    await behaves(
      `const xs: Array<number> = [1, 2, 3];
xs.forEach(x => console.log(x));`,
      "1\n2\n3",
    );
  });

  test("map body can capture an outer binding", async () => {
    await behaves(
      `const factor: number = 10;
const xs: Array<number> = [1, 2, 3];
const ys: Array<number> = xs.map(x => x * factor);
console.log(ys[1]);`,
      "20",
    );
  });

  test("a forEach block body with a statement", async () => {
    await behaves(
      `const xs: Array<number> = [2, 4];
let total: number = 0;
xs.forEach(x => { total = total + x; });
console.log(total);`,
      "6",
    );
  });
});
