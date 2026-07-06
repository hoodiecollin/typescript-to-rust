/**
 * Specs for series 026 (first slice) — parentheses + precedence-aware emission
 * (gap D from 030). Parsing preserves grouping structurally (a
 * `ParenthesizedExpression` wraps the grouped subtree); lowering unwraps it, and
 * the emitter re-parenthesizes a `binary` child from an operator-precedence
 * table so `(a + b) * c` never flattens to `a + b * c`.
 *
 * Every spec is differential: emitted Rust compiles AND its stdout matches TS.
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

describe("026 parens + precedence", () => {
  test("a grouped additive under a multiply keeps its parens", async () => {
    await behaves(`console.log((1 + 2) * 3);`, "9");
  });

  test("natural precedence needs no parens", async () => {
    await behaves(`console.log(1 + 2 * 3);`, "7");
  });

  test("right-side same-precedence subtraction is parenthesized", async () => {
    await behaves(`console.log(10 - (3 - 1));`, "8");
  });

  test("two grouped sums divided", async () => {
    await behaves(
      `const a: number = 8;
const b: number = 2;
const c: number = 3;
const d: number = 1;
console.log((a + b) / (c + d));`,
      "2.5",
    );
  });

  test("deeply nested grouping round-trips", async () => {
    await behaves(`console.log(2 * (3 + 4) - (1 + 1));`, "12");
  });

  test("the emitted Rust actually contains the guarding parens", () => {
    const rust = compile(`console.log((1 + 2) * 3);`);
    expect(rust).toContain("(1.0 + 2.0) * 3.0");
  });
});
