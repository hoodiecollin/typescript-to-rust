/**
 * Specs for series 111 (#88) — `.length` → `f64` coercion. `arr.length` /
 * `str.length` lower to a `usize` `.len()` / `.chars().count()`; in an `f64` context
 * (a `number` binding, a `return`, arithmetic, an argument) the numeric pass now tags
 * the `len` node so it emits `(… as f64)`. This graduates away the old restriction that
 * counts had to go through a `for…of` counter. Crucially, a `.length` in a **usize
 * slot** (an array index, a range bound, a usize comparison) must stay a bare `usize`
 * `.len()`, or working index loops would regress — the LB* cases pin that.
 *
 * The differential harness cargo-compiles and runs each program, so every assertion is
 * also a COMPILES/BEHAVES proof; output is byte-identical to node/bun. IDs map to
 * series 111.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("length-f64", [
  // ── f64 contexts: `.length` now type-checks as a `number` ────────────────────
  {
    name: "LF1 number binding — const n: number = arr.length",
    src: `function run(): number {
  const arr: string[] = ["a", "b", "c"];
  const n: number = arr.length;
  return n;
}
console.log(run());`,
    expected: "3",
    extra: ({ rust }) => {
      expect(rust).toMatch(/let n: f64 = \(arr\.len\(\) as f64\)/);
    },
  },
  {
    name: "LF2 direct return of a length",
    src: `function run(): number {
  const arr: number[] = [10, 20];
  return arr.length;
}
console.log(run());`,
    expected: "2",
    extra: ({ rust }) => {
      expect(rust).toMatch(/return \(arr\.len\(\) as f64\)/);
    },
  },
  {
    name: "LF3 arithmetic with a length (f64 domain)",
    src: `function run(): number {
  const arr: number[] = [1, 2, 3, 4];
  return arr.length / 2 + 1;
}
console.log(run());`,
    expected: "3",
    extra: ({ rust }) => {
      expect(rust).toMatch(/\(arr\.len\(\) as f64\)/);
    },
  },
  {
    name: "LF4 string length (chars) in an f64 context",
    src: `function run(): number {
  const s: string = "hello";
  const n: number = s.length;
  return n + 0;
}
console.log(run());`,
    expected: "5",
    extra: ({ rust }) => {
      expect(rust).toMatch(/\(s\.chars\(\)\.count\(\) as f64\)/);
    },
  },
  {
    name: "LF5 length passed as a number argument",
    src: `function size(n: number): number {
  return n * 10;
}
function run(): number {
  const arr: string[] = ["x", "y", "z"];
  return size(arr.length);
}
console.log(run());`,
    expected: "30",
    extra: ({ rust }) => {
      expect(rust).toMatch(/size\(\(arr\.len\(\) as f64\)\)/);
    },
  },
  {
    name: "LF6 length compared to a fractional literal",
    src: `function run(): number {
  const arr: number[] = [1, 2, 3];
  if (arr.length > 2.5) {
    return 1;
  }
  return 0;
}
console.log(run());`,
    expected: "1",
    extra: ({ rust }) => {
      expect(rust).toMatch(/\(arr\.len\(\) as f64\) > 2\.5/);
    },
  },

  // ── usize slots: `.length` MUST stay a bare `usize` (no regression) ───────────
  {
    name: "LB1 length as a for-range bound stays a bare usize",
    src: `function run(): number {
  const arr: number[] = [5, 6, 7, 8];
  let sum: number = 0;
  for (let i: number = 0; i < arr.length; i = i + 1) {
    sum = sum + arr[i];
  }
  return sum;
}
console.log(run());`,
    expected: "26",
    extra: ({ rust }) => {
      expect(rust).toMatch(/for i in 0\.\.arr\.len\(\)/);
      expect(rust).not.toMatch(/arr\.len\(\) as f64/);
    },
  },
  {
    name: "LB2 length used as both a bound AND an f64 return",
    src: `function run(): number {
  const arr: number[] = [2, 4, 6];
  let sum: number = 0;
  for (let i: number = 0; i < arr.length; i = i + 1) {
    sum = sum + arr[i];
  }
  const count: number = arr.length;
  return sum + count;
}
console.log(run());`,
    expected: "15",
    extra: ({ rust }) => {
      // The bound stays bare; the separate count use is cast.
      expect(rust).toMatch(/for i in 0\.\.arr\.len\(\)/);
      expect(rust).toMatch(/let count: f64 = \(arr\.len\(\) as f64\)/);
    },
  },
  {
    name: "LB3 length minus one as an index stays usize",
    src: `function run(): number {
  const arr: number[] = [3, 6, 9, 12];
  return arr[arr.length - 1];
}
console.log(run());`,
    expected: "12",
    extra: ({ rust }) => {
      expect(rust).toMatch(/arr\[arr\.len\(\) - 1\]/);
      expect(rust).not.toMatch(/as f64/);
    },
  },
]);

// Emit-only: a while-loop bound (un-promoted) keeps `.length` a bare usize.
test("LB4 un-promoted while bound keeps `.length` a bare usize", () => {
  const rust = compile(`function run(): number {
  const arr: number[] = [1, 2, 3];
  let i: number = 0;
  let sum: number = 0;
  while (i < arr.length) {
    sum = sum + arr[i];
    i = i + 2;
  }
  return sum;
}
console.log(run());`);
  expect(rust).toMatch(/i < arr\.len\(\)/);
  expect(rust).not.toMatch(/arr\.len\(\) as f64/);
});
