/**
 * Specs for series 097 — destructuring (graduate the binding fail-loud residuals).
 * Design + spec IDs: series 097. Differentials
 * (emitted Rust runs; stdout === TS-via-Bun) unless a plain `test()` fail-loud pin.
 *
 * Covers shapes A–D: array-over-Vec → Option-typed elements (OOB → undefined);
 * renamed object fields; array rest `[a, ...tail]`; object rest `{ x, ...rest }`
 * via anonymous-struct synthesis. Plus the kept fail-loud residuals (defaults,
 * nested patterns, non-named-struct object-rest, unknown element type).
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

const P = `interface P { x: number; y: number; }\n`;
const P3 = `interface P3 { a: number; b: number; c: number; }\n`;

defineDifferential("destructuring", [
  // ── A. array over a Vec variable → Option ──────────────────────────────────
  {
    name: "DS1 array-over-Vec binds Option elements (in-bounds)",
    src: `const arr: number[] = [10, 20, 30];
const [a, b] = arr;
console.log(a, b);`,
    expected: "10 20",
  },
  {
    name: "DS2 out-of-bounds element is undefined (None)",
    src: `const arr: number[] = [10, 20, 30];
const [a, b, c, d] = arr;
console.log(a, b, c, d);`,
    expected: "10 20 30 undefined",
  },
  {
    name: "DS3 Option element consumed via ??",
    src: `const arr: number[] = [10, 20, 30];
const [a] = arr;
console.log(a ?? 0);`,
    expected: "10",
  },
  {
    name: "DS4 Option element narrowed with !== undefined",
    src: `const arr: number[] = [10, 20, 30];
const [x] = arr;
if (x !== undefined) {
  console.log(x + 1);
}`,
    expected: "11",
  },
  {
    name: "DS5 string array elements clone",
    src: `const s: string[] = ["hi", "yo"];
const [a, b] = s;
console.log(a, b);`,
    expected: "hi yo",
  },
  {
    name: "DS6 the source stays usable after destructure",
    src: `const arr: number[] = [10, 20, 30];
const [a, b] = arr;
console.log(a, b, arr.length);`,
    expected: "10 20 3",
  },

  // ── B. renamed object fields ───────────────────────────────────────────────
  {
    name: "DS7 renamed field binds and emits `P { x: px, y }`",
    src: `${P}const p: P = { x: 3, y: 7 };
const { x: px, y } = p;
console.log(px, y);`,
    expected: "3 7",
    extra: ({ rust }) => expect(rust).toContain("P { x: px, y }"),
  },
  {
    name: "DS8 all-renamed fields",
    src: `${P}const p: P = { x: 3, y: 7 };
const { x: a, y: b } = p;
console.log(a, b);`,
    expected: "3 7",
    extra: ({ rust }) => expect(rust).toContain("P { x: a, y: b }"),
  },
  {
    name: "DS9 mixed shorthand + renamed",
    src: `${P}const p: P = { x: 3, y: 7 };
const { x, y: yy } = p;
console.log(x, yy);`,
    expected: "3 7",
    extra: ({ rust }) => expect(rust).toContain("P { x, y: yy }"),
  },

  // ── C. array rest ──────────────────────────────────────────────────────────
  {
    name: "DS10 array rest binds head (Option) + tail (Vec)",
    src: `const arr: number[] = [1, 2, 3];
const [head, ...tail] = arr;
console.log(head, tail.length);`,
    expected: "1 2",
  },
  {
    name: "DS11 rest reaches the empty tail",
    src: `const one: number[] = [5];
const [a, ...rest] = one;
console.log(a, rest.length);`,
    expected: "5 0",
  },
  {
    name: "DS12 the tail is a real Vec (iterate + sum)",
    src: `const arr2: number[] = [1, 2, 3];
const [a, ...t] = arr2;
let s: number = 0;
for (const n of t) {
  s += n;
}
console.log(a ?? 0, s);`,
    expected: "1 5",
  },

  // ── D. object rest (anonymous-struct synthesis) ────────────────────────────
  {
    name: "DS13 object rest synthesizes an anonymous struct",
    src: `${P3}const o: P3 = { a: 1, b: 2, c: 3 };
const { a, ...rest } = o;
console.log(a, rest.b, rest.c);`,
    expected: "1 2 3",
    extra: ({ rust }) => {
      expect(rust).toContain("__anonymous_struct_");
      expect(rust).toContain("let (a, rest) =");
    },
  },
  {
    name: "DS14 identical object-rests dedupe to one synth struct",
    src: `${P3}const o: P3 = { a: 1, b: 2, c: 3 };
const { a, ...r1 } = o;
const { a: a2, ...r2 } = o;
console.log(r1.b, r2.c, a2);`,
    expected: "2 3 1",
    extra: ({ rust }) => {
      const defs = rust.match(/struct __anonymous_struct_/g) ?? [];
      expect(defs.length).toBe(1);
    },
  },
  {
    name: "DS15 object rest with a renamed kept field",
    src: `${P3}const o: P3 = { a: 1, b: 2, c: 3 };
const { a: aa, ...rest } = o;
console.log(aa, rest.b);`,
    expected: "1 2",
  },
  {
    name: "DS16 object rest carrying a non-scalar (String) field",
    src: `interface P4 { a: number; name: string; tag: string; }
const o: P4 = { a: 1, name: "x", tag: "y" };
const { a, ...rest } = o;
console.log(a, rest.name, rest.tag);`,
    expected: "1 x y",
  },
]);

// ── fail-loud residuals ──────────────────────────────────────────────────────
test("DS-FL1 an object default value is fail-loud", () => {
  const src = `interface P { x: number; y: number; }
const p: P = { x: 1, y: 2 };
const { x = 1, y } = p;
console.log(x, y);`;
  expect(() => compile(src)).toThrow(/default|AssignmentPattern|destructuring/i);
});

test("DS-FL2 an array default value is fail-loud", () => {
  const src = `const arr: number[] = [1, 2];
const [a = 0, b] = arr;
console.log(a, b);`;
  expect(() => compile(src)).toThrow(/default|AssignmentPattern|destructuring/i);
});

test("DS-FL3 a nested pattern is fail-loud", () => {
  const src = `interface Inner { x: number; }
interface Outer { p: Inner; }
const o: Outer = { p: { x: 1 } };
const { p: { x } } = o;
console.log(x);`;
  expect(() => compile(src)).toThrow(/nested|destructuring/i);
});

test("DS-FL4 object-rest over a non-named-struct source is fail-loud", () => {
  const src = `const m: Map<string, number> = new Map<string, number>();
const { foo, ...rest } = m;
console.log(rest);`;
  expect(() => compile(src)).toThrow(/non-named-struct|destructuring/i);
});

test("DS-FL5 array-destructure over an unknown element-type source is fail-loud", () => {
  const src = `const n: number = 5;
const [a, b] = n;
console.log(a, b);`;
  expect(() => compile(src)).toThrow(/element type|destructuring/i);
});
