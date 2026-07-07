/**
 * Specs for series 039 — native array iteration adapters (`some`/`every`/
 * `reduce`). These map cleanly to Rust iterator adapters (Route N, 029 catalog):
 *   xs.some(x => p)          → xs.iter().any(|&x| p)
 *   xs.every(x => p)         → xs.iter().all(|&x| p)
 *   xs.reduce((a, x) => e, i)→ xs.iter().fold(i, |a, &x| e)
 * The `reduce` callback introduces the two-param closure shape. Differential:
 * emitted Rust compiles AND matches the TS run. IDs map to specs.md.
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

describe("039 array adapters — some / every", () => {
  test("ADP1 some → any (true)", async () => {
    await behaves(
      `const xs: Array<number> = [1, 2, 3];
console.log(xs.some(x => x > 2));`,
      "true",
    );
  });

  test("ADP2 some → any (false)", async () => {
    await behaves(
      `const xs: Array<number> = [1, 2, 3];
console.log(xs.some(x => x > 5));`,
      "false",
    );
  });

  test("ADP3 every → all (true)", async () => {
    await behaves(
      `const xs: Array<number> = [1, 2, 3];
console.log(xs.every(x => x > 0));`,
      "true",
    );
  });

  test("ADP4 every → all (false)", async () => {
    await behaves(
      `const xs: Array<number> = [1, 2, 3];
console.log(xs.every(x => x > 1));`,
      "false",
    );
  });
});

describe("039 array adapters — reduce", () => {
  test("ADP5 reduce sum from 0", async () => {
    await behaves(
      `const xs: Array<number> = [1, 2, 3];
console.log(xs.reduce((acc, x) => acc + x, 0));`,
      "6",
    );
  });

  test("ADP6 reduce product from a non-zero init", async () => {
    await behaves(
      `const xs: Array<number> = [1, 2, 3, 4];
console.log(xs.reduce((acc, x) => acc * x, 1));`,
      "24",
    );
  });

  test("ADP7 routing is native (any/all/fold), not tslib", () => {
    const some = compile(
      `const xs: Array<number> = [1];\nconsole.log(xs.some(x => x > 0));`,
    );
    const every = compile(
      `const xs: Array<number> = [1];\nconsole.log(xs.every(x => x > 0));`,
    );
    const reduce = compile(
      `const xs: Array<number> = [1];\nconsole.log(xs.reduce((a, x) => a + x, 0));`,
    );
    expect(some).toContain(".any(");
    expect(every).toContain(".all(");
    expect(reduce).toContain(".fold(");
    expect(some + every + reduce).not.toContain("tslib");
  });

  test("ADP8 reduce without an init arg is fail-loud", () => {
    expect(() =>
      compile(
        `const xs: Array<number> = [1, 2, 3];\nconst s = xs.reduce((acc, x) => acc + x);`,
      ),
    ).toThrow(UnsupportedError);
  });
});

describe("039 array adapters — user-method guard", () => {
  test("ADP9 a user class method named reduce is a native call, not hijacked", () => {
    const src = `class Box {
  n: number;
  constructor(n: number) { this.n = n; }
  reduce(): number { return this.n; }
}
const b: Box = new Box(5);
console.log(b.reduce());`;
    const rust = compile(src);
    expect(rust).toContain("b.reduce()");
    expect(rust).not.toContain(".fold(");
  });
});
