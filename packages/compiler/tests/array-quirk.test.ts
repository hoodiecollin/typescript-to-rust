/**
 * Specs for series 040 — array quirk methods (`sort`/`slice`) routed to the
 * `tslib` fidelity crate (029 Route Tf). `sort` observes JS's default
 * lexicographic *string* compare (and a numeric comparator); `slice` observes
 * JS's clamped, negative-aware, end-exclusive copy. Differential: emitted Rust
 * compiles (linking `tslib`) AND matches the TS run. IDs map to specs.md.
 */

import { describe, expect, test } from "bun:test";
import { UnsupportedError } from "../src/emitter";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("array-quirk", [
  {
    name: "QRK1 default sort is lexicographic string order (quirk)",
    src: `const xs: Array<number> = [10, 1, 2];
xs.sort();
console.log(xs[0], xs[1], xs[2]);`,
    expected: "1 10 2",
    extra: ({ rust }) => expect(rust).toContain("tslib::array::sort_default"),
  },
  {
    name: "QRK2 numeric comparator sorts ascending (differs from default)",
    src: `const xs: Array<number> = [10, 1, 2];
xs.sort((a, b) => a - b);
console.log(xs[0], xs[1], xs[2]);`,
    expected: "1 2 10",
    extra: ({ rust }) => expect(rust).toContain("tslib::array::sort_by"),
  },
  {
    name: "QRK3 numeric comparator sorts descending",
    src: `const xs: Array<number> = [10, 1, 2];
xs.sort((a, b) => b - a);
console.log(xs[0], xs[1], xs[2]);`,
    expected: "10 2 1",
  },
  {
    name: "QRK5 slice(start, end) is start-inclusive, end-exclusive",
    src: `const xs: Array<number> = [1, 2, 3, 4];
const ys: Array<number> = xs.slice(1, 3);
console.log(ys[0], ys[1], ys.length);`,
    expected: "2 3 2",
    extra: ({ rust }) => expect(rust).toContain("tslib::array::slice"),
  },
  {
    name: "QRK6 slice(negativeStart) with end omitted counts from the end",
    src: `const xs: Array<number> = [1, 2, 3, 4];
const ys: Array<number> = xs.slice(-2);
console.log(ys[0], ys[1], ys.length);`,
    expected: "3 4 2",
    extra: ({ rust }) => expect(rust).toContain("tslib::array::slice_from"),
  },
  {
    name: "QRK7 slice clamps an out-of-range end to len",
    src: `const xs: Array<number> = [1, 2, 3, 4];
const ys: Array<number> = xs.slice(1, 100);
console.log(ys.length);`,
    expected: "3",
  },
]);

describe("040 array quirk — sort", () => {
  test("QRK4 sort with a non-arrow argument is fail-loud", () => {
    expect(() =>
      compile(
        `const cmp = 5;\nconst xs: Array<number> = [1, 2];\nxs.sort(cmp);`,
      ),
    ).toThrow(UnsupportedError);
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
