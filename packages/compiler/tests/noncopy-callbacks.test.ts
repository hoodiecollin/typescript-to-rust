/**
 * Specs for series 057 — non-Copy element callbacks + index param.
 *
 * 048 lifted array-callback bodies for **Copy** (numeric) elements. 057 graduates
 * the two deferrals: a non-Copy element (`String`/struct) crosses the shim by a
 * local read/consume decision — read-only forwards `&T` (no clone), consumed owns
 * `T` (`.clone()` at the boundary), unclassifiable stays fail-loud — and the
 * `(el, i)` index param lowers via `.iter().enumerate()` with the index forwarded
 * as `i as f64` (it joins the f64 numeric surface). The whole-array third param, a
 * non-Copy `reduce`/`sort` element, and an unclassifiable flow stay fail-loud.
 *
 * Differential specs assert BOTH runtime behavior and the shim shape. A whole-Vec
 * `console.log` has no Rust `Display`, so results are reduced to a scalar element /
 * `.length` / a `bool`. IDs map to docs/work/057-noncopy-element-callbacks/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { UnsupportedError } from "../src/errors";
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

describe("057 non-Copy element callbacks + index param", () => {
  test("NCB1 read-only struct element → &T param, no clone (map)", async () => {
    const src = `${POINT}const r: Array<number> = pts.map(p => p.x + p.y);
console.log(r[0], r[1]);`;
    await behaves(src, "3 7");
    const rust = compile(src);
    expect(rust).toContain("fn __cb_map_1(p: &Point) -> f64");
    expect(rust).toContain(".iter().map(|p| __cb_map_1(p))");
    expect(rust).not.toContain(".clone()");
  });

  test("NCB2 read-only struct predicate → &T param, .cloned() terminal (filter)", async () => {
    const src = `${POINT}const r: Array<Point> = pts.filter(p => p.x > 2);
console.log(r.length);`;
    await behaves(src, "1");
    const rust = compile(src);
    expect(rust).toContain("fn __cb_filter_1(p: &Point) -> bool");
    expect(rust).toContain(".iter().filter(|p| __cb_filter_1(*p))");
    expect(rust).toContain(".cloned()");
    expect(rust).not.toContain(".copied()");
  });

  test("NCB3 consumed String element → owned String, .clone() at the shim (map)", async () => {
    const src = `const strs: Array<string> = ["a", "b"];
const r: Array<string> = strs.map(s => s);
console.log(r[0], r[1]);`;
    await behaves(src, "a b");
    const rust = compile(src);
    expect(rust).toContain("fn __cb_map_1(s: String) -> String");
    expect(rust).toContain(".iter().map(|s| __cb_map_1(s.clone()))");
  });

  test("NCB4 consumed struct element → owned T, .clone() (map)", async () => {
    const src = `${POINT}const r: Array<Point> = pts.map(p => p);
console.log(r[0].x, r[1].y);`;
    await behaves(src, "1 4");
    const rust = compile(src);
    expect(rust).toContain("fn __cb_map_1(p: Point) -> Point");
    expect(rust).toContain(".iter().map(|p| __cb_map_1(p.clone()))");
  });

  test("NCB5 read-only struct predicate → .any(), borrow (some)", async () => {
    const src = `${POINT}console.log(pts.some(p => p.x > 2));`;
    await behaves(src, "true");
    expect(compile(src)).toContain(".iter().any(|p| __cb_some_1(p))");
  });

  test("NCB6 read-only struct predicate → .cloned(), borrow (find)", async () => {
    const src = `${POINT}console.log(pts.find(p => p.x > 2) !== undefined);`;
    await behaves(src, "true");
    const rust = compile(src);
    expect(rust).toContain("fn __cb_find_1(p: &Point) -> bool");
    expect(rust).toContain(".iter().find(|p| __cb_find_1(*p)).cloned()");
  });

  test("IDX1 index param via .enumerate(), forwarded as `i as f64`", async () => {
    const src = `const nums: Array<number> = [10, 20, 30];
const r: Array<number> = nums.map((x, i) => x + i);
console.log(r[0], r[1], r[2]);`;
    await behaves(src, "10 21 32");
    const rust = compile(src);
    expect(rust).toContain("fn __cb_map_1(x: f64, i: f64) -> f64");
    expect(rust).toContain(".iter().enumerate().map(|(i, x)| __cb_map_1(*x, i as f64))");
  });

  test("IDX2 bare index element", async () => {
    await behaves(
      `const nums: Array<number> = [10, 20, 30];
const r: Array<number> = nums.map((x, i) => i);
console.log(r[0], r[1], r[2]);`,
      "0 1 2",
    );
  });

  test("FL1 (fail-loud) whole-array third param `(el, i, arr)`", () => {
    expect(() =>
      compile(`const nums: Array<number> = [1, 2, 3];
const r: Array<number> = nums.map((x, i, arr) => x);
console.log(r[0]);`),
    ).toThrow(UnsupportedError);
  });

  test("FL2 (fail-loud) non-Copy element in reduce", () => {
    expect(() =>
      compile(`const strs: Array<string> = ["a", "b"];
const r: string = strs.reduce((a, s) => a, "");
console.log(r);`),
    ).toThrow(UnsupportedError);
  });

  test("FL3 (fail-loud) unclassifiable element flow (reassigned element)", () => {
    expect(() =>
      compile(`const strs: Array<string> = ["a", "b"];
const r: Array<string> = strs.map(s => (s += "x"));
console.log(r[0]);`),
    ).toThrow(UnsupportedError);
  });
});
