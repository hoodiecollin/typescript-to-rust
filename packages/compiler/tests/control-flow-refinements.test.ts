/**
 * Specs for series 064 — control-flow refinements. Six idiomatic-emit graduations
 * over already-correct lowerings (no dialect fork): switch or-patterns
 * (`1 | 2 =>`), string scrutinee (`match s { "a" => … }`) + range-literal arms
 * (`1..=5 =>`), native `continue` inside a range-`for`, descending / step ranges
 * (`(1..=n).rev()`, `.step_by(2)`), for-of element ownership (`&mut xs`) +
 * destructuring (`for Point { x, y } in …`), and labeled `break`/`continue`.
 *
 * Each spec differential-matches (compile → cargo run → TS-via-Bun) and pins the
 * refined emitted shape. The dialect writes loop updates as `i = i + 1` (no
 * `++`/`--`). IDs map to docs/work/064-control-flow-refinements/specs.md.
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

const POINT = `interface Point { x: number; y: number; }
const pts: Array<Point> = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
`;

describe("064 control-flow refinements", () => {
  test("CF1 stacked cases fold to an or-pattern `1 | 2 =>`", async () => {
    const src = `function classify(n: number): string {
  switch (n) { case 1: case 2: return "low"; case 3: return "mid"; default: return "hi"; }
}
console.log(classify(1), classify(2), classify(3), classify(9));`;
    await behaves(src, "low low mid hi");
    expect(compile(src)).toContain("1 | 2 =>");
  });

  test("CF2 a contiguous run folds to a range-literal arm `1..=5 =>`", async () => {
    const src = `function band(n: number): string {
  switch (n) { case 1: case 2: case 3: case 4: case 5: return "lo"; default: return "hi"; }
}
console.log(band(3), band(7));`;
    await behaves(src, "lo hi");
    expect(compile(src)).toContain("1..=5 =>");
  });

  test("CF3 string scrutinee → `match s { \"r\" => … }` (no guard)", async () => {
    const src = `function color(s: string): string {
  switch (s) { case "r": return "red"; case "g": return "green"; default: return "?"; }
}
console.log(color("r"), color("g"), color("b"));`;
    await behaves(src, "red green ?");
    const rust = compile(src);
    expect(rust).toContain("match s {");
    expect(rust).toContain('"r" =>');
  });

  test("CF4 string stacked cases → string or-pattern `\"a\" | \"e\" | \"i\"`", async () => {
    const src = `function vowel(s: string): boolean {
  switch (s) { case "a": case "e": case "i": return true; default: return false; }
}
console.log(vowel("a"), vowel("e"), vowel("z"));`;
    await behaves(src, "true true false");
    expect(compile(src)).toContain('"a" | "e" | "i" =>');
  });

  test("CF5 native `continue` inside a range-`for`", async () => {
    const src = `const xs: Array<number> = [1, 2, 3, 4, 5];
let sum: number = 0;
for (let i = 0; i < xs.length; i = i + 1) { if (xs[i] % 2 === 0) { continue; } sum = sum + xs[i]; }
console.log(sum);`;
    await behaves(src, "9");
    const rust = compile(src);
    expect(rust).toContain("for i in 0..xs.len()");
    expect(rust).toContain("continue;");
  });

  test("CF6 descending loop → `(1..=n).rev()`", async () => {
    const src = `const xs: Array<number> = [10, 20, 30];
let out: number = 0;
for (let i = 2; i > 0; i = i - 1) { out = out * 10 + xs[i]; }
console.log(out);`;
    await behaves(src, "320");
    expect(compile(src)).toContain("(1..=2).rev()");
  });

  test("CF7 descending inclusive → `(0..=n).rev()`", async () => {
    const src = `const xs: Array<number> = [10, 20, 30];
let out: number = 0;
for (let i = 2; i >= 0; i = i - 1) { out = out * 10 + xs[i]; }
console.log(out);`;
    await behaves(src, "3210");
    expect(compile(src)).toContain("(0..=2).rev()");
  });

  test("CF8 non-unit step → `.step_by(2)`", async () => {
    const src = `const xs: Array<number> = [0, 10, 20, 30, 40, 50, 60];
let out: number = 0;
for (let i = 0; i <= 6; i = i + 2) { out = out + xs[i]; }
console.log(out);`;
    await behaves(src, "120");
    expect(compile(src)).toContain("(0..=6).step_by(2)");
  });

  test("CF9 for-of mutating the element in place → `&mut xs`", async () => {
    const src = `${POINT}for (const p of pts) { p.x = p.x + 10; }
console.log(pts[0].x, pts[1].x);`;
    await behaves(src, "11 13");
    const rust = compile(src);
    expect(rust).toContain("let mut pts");
    expect(rust).toContain("for p in &mut pts");
  });

  test("CF10 for-of named-struct destructuring → `for Point { x, y } in`", async () => {
    const src = `${POINT}let sum: number = 0;
for (const { x, y } of pts) { sum = sum + x + y; }
console.log(sum);`;
    await behaves(src, "10");
    expect(compile(src)).toContain("for Point { x, y } in");
  });

  test("CF11 a read-only for-of still borrows (`.iter()`, unchanged)", async () => {
    const src = `${POINT}let sum: number = 0;
for (const p of pts) { sum = sum + p.x; }
console.log(sum);`;
    await behaves(src, "4");
    const rust = compile(src);
    expect(rust).toContain("for p in pts.iter()");
    expect(rust).not.toContain("&mut");
  });

  test("CF12 labeled `break outer` across nested loops", async () => {
    const src = `let found: number = -1;
outer: for (let i = 0; i < 3; i = i + 1) {
  for (let j = 0; j < 3; j = j + 1) { if (i + j === 3) { found = i * 10 + j; break outer; } }
}
console.log(found);`;
    await behaves(src, "12");
    const rust = compile(src);
    expect(rust).toContain("'outer:");
    expect(rust).toContain("break 'outer;");
  });

  test("CF13 labeled `continue outer` advances the outer loop", async () => {
    const src = `let count: number = 0;
outer: for (let i = 0; i < 3; i = i + 1) {
  for (let j = 0; j < 3; j = j + 1) { if (j === 1) { continue outer; } count = count + 1; }
}
console.log(count);`;
    await behaves(src, "3");
    expect(compile(src)).toContain("continue 'outer;");
  });
});
