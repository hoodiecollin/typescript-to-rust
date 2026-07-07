/**
 * Specs for series 040 — array quirk methods (`sort`/`slice`) routed to the
 * `tslib` fidelity crate (029 Route Tf). `sort` observes JS's default
 * lexicographic *string* compare (and a numeric comparator); `slice` observes
 * JS's clamped, negative-aware, end-exclusive copy. Differential: emitted Rust
 * compiles (linking `tslib`) AND matches the TS run. IDs map to specs.md.
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

describe("040 array quirk — sort", () => {
  test("QRK1 default sort is lexicographic string order (quirk)", async () => {
    const src = `const xs: Array<number> = [10, 1, 2];
xs.sort();
console.log(xs[0], xs[1], xs[2]);`;
    await behaves(src, "1 10 2");
    expect(compile(src)).toContain("tslib::array::sort_default");
  });

  test("QRK2 numeric comparator sorts ascending (differs from default)", async () => {
    const src = `const xs: Array<number> = [10, 1, 2];
xs.sort((a, b) => a - b);
console.log(xs[0], xs[1], xs[2]);`;
    await behaves(src, "1 2 10");
    expect(compile(src)).toContain("tslib::array::sort_by");
  });

  test("QRK3 numeric comparator sorts descending", async () => {
    await behaves(
      `const xs: Array<number> = [10, 1, 2];
xs.sort((a, b) => b - a);
console.log(xs[0], xs[1], xs[2]);`,
      "10 2 1",
    );
  });

  test("QRK4 sort with a non-arrow argument is fail-loud", () => {
    expect(() =>
      compile(
        `const cmp = 5;\nconst xs: Array<number> = [1, 2];\nxs.sort(cmp);`,
      ),
    ).toThrow(UnsupportedError);
  });
});

describe("040 array quirk — slice", () => {
  test("QRK5 slice(start, end) is start-inclusive, end-exclusive", async () => {
    const src = `const xs: Array<number> = [1, 2, 3, 4];
const ys: Array<number> = xs.slice(1, 3);
console.log(ys[0], ys[1], ys.length);`;
    await behaves(src, "2 3 2");
    expect(compile(src)).toContain("tslib::array::slice");
  });

  test("QRK6 slice(negativeStart) with end omitted counts from the end", async () => {
    const src = `const xs: Array<number> = [1, 2, 3, 4];
const ys: Array<number> = xs.slice(-2);
console.log(ys[0], ys[1], ys.length);`;
    await behaves(src, "3 4 2");
    expect(compile(src)).toContain("tslib::array::slice_from");
  });

  test("QRK7 slice clamps an out-of-range end to len", async () => {
    await behaves(
      `const xs: Array<number> = [1, 2, 3, 4];
const ys: Array<number> = xs.slice(1, 100);
console.log(ys.length);`,
      "3",
    );
  });
});

describe("040 array quirk — user-method guard", () => {
  test("QRK8 user class methods named sort/slice are native calls", () => {
    const src = `class Grid {
  n: number;
  constructor(n: number) { this.n = n; }
  sort(): number { return this.n; }
}
const g: Grid = new Grid(7);
console.log(g.sort());`;
    const rust = compile(src);
    expect(rust).toContain("g.sort()");
    expect(rust).not.toContain("tslib::array::sort");
  });
});
