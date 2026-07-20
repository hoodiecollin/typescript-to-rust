/**
 * Specs for series 103b-2 — `i64` for-range promotion + return-type
 * specialization, on top of 103b-1's counter/accumulator retype. Once a
 * pure-integer counter is `i64`, `promoteRanges` lifts it to a typed range
 * (`for i in 0i64..N`, the literal suffix pinning the element type off `i32`), and
 * a function whose only result-use is `Display`/discard specializes its `f64`
 * return to `i64` (dropping 103b-1's `as f64` bridge). The differential harness
 * cargo-compiles and runs each program, so every shape assertion is also a
 * COMPILES/BEHAVES proof. IDs map to docs/work/103-numeric-specialization/specs.md.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("numeric-int-range", [
  {
    name: "NIS1 an i64 counting loop promotes to a typed range",
    src: `let s: number = 0;
for (let i: number = 0; i < 5; i = i + 1) { s = s + i; }
console.log(s);`,
    expected: "10",
    extra: ({ rust }) => {
      expect(rust).toContain("for i in 0i64..5");
      expect(rust).not.toContain("while");
      // The counter's `let`/update are folded into the range.
      expect(rust).not.toContain("let mut i");
    },
  },
  {
    name: "NIS4 return-type specialization when the result is printed",
    src: `function run(): number {
  let a: number = 0;
  for (let i = 0; i < 3; i = i + 1) { a = a + i; }
  return a;
}
console.log(run());`,
    expected: "3",
    extra: ({ rust }) => {
      expect(rust).toContain("fn run() -> i64");
      expect(rust).toContain("return a;");
      expect(rust).not.toContain("as f64");
    },
  },
  {
    name: "NIS4-bail return stays f64 when the result flows into f64 arithmetic",
    // `run() + 0.5` is not a bare `Display` use, so return specialization bails:
    // the function keeps `-> f64` and 103b-1's `as f64` bridge (preferring, sound).
    src: `function run(): number {
  let a: number = 0;
  for (let i = 0; i < 3; i = i + 1) { a = a + i; }
  return a;
}
console.log(run() + 0.5);`,
    expected: "3.5",
    extra: ({ rust }) => {
      expect(rust).toContain("fn run() -> f64");
      expect(rust).toContain("return (a as f64);");
    },
  },
  {
    name: "NIS-desc a descending i64 counter promotes to a reversed typed range",
    src: `let s: number = 0;
for (let i: number = 5; i > 0; i = i - 1) { s = s + i; }
console.log(s);`,
    expected: "15",
    extra: ({ rust }) => {
      expect(rust).toContain("(1i64..=5).rev()");
      expect(rust).not.toContain("while");
    },
  },
]);

test("NIS-usize an index-driven counter still promotes to a usize range (not i64)", () => {
  const src = `const arr: number[] = [10, 20, 30];
let s: number = 0;
for (let i: number = 0; i < arr.length; i = i + 1) { s = s + arr[i]; }
console.log(s);`;
  const rust = compile(src);
  // Index forcing wins `usize`; the range is bare `0..arr.len()`, no `i64` suffix.
  expect(rust).toContain("for i in 0..arr.len()");
  expect(rust).not.toContain("0i64");
});
