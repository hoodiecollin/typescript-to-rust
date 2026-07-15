/**
 * Specs for series 085 — `flatMap` (uniform `U[]`-returning callback) + literal-
 * constant `flat(k)`, graduating the two tractable forms off the fail-loud list
 * (issue #60). The hard residual (union callbacks, dynamic depth, jagged, and
 * `flat(Infinity)`) stays fail-loud → epic #59. IDs map to
 * docs/work/085-flatmap-flat/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { runRust } from "../src/harness";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program, src);
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

describe("085 flatMap (U[] callback)", () => {
  test("FM1 flatMap(x => [x, x*10]) — one-level flatten to Vec<f64>", async () => {
    const src = `const xs: Array<number> = [1, 2, 3];
const ys: Array<number> = xs.flatMap((x: number): Array<number> => [x, x * 10]);
console.log(ys.length, ys[0], ys[1], ys[5]);`;
    await behaves(src, "6 1 10 30");
    expect(compile(src)).toContain(".flat_map(");
  });

  test("FM2 flatMap with a captured free var forwards through the lift", async () => {
    const src = `const k: number = 2;
const xs: Array<number> = [1, 2, 3];
const ys: Array<number> = xs.flatMap((x: number): Array<number> => [x, x * k]);
console.log(ys.length, ys[1], ys[3]);`;
    await behaves(src, "6 2 4");
  });

  test("FM3 flatMap(x => [x]) — degenerate one-to-one identity flatten", async () => {
    const src = `const xs: Array<number> = [5, 6, 7];
const ys: Array<number> = xs.flatMap((x: number): Array<number> => [x]);
console.log(ys.length, ys[0], ys[2]);`;
    await behaves(src, "3 5 7");
    expect(compile(src)).toContain(".flat_map(");
  });
});

describe("085 flat(k) literal constant", () => {
  test("FLATK1 flat(2) on number[][][] — two chained flattens", async () => {
    const src = `const xss: Array<Array<Array<number>>> = [[[1, 2], [3]], [[4]]];
const flat: Array<number> = xss.flat(2);
console.log(flat.length, flat[0], flat[3]);`;
    await behaves(src, "4 1 4");
    // Two nested tslib flattens (depth-1 composed).
    const rust = compile(src);
    expect(rust.split("tslib::array::flat").length - 1).toBe(2);
  });

  test("FLATK2 flat(1) equals the depth-1 flat()", async () => {
    const src = `const xss: Array<Array<number>> = [[1, 2], [3, 4]];
const flat: Array<number> = xss.flat(1);
console.log(flat.length, flat[0], flat[3]);`;
    await behaves(src, "4 1 4");
    expect(compile(src)).toContain("tslib::array::flat");
  });

  test("FLATK3 flat(3) on number[][][][] — three chained flattens", async () => {
    const src = `const xsss: Array<Array<Array<Array<number>>>> = [[[[1], [2]]], [[[3]]]];
const flat: Array<number> = xsss.flat(3);
console.log(flat.length, flat[0], flat[2]);`;
    await behaves(src, "3 1 3");
    const rust = compile(src);
    expect(rust.split("tslib::array::flat").length - 1).toBe(3);
  });
});

describe("085 fail-loud residuals (→ #59)", () => {
  test("FM-FL1 flatMap with a U | U[] union callback stays fail-loud", () => {
    const src = `const xs: Array<number> = [1, 2, 3];
const ys = xs.flatMap((x: number) => (x % 2 === 0 ? [x, x] : x));
console.log(ys.length);`;
    expect(() => compile(src)).toThrow();
  });

  test("FLATK-FL1 dynamic-depth flat(n) (variable) stays fail-loud (cargo rejects)", async () => {
    const src = `const n: number = 2;
const xss: Array<Array<Array<number>>> = [[[1]], [[2]]];
const flat: Array<number> = xss.flat(n);
console.log(flat.length);`;
    const rr = await runRust(compile(src));
    expect(rr.ok).toBe(false);
  });

  test("FLATK-FL2 flat(Infinity) stays fail-loud (cargo rejects)", async () => {
    const src = `const xss: Array<Array<Array<number>>> = [[[1]], [[2]]];
const flat: Array<number> = xss.flat(Infinity);
console.log(flat.length);`;
    const rr = await runRust(compile(src));
    expect(rr.ok).toBe(false);
  });

  test("FLATK-FL3 flat(2) on a receiver not nested 2 deep stays fail-loud", () => {
    // number[][] flattened with depth 2 → the k-level walk hits a non-vec level
    // (jagged/under-nested residual). Compile-time reject, never a wrong value.
    const src = `const xss: Array<Array<number>> = [[1, 2], [3, 4]];
const flat: Array<number> = xss.flat(2);
console.log(flat.length);`;
    expect(() => compile(src)).toThrow();
  });
});
