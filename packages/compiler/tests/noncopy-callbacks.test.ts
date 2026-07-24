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

import { expect, test } from "bun:test";
import { UnsupportedError } from "../src/errors";
import { compile, defineDifferential } from "./_support/differential";

const POINT = `interface Point { x: number; y: number; }
const pts: Array<Point> = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
`;

defineDifferential("noncopy-callbacks", [
  {
    name: "NCB1 read-only struct element → &T param, no clone (map)",
    src: `${POINT}const r: Array<number> = pts.map(p => p.x + p.y);
console.log(r[0], r[1]);`,
    expected: "3 7",
    extra: ({ rust }) => {
      expect(rust).toContain("fn __cb_map_1(p: &Point) -> f64");
      expect(rust).toContain(".iter().map(|p| __cb_map_1(p))");
      expect(rust).not.toContain(".clone()");
    },
  },
  {
    name: "NCB2 read-only struct predicate → &T param, .cloned() terminal (filter)",
    src: `${POINT}const r: Array<Point> = pts.filter(p => p.x > 2);
console.log(r.length);`,
    expected: "1",
    extra: ({ rust }) => {
      expect(rust).toContain("fn __cb_filter_1(p: &Point) -> bool");
      expect(rust).toContain(".iter().filter(|p| __cb_filter_1(*p))");
      expect(rust).toContain(".cloned()");
      expect(rust).not.toContain(".copied()");
    },
  },
  {
    name: "NCB3 consumed String element → owned String, .clone() at the shim (map)",
    src: `const strs: Array<string> = ["a", "b"];
const r: Array<string> = strs.map(s => s);
console.log(r[0], r[1]);`,
    expected: "a b",
    extra: ({ rust }) => {
      expect(rust).toContain("fn __cb_map_1(s: String) -> String");
      expect(rust).toContain(".iter().map(|s| __cb_map_1(s.clone()))");
    },
  },
  {
    name: "NCB4 consumed struct element → owned T, .clone() (map)",
    src: `${POINT}const r: Array<Point> = pts.map(p => p);
console.log(r[0].x, r[1].y);`,
    expected: "1 4",
    extra: ({ rust }) => {
      expect(rust).toContain("fn __cb_map_1(p: Point) -> Point");
      expect(rust).toContain(".iter().map(|p| __cb_map_1(p.clone()))");
    },
  },
  {
    name: "NCB5 read-only struct predicate → .any(), borrow (some)",
    src: `${POINT}console.log(pts.some(p => p.x > 2));`,
    expected: "true",
    extra: ({ rust }) => expect(rust).toContain(".iter().any(|p| __cb_some_1(p))"),
  },
  {
    name: "NCB6 read-only struct predicate → .cloned(), borrow (find)",
    src: `${POINT}console.log(pts.find(p => p.x > 2) !== undefined);`,
    expected: "true",
    extra: ({ rust }) => {
      expect(rust).toContain("fn __cb_find_1(p: &Point) -> bool");
      expect(rust).toContain(".iter().find(|p| __cb_find_1(*p)).cloned()");
    },
  },
  {
    name: "IDX1 index param via .enumerate(), forwarded as `i as f64`",
    src: `const nums: Array<number> = [10, 20, 30];
const r: Array<number> = nums.map((x, i) => x + i);
console.log(r[0], r[1], r[2]);`,
    expected: "10 21 32",
    extra: ({ rust }) => {
      expect(rust).toContain("fn __cb_map_1(x: f64, i: f64) -> f64");
      expect(rust).toContain(".iter().enumerate().map(|(i, x)| __cb_map_1(*x, i as f64))");
    },
  },
  {
    name: "IDX2 bare index element",
    src: `const nums: Array<number> = [10, 20, 30];
const r: Array<number> = nums.map((x, i) => i);
console.log(r[0], r[1], r[2]);`,
    expected: "0 1 2",
  },
]);

test("FL1 (fail-loud) whole-array third param `(el, i, arr)`", () => {
  expect(() =>
    compile(`const nums: Array<number> = [1, 2, 3];
const r: Array<number> = nums.map((x, i, arr) => x);
console.log(r[0]);`),
  ).toThrow(UnsupportedError);
});

// Graduated by series 115 (#96): `reduce` over a non-Copy element type now borrows
// the element (like map/filter), so this compiles instead of failing loud. Was FL2.
// Cargo-backed differential coverage lives in `noncopy-adapters.test.ts` (NC1–NC3).
test("reduce over a non-Copy element compiles (graduated, series 115)", () => {
  expect(() =>
    compile(`const strs: Array<string> = ["a", "b"];
const r: string = strs.reduce((a, s) => a, "");
console.log(r);`),
  ).not.toThrow();
});

test("FL3 (fail-loud) unclassifiable element flow (reassigned element)", () => {
  expect(() =>
    compile(`const strs: Array<string> = ["a", "b"];
const r: Array<string> = strs.map(s => (s += "x"));
console.log(r[0]);`),
  ).toThrow(UnsupportedError);
});
