/**
 * Specs for series 044 — Object.assign + object spread over IndexMap records.
 * Both lower to a merged-map builder block; later sources/spreads override
 * earlier keys (JS semantics). Differential + shape. IDs → specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit, UnsupportedError } from "../src/emitter";
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

describe("044a Object.assign", () => {
  test("ASN1 merge into a fresh {} target", async () => {
    const src = `const a: Record<string, number> = { "x": 1 };
const b: Record<string, number> = { "y": 2 };
const m: Record<string, number> = Object.assign({}, a, b);
console.log(m["x"], m["y"]);`;
    await behaves(src, "1 2");
    expect(compile(src)).toContain("let mut __o = IndexMap::new();");
  });

  test("ASN3 a later source overrides an earlier key", async () => {
    await behaves(
      `const a: Record<string, number> = { "x": 1 };
const b: Record<string, number> = { "x": 9 };
const m: Record<string, number> = Object.assign({}, a, b);
console.log(m["x"]);`,
      "9",
    );
  });
});

describe("044b object spread", () => {
  test("SPR1 { ...a, k: v } applies the explicit entry", async () => {
    const src = `const a: Record<string, number> = { "x": 1 };
const m: Record<string, number> = { ...a, "y": 2 };
console.log(m["x"], m["y"]);`;
    await behaves(src, "1 2");
    expect(compile(src)).toContain("__o.extend(");
  });

  test("SPR3 an explicit key before a spread is overridden by the spread", async () => {
    await behaves(
      `const a: Record<string, number> = { "x": 5 };
const m: Record<string, number> = { "x": 1, ...a };
console.log(m["x"]);`,
      "5",
    );
  });
});

describe("044 fail-loud", () => {
  test("SPR4 array spread is fail-loud", () => {
    expect(() =>
      compile(`const a: Array<number> = [1, 2];\nconst b: Array<number> = [...a];`),
    ).toThrow(UnsupportedError);
  });
});
