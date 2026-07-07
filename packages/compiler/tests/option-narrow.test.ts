/**
 * Specs for series 042c — Option equality + narrowing. `x === undefined`/`null`
 * → `x.is_none()`; `!==` → `x.is_some()`; `if (x !== undefined) { …x… }` →
 * `if let Some(x) = x { … }` (x is the inner T in the block); the `=== undefined`
 * form narrows the else branch. Differential + shape assertions. IDs → specs.md.
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

describe("042c Option equality + narrowing", () => {
  test("NRW1 === undefined → is_none(), !== undefined → is_some()", () => {
    const rust = compile(`const x: number | undefined = 5;
console.log(x === undefined);
console.log(x !== undefined);`);
    expect(rust).toContain(".is_none()");
    expect(rust).toContain(".is_some()");
  });

  test("NRW2 is_none / is_some behave", async () => {
    await behaves(
      `const a: number | undefined = 5;
const b: number | undefined = undefined;
console.log(a === undefined, b === undefined);`,
      "false true",
    );
  });

  test("NRW3 if (x !== undefined) narrows to if let Some", async () => {
    const src = `const x: number | undefined = 7;
if (x !== undefined) {
  console.log(x + 1);
} else {
  console.log(-1);
}`;
    await behaves(src, "8");
    expect(compile(src)).toContain("if let Some(x) = x");
  });

  test("NRW4 narrowing takes the else path when None", async () => {
    await behaves(
      `const x: number | undefined = undefined;
if (x !== undefined) {
  console.log(x + 1);
} else {
  console.log(-1);
}`,
      "-1",
    );
  });

  test("NRW5 === undefined narrows the else branch (branches swap)", async () => {
    await behaves(
      `const x: number | undefined = 3;
if (x === undefined) {
  console.log(0);
} else {
  console.log(x * 2);
}`,
      "6",
    );
  });

  test("NRW6 null narrows the same as undefined", async () => {
    await behaves(
      `const x: number | null = 4;
if (x !== null) {
  console.log(x + 10);
} else {
  console.log(0);
}`,
      "14",
    );
  });
});
