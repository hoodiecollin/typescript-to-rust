/**
 * Specs for series 064 — control-flow refinements. Six idiomatic-emit graduations
 * over already-correct lowerings (no dialect fork): switch or-patterns
 * (`1 | 2 =>`), string scrutinee (`match s { "a" => … }`) + range-literal arms
 * (`1..=5 =>`), native `continue` inside a range-`for`, descending / step ranges
 * (`(1..=n).rev()`, `.step_by(2)`), for-of element ownership (`&mut xs`) +
 * destructuring (`for Point { x, y } in …`), and labeled `break`/`continue`.
 *
 * Each spec differential-matches (compile → cargo run → TS-via-Bun) and pins the
 * refined emitted shape. The dialect writes loop updates as `i = i + 1` (no
 * `++`/`--`). IDs map to series 064.
 */

import { expect } from "bun:test";
import { defineDifferential } from "./_support/differential";

const POINT = `interface Point { x: number; y: number; }
const pts: Array<Point> = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
`;

defineDifferential("control-flow-refinements", [
  {
    name: "CF1 stacked cases fold to an or-pattern `1 | 2 =>`",
    src: `function classify(n: number): string {
  switch (n) { case 1: case 2: return "low"; case 3: return "mid"; default: return "hi"; }
}
console.log(classify(1), classify(2), classify(3), classify(9));`,
    expected: "low low mid hi",
    extra: ({ rust }) => expect(rust).toContain("1 | 2 =>"),
  },
  {
    name: "CF2 a contiguous run folds to a range-literal arm `1..=5 =>`",
    src: `function band(n: number): string {
  switch (n) { case 1: case 2: case 3: case 4: case 5: return "lo"; default: return "hi"; }
}
console.log(band(3), band(7));`,
    expected: "lo hi",
    extra: ({ rust }) => expect(rust).toContain("1..=5 =>"),
  },
  {
    name: 'CF3 string scrutinee → `match s { "r" => … }` (no guard)',
    src: `function color(s: string): string {
  switch (s) { case "r": return "red"; case "g": return "green"; default: return "?"; }
}
console.log(color("r"), color("g"), color("b"));`,
    expected: "red green ?",
    extra: ({ rust }) => {
      expect(rust).toContain("match s {");
      expect(rust).toContain('"r" =>');
    },
  },
  {
    name: 'CF4 string stacked cases → string or-pattern `"a" | "e" | "i"`',
    src: `function vowel(s: string): boolean {
  switch (s) { case "a": case "e": case "i": return true; default: return false; }
}
console.log(vowel("a"), vowel("e"), vowel("z"));`,
    expected: "true true false",
    extra: ({ rust }) => expect(rust).toContain('"a" | "e" | "i" =>'),
  },
  {
    name: "CF5 native `continue` inside a range-`for`",
    src: `const xs: Array<number> = [1, 2, 3, 4, 5];
let sum: number = 0;
for (let i = 0; i < xs.length; i = i + 1) { if (xs[i] % 2 === 0) { continue; } sum = sum + xs[i]; }
console.log(sum);`,
    expected: "9",
    extra: ({ rust }) => {
      expect(rust).toContain("for i in 0..xs.len()");
      expect(rust).toContain("continue;");
    },
  },
  {
    name: "CF6 descending loop → `(1..=n).rev()`",
    src: `const xs: Array<number> = [10, 20, 30];
let out: number = 0;
for (let i = 2; i > 0; i = i - 1) { out = out * 10 + xs[i]; }
console.log(out);`,
    expected: "320",
    extra: ({ rust }) => expect(rust).toContain("(1..=2).rev()"),
  },
  {
    name: "CF7 descending inclusive → `(0..=n).rev()`",
    src: `const xs: Array<number> = [10, 20, 30];
let out: number = 0;
for (let i = 2; i >= 0; i = i - 1) { out = out * 10 + xs[i]; }
console.log(out);`,
    expected: "3210",
    extra: ({ rust }) => expect(rust).toContain("(0..=2).rev()"),
  },
  {
    name: "CF8 non-unit step → `.step_by(2)`",
    src: `const xs: Array<number> = [0, 10, 20, 30, 40, 50, 60];
let out: number = 0;
for (let i = 0; i <= 6; i = i + 2) { out = out + xs[i]; }
console.log(out);`,
    expected: "120",
    extra: ({ rust }) => expect(rust).toContain("(0..=6).step_by(2)"),
  },
  {
    name: "CF9 for-of mutating the element in place → `&mut xs`",
    src: `${POINT}for (const p of pts) { p.x = p.x + 10; }
console.log(pts[0].x, pts[1].x);`,
    expected: "11 13",
    extra: ({ rust }) => {
      expect(rust).toContain("let mut pts");
      expect(rust).toContain("for p in &mut pts");
    },
  },
  {
    name: "CF10 for-of named-struct destructuring → `for Point { x, y } in`",
    src: `${POINT}let sum: number = 0;
for (const { x, y } of pts) { sum = sum + x + y; }
console.log(sum);`,
    expected: "10",
    extra: ({ rust }) => expect(rust).toContain("for Point { x, y } in"),
  },
  {
    name: "CF11 a read-only for-of still borrows (`.iter()`, unchanged)",
    src: `${POINT}let sum: number = 0;
for (const p of pts) { sum = sum + p.x; }
console.log(sum);`,
    expected: "4",
    extra: ({ rust }) => {
      expect(rust).toContain("for p in pts.iter()");
      expect(rust).not.toContain("&mut");
    },
  },
  {
    name: "CF12 labeled `break outer` across nested loops",
    src: `let found: number = -1;
outer: for (let i = 0; i < 3; i = i + 1) {
  for (let j = 0; j < 3; j = j + 1) { if (i + j === 3) { found = i * 10 + j; break outer; } }
}
console.log(found);`,
    expected: "12",
    extra: ({ rust }) => {
      expect(rust).toContain("'outer:");
      expect(rust).toContain("break 'outer;");
    },
  },
  {
    name: "CF13 labeled `continue outer` advances the outer loop",
    src: `let count: number = 0;
outer: for (let i = 0; i < 3; i = i + 1) {
  for (let j = 0; j < 3; j = j + 1) { if (j === 1) { continue outer; } count = count + 1; }
}
console.log(count);`,
    expected: "3",
    extra: ({ rust }) => expect(rust).toContain("continue 'outer;"),
  },
]);
