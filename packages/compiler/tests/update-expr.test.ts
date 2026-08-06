/**
 * Specs for series 096 — `++` / `--` (`UpdateExpression`) → Rust `+= 1` / `-= 1`.
 * Design + spec IDs: series 096. Differentials
 * (emitted Rust runs; stdout === TS-via-Bun) unless a plain `test()` fail-loud pin.
 *
 * Covers: statement position (local/field/index, prefix & postfix, for-update
 * up & down, nested block); and full value position (postfix old-value, prefix
 * new-value, loop test, return, array index, call arg); plus the value-position
 * non-identifier-target fail-loud boundary.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("update-expr", [
  // ── statement position ─────────────────────────────────────────────────────
  {
    name: "UPD1 postfix increment statement",
    src: `let x: number = 5;
x++;
console.log(x);`,
    expected: "6",
  },
  {
    name: "UPD2 postfix decrement statement",
    src: `let x: number = 5;
x--;
console.log(x);`,
    expected: "4",
  },
  {
    name: "UPD3 for-loop counting up with i++",
    src: `let sum: number = 0;
for (let i = 0; i < 3; i++) {
  sum += i;
}
console.log(sum);`,
    expected: "3",
  },
  {
    name: "UPD4 for-loop counting down with i--",
    src: `let sum: number = 0;
for (let i = 3; i > 0; i--) {
  sum += i;
}
console.log(sum);`,
    expected: "6",
  },
  {
    name: "UPD5 field increment this.n++ in a method",
    src: `class Counter {
  n: number = 0;
  bump(): void { this.n++; }
}
const c: Counter = new Counter();
c.bump();
c.bump();
console.log(c.n);`,
    expected: "2",
  },
  {
    name: "UPD6 index element increment a[0]++ statement",
    src: `const a: number[] = [10, 20];
a[0]++;
console.log(a[0]);`,
    expected: "11",
  },
  {
    name: "UPD7 prefix increment statement (same effect as postfix)",
    src: `let x: number = 5;
++x;
console.log(x);`,
    expected: "6",
  },
  {
    name: "UPD8 increment in a while-body statement",
    src: `let x: number = 0;
let k: number = 0;
while (k < 3) {
  x++;
  k++;
}
console.log(x);`,
    expected: "3",
  },

  // ── value position: postfix old / prefix new ───────────────────────────────
  {
    name: "UPD9 postfix value yields the old value",
    src: `let x: number = 5;
const y: number = x++;
console.log(y, x);`,
    expected: "5 6",
  },
  {
    name: "UPD10 prefix value yields the new value",
    src: `let x: number = 5;
const y: number = ++x;
console.log(y, x);`,
    expected: "6 6",
  },
  {
    name: "UPD11 postfix value in a loop test (while n-- > 0)",
    src: `let n: number = 3;
let out: number = 0;
while (n-- > 0) {
  out++;
}
console.log(out, n);`,
    expected: "3 -1",
  },
  {
    name: "UPD12 postfix value as a return expression",
    src: `function f(): number {
  let x: number = 7;
  return x++;
}
console.log(f());`,
    expected: "7",
  },
  {
    name: "UPD13 postfix value as an array index",
    src: `const arr: number[] = [10, 20, 30];
let i: number = 0;
const first: number = arr[i++];
console.log(first, i);`,
    expected: "10 1",
    extra: ({ rust }) => expect(rust).toContain("usize"),
  },
  {
    name: "UPD14 postfix value as a call argument",
    src: `function dbl(v: number): number { return v * 2; }
let i: number = 4;
console.log(dbl(i++), i);`,
    expected: "8 5",
  },
]);

test("UPD-FL1 value-position ++ on an index target is fail-loud", () => {
  const src = `const a: number[] = [1];
const y: number = a[0]++;
console.log(y);`;
  expect(() => compile(src)).toThrow(
    /non-identifier target in a value position/,
  );
});

test("UPD-FL2 value-position ++ on a field target is fail-loud", () => {
  const src = `class C { n: number = 1; }
const c: C = new C();
const y: number = c.n++;
console.log(y);`;
  expect(() => compile(src)).toThrow(
    /non-identifier target in a value position/,
  );
});
