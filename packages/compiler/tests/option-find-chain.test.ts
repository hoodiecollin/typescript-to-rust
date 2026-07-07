/**
 * Specs for series 042d — `Array.find` → `Option<T>` and single-level optional
 * chaining `a?.b` → `a.map(|v| v.b)`. Both consume via `??`/narrowing.
 * Differential + shape assertions. IDs → specs.md.
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

describe("042d find → Option", () => {
  test("FND1 find returns the matching element via ??", async () => {
    const src = `const xs: Array<number> = [1, 2, 3];
const found = xs.find(x => x > 1);
console.log(found ?? -1);`;
    await behaves(src, "2");
    expect(compile(src)).toContain(".find(");
    expect(compile(src)).toContain(".copied()");
  });

  test("FND2 find with no match is None → fallback", async () => {
    await behaves(
      `const xs: Array<number> = [1, 2, 3];
const found = xs.find(x => x > 9);
console.log(found ?? -1);`,
      "-1",
    );
  });

  test("FND3 find result narrows with if let", async () => {
    await behaves(
      `const xs: Array<number> = [5, 6, 7];
const found = xs.find(x => x > 5);
if (found !== undefined) {
  console.log(found * 10);
} else {
  console.log(0);
}`,
      "60",
    );
  });
});

describe("042d optional chaining a?.b", () => {
  test("CHN1 a?.b maps over an optional struct", async () => {
    const src = `interface Point { x: number; }
const p: Point | undefined = { x: 42 };
console.log((p?.x) ?? -1);`;
    await behaves(src, "42");
    expect(compile(src)).toContain(".map(|v| v.x)");
  });

  test("CHN2 a?.b on an absent value is None", async () => {
    await behaves(
      `interface Point { x: number; }
const p: Point | undefined = undefined;
console.log((p?.x) ?? -1);`,
      "-1",
    );
  });

  test("CHN3 a deeper chain is fail-loud", () => {
    expect(() =>
      compile(`interface A { b: B; }
interface B { c: number; }
const a: A | undefined = undefined;
const y = a?.b?.c;`),
    ).toThrow(UnsupportedError);
  });
});
