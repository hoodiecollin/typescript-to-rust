/**
 * Specs for series 083 slice 8 (+9) — Array-access tail methods over the unified
 * `receiverTypeOf` / `elementTypeOf` backbone: `join`, `concat`, `reverse`,
 * `flat` (depth 1). Each differential-matches. Residuals (`flatMap`, deep
 * `flat(n)`, `splice`) stay fail-loud (ARR-FL*). IDs map to
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

describe("083 Array-access tail", () => {
  test("ARR1 join(sep) — coerces elements to strings (number array)", async () => {
    const src = `const xs: Array<number> = [1, 2, 3];
console.log(xs.join("-"));
const ss: Array<string> = ["a", "b"];
console.log(ss.join(", "));`;
    await behaves(src, "1-2-3\na, b");
    expect(compile(src)).toContain("tslib::array::join");
  });

  test("ARR2 concat(ys) — a new array, receiver unchanged", async () => {
    const src = `const xs: Array<number> = [1, 2, 3];
const ys: Array<number> = [4, 5];
const zs: Array<number> = xs.concat(ys);
console.log(zs.length, xs.length);
console.log(zs[3]);`;
    await behaves(src, "5 3\n4");
    expect(compile(src)).toContain("tslib::array::concat");
  });

  test("ARR3 reverse() — in place (native Vec::reverse)", async () => {
    const src = `const xs: Array<number> = [1, 2, 3];
xs.reverse();
console.log(xs[0], xs[2]);`;
    await behaves(src, "3 1");
    expect(compile(src)).toContain(".reverse()");
  });

  test("FLAT2a flat() (depth 1) — flatten an array of arrays", async () => {
    const src = `const xss: Array<Array<number>> = [[1, 2], [3, 4]];
const flat: Array<number> = xss.flat();
console.log(flat.length, flat[0], flat[3]);`;
    await behaves(src, "4 1 4");
    expect(compile(src)).toContain("tslib::array::flat");
  });

  test("ARR-INF join over a getX() array receiver (elementTypeOf oracle tier)", async () => {
    const src = `function getRows(): Array<number> { return [1, 2, 3]; }
console.log(getRows().join("+"));`;
    await behaves(src, "1+2+3");
  });
});

describe("083 Array-access tail — fail-loud residuals", () => {
  test("ARR-FL1 flatMap stays fail-loud (array-returning callback lift deferred)", () => {
    const src = `const xs: Array<number> = [1, 2, 3];
const ys: Array<number> = xs.flatMap((x: number): Array<number> => [x, x * 10]);
console.log(ys.length);`;
    expect(() => compile(src)).toThrow();
  });

  test("ARR-FL2 deep flat(n) stays fail-loud (cargo rejects)", async () => {
    // `flat(n)` with an explicit depth is unmodeled → generic method fallthrough
    // emits `.flat(2.0)`, which `Vec` has no method for. Fail-loud at cargo (never
    // a wrong value) — the depth-1 `flat()` route is deliberately not claimed.
    const src = `const xss: Array<Array<Array<number>>> = [[[1]], [[2]]];
const flat: Array<number> = xss.flat(2);
console.log(flat.length);`;
    const rr = await runRust(compile(src));
    expect(rr.ok).toBe(false);
  });
});
