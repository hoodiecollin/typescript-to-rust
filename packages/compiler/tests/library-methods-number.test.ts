/**
 * Specs for series 083 — Number / Math library methods over the unified
 * `receiverTypeOf` backbone. Native rows (NUMN*), tslib-quirk rows (NUMT*), and
 * the variadic `min!`/`max!` macro (MINMAX*). Each spec differential-matches;
 * a `Tf` row observes the JS quirk. IDs map to
 * docs/work/083-library-methods-oracle/specs.md.
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

describe("083 Number / Math — native rows", () => {
  test("NUMN1 Math.floor / ceil / round / abs", async () => {
    const src = `console.log(Math.floor(3.7), Math.ceil(3.2), Math.round(2.5), Math.abs(-4));`;
    await behaves(src, "3 4 3 4");
    const rust = compile(src);
    expect(rust).toContain(".floor()");
    expect(rust).toContain(".ceil()");
    expect(rust).toContain(".round()");
    expect(rust).toContain(".abs()");
  });

  test("NUMN2 Math.min / max (binary → native f64)", async () => {
    const src = `console.log(Math.min(5, 9), Math.max(5, 9));`;
    await behaves(src, "5 9");
    const rust = compile(src);
    expect(rust).toContain(".min(");
    expect(rust).toContain(".max(");
  });

  test("NUMN1b Math on an f64 variable (no ambiguity)", async () => {
    const src = `const x: number = 3.7;
console.log(Math.floor(x), Math.abs(x));`;
    await behaves(src, "3 3.7");
  });
});

describe("083 Number / Math — tslib quirk rows", () => {
  test("NUMT1 toFixed(d) — rounding + formatting", async () => {
    const src = `const n: number = 3.14159;
console.log(n.toFixed(2));
console.log((2.5).toFixed(0));
console.log((1).toFixed(2));`;
    await behaves(src, "3.14\n3\n1.00");
    expect(compile(src)).toContain("tslib::number::to_fixed");
  });

  test("NUMT2 toString(radix)", async () => {
    const src = `console.log((255).toString(16));
console.log((10).toString(2));`;
    await behaves(src, "ff\n1010");
    expect(compile(src)).toContain("tslib::number::to_radix");
  });

  test("NUMT3 parseInt — radix + trailing garbage", async () => {
    const src = `console.log(Number.parseInt("42px", 10));
console.log(Number.parseInt("ff", 16));
console.log(Number.parseInt("0x1a", 16));`;
    await behaves(src, "42\n255\n26");
    expect(compile(src)).toContain("tslib::number::parse_int");
  });

  test("NUMT4 parseFloat — trailing garbage", async () => {
    const src = `console.log(Number.parseFloat("3.14abc"));
console.log(Number.parseFloat("  42 "));`;
    await behaves(src, "3.14\n42");
    expect(compile(src)).toContain("tslib::number::parse_float");
  });

  test("NUMT5 to_js_string fidelity — integers, fractions, -0", async () => {
    const src = `console.log((42).toString());
console.log((1.5).toString());
console.log((-0).toString());`;
    await behaves(src, "42\n1.5\n0");
    expect(compile(src)).toContain("tslib::number::to_js_string");
  });
});

describe("083 Math.min / max — variadic macro (Tm)", () => {
  test("MINMAX1 variadic min / max → min! / max! macro", async () => {
    const src = `console.log(Math.min(3, 1, 2), Math.max(3, 1, 2));
console.log(Math.min(5, 4, 9, 1));`;
    await behaves(src, "1 3\n1");
    const rust = compile(src);
    expect(rust).toContain("tslib::min!");
    expect(rust).toContain("tslib::max!");
  });
});
