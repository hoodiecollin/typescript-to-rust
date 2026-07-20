/**
 * Specs for series 103a/103b-1 — integer-domain modulo. After 103b-1 retypes a
 * pure-integer counter/accumulator to `i64`, its modulo is a *native* `i % 3`
 * (no cast). 103a's local `((x as i64) % k) as f64` remains only as the fallback
 * for an integer-valued `%` whose binding could not retype (it mixes with `f64`).
 * Either way the libm `fmod` is gone. IDs map to
 * docs/work/103-numeric-specialization/specs.md.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("numeric-int-modulo", [
  {
    name: "NIM1 integer counter loop → native i64 modulo (103b-1)",
    src: `let hits: number = 0;
for (let i: number = 0; i < 10; i = i + 1) {
  if (i % 3 === 0) { hits = hits + 1; }
}
console.log(hits);`,
    expected: "4",
    extra: ({ rust }) => {
      // The `i64` counter also lifts to a typed range (series 103b-2).
      expect(rust).toContain("for i in 0i64..10");
      expect(rust).toContain("i % 3 == 0");
      expect(rust).not.toContain("as i64");
      expect(rust).not.toContain("i % 3.0");
    },
  },
  {
    name: "NIM2 accumulator loop retypes fully → no casts (103b-1)",
    src: `let acc: number = 0;
for (let i: number = 0; i < 6; i = i + 1) {
  if (i % 2 === 0) { acc = acc + i; }
}
console.log(acc);`,
    expected: "6",
    extra: ({ rust }) => {
      expect(rust).toContain("let mut acc: i64 = 0");
      expect(rust).toContain("i % 2 == 0");
      expect(rust).not.toContain("as f64");
      expect(rust).not.toContain("as i64");
    },
  },
  {
    name: "NIM3 fractional operand is left as an f64 remainder",
    src: `const x: number = 1.5;
console.log(x % 1.0);`,
    expected: "0.5",
    extra: ({ rust }) => {
      expect(rust).toContain("x % 1.0");
      expect(rust).not.toContain("as i64");
    },
  },
  {
    name: "NIM4 loopsum shape — native integer modulo, identical checksum",
    src: `let acc: number = 0;
for (let i: number = 0; i < 100; i = i + 1) {
  if (i % 3 === 0) { acc = acc + i; } else { acc = acc - 1; }
}
console.log(acc);`,
    expected: "1617",
    extra: ({ rust }) => {
      expect(rust).toContain("i % 3 == 0");
      expect(rust).not.toContain("fmod");
    },
  },
  {
    name: "NIM6 non-retypeable integer % keeps the 103a intDomain fallback",
    // `i` mixes into `(i % 3) * 0.5` (f64), so it cannot retype to i64 — but the
    // modulo operands are still integer-valued, so 103a re-expresses it locally.
    src: `let sum: number = 0;
for (let i: number = 0; i < 10; i = i + 1) {
  sum = sum + (i % 3) * 0.5;
}
console.log(sum);`,
    expected: "4.5",
    extra: ({ rust }) => {
      expect(rust).toContain("(i as i64) % 3");
      expect(rust).toContain(") as f64");
    },
  },
]);

test("NIM5 an index-driven modulo is left to the usize pass (no i64 cast)", () => {
  const src = `const arr: number[] = [10, 20, 30];
let s: number = 0;
for (let i: number = 0; i < 6; i = i + 1) {
  s = s + arr[i % 3];
}
console.log(s);`;
  const rust = compile(src);
  // `i % 3` sits in usize index context → usize modulo, not the 103a i64 rewrite.
  expect(rust).not.toContain("as i64");
});
