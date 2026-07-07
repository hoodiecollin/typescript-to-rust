/**
 * Specs for series 043 — Object.entries over IndexMap records. for-of
 * destructuring `for (const [k, v] of Object.entries(m))` → `for (k, v) in
 * m.iter()`; a stored `const es = Object.entries(m)` is `Vec<(String, V)>` with
 * `es[i][0]`/`es[i][1]` → tuple `.0`/`.1`. Differential + shape. IDs → specs.md.
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

const REC3 = `const m: Record<string, number> = { "a": 1, "b": 2, "c": 3 };`;

describe("043a Object.entries for-of destructuring", () => {
  test("ENT1 iterates pairs in insertion order", async () => {
    const src = `${REC3}
for (const [k, v] of Object.entries(m)) {
  console.log(k, v);
}`;
    await behaves(src, "a 1\nb 2\nc 3");
    expect(compile(src)).toContain("for (k, v) in m.iter()");
  });

  test("ENT3 a stored entries binding drives destructuring too", async () => {
    await behaves(
      `${REC3}
const es = Object.entries(m);
for (const [k, v] of es) {
  console.log(k, v);
}`,
      "a 1\nb 2\nc 3",
    );
  });
});

describe("043b Object.entries stored + indexed", () => {
  test("ENT4 pair index → tuple field; length works", async () => {
    const src = `${REC3}
const es = Object.entries(m);
console.log(es[0][0], es[0][1], es.length);`;
    await behaves(src, "a 1 3");
    const rust = compile(src);
    expect(rust).toContain(".0");
    expect(rust).toContain(".1");
  });

  test("ENT5 the entries value is the iter().map().collect() chain", () => {
    expect(
      compile(`${REC3}\nconst es = Object.entries(m);\nconsole.log(es.length);`),
    ).toContain(".iter().map(|(k, v)| (k.clone(), v.clone())).collect");
  });
});

describe("043 fail-loud", () => {
  test("ENT6 a plain array-destructuring binding is fail-loud", () => {
    expect(() =>
      compile(`const xs: Array<number> = [1, 2];\nconst [a, b] = xs;`),
    ).toThrow(UnsupportedError);
  });
});
