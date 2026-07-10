/**
 * Specs for series 063 — value-yielding `try`/`catch` + control-flow escape. The
 * escaping/value-yielding `try`/`catch` lowers to a Rust **labeled block** (not the
 * 021 IIFE closure), so native `return`/`break`/`continue` in the arms escape the
 * enclosing fn/loop; `?`/`throw` in the `try` body become `break '<label> Err(…)`.
 * `try`/`finally` with no `catch` runs `finally` then propagates. `finally`
 * combined with an escaping jump stays fail-loud (carrier-enum follow-on).
 *
 * Each spec differential-matches (compile → cargo run → TS-via-Bun). IDs map to
 * docs/work/063-value-yielding-try-catch/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { lower } from "../src/lower";
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

function rejects(src: string, re: RegExp): void {
  expect(() =>
    lower(parseSync("t.ts", src).program as unknown as Program),
  ).toThrow(re);
}

const RISKY = `function risky(n: number): number {
  if (n < 0) { throw new Error("neg"); }
  return n * 2;
}
`;

describe("063 value-yielding try/catch", () => {
  test("VY1 `try { return f() } catch { return d }` yields via native return", async () => {
    const src = `${RISKY}function classify(n: number): number {
  try { return risky(n); } catch (e) { return -1; }
}
console.log(classify(5), classify(-1));`;
    await behaves(src, "10 -1");
    const rust = compile(src);
    expect(rust).toContain("'try_0: {");
    expect(rust).toContain("break 'try_0 Err(");
  });

  test("VY2 the catch value flows through a native return", async () => {
    const src = `${RISKY}function safe(n: number): number {
  try { const v: number = risky(n); return v + 1; } catch (e) { return 0; }
}
console.log(safe(3), safe(-5));`;
    await behaves(src, "7 0");
  });

  test("ESC1 `break` inside `try` escapes the enclosing loop", async () => {
    const src = `${RISKY}function countUntilBad(xs: Array<number>): number {
  let count: number = 0;
  for (let i = 0; i < xs.length; i = i + 1) {
    try { risky(xs[i]); } catch (e) { break; }
    count = count + 1;
  }
  return count;
}
console.log(countUntilBad([1, 2, -3, 4]));`;
    await behaves(src, "2");
    expect(compile(src)).toContain("break;");
  });

  test("ESC2 `continue` inside `try` advances the enclosing loop", async () => {
    const src = `${RISKY}function countOk(xs: Array<number>): number {
  let ok: number = 0;
  for (let i = 0; i < xs.length; i = i + 1) {
    try { risky(xs[i]); } catch (e) { continue; }
    ok = ok + 1;
  }
  return ok;
}
console.log(countOk([1, -2, 3, -4, 5]));`;
    await behaves(src, "3");
  });

  test("FIN1 `try`/`finally` with no catch runs finally then propagates", async () => {
    const src = `${RISKY}function work(n: number): number {
  let result: number = 0;
  try { result = risky(n); } finally { console.log("cleanup"); }
  return result;
}
function driver(): number {
  try { return work(-1); } catch (e) { return 42; }
}
console.log(work(3));
console.log(driver());`;
    await behaves(src, "cleanup\n6\ncleanup\n42");
  });

  test("RETHROW re-throw in catch (no finally) propagates", async () => {
    const src = `${RISKY}function pass(n: number): number {
  try { return risky(n); } catch (e) { throw new Error("wrapped"); }
}
function driver(n: number): number {
  try { return pass(n); } catch (e) { return -7; }
}
console.log(driver(4), driver(-1));`;
    await behaves(src, "8 -7");
  });

  test("FL1 `finally` combined with an escaping return is fail-loud", () => {
    rejects(
      `${RISKY}function bad(n: number): number {
  try { return risky(n); } catch (e) { return 0; } finally { console.log("f"); }
}
console.log(bad(1));`,
      /finally|escap/i,
    );
  });
});
