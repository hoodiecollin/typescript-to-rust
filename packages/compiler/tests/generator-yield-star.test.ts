/**
 * Specs for series 065 — generator `yield*` delegation & non-`for-of` collecting
 * consumption. Rides the 052 state machine: `yield* <iter>` becomes a delegating
 * state (a boxed `Iterator` field pumped to exhaustion); `[...g()]` and
 * `Array.from(g())` collect an `impl Iterator` into a `Vec`. Manual `.next()`
 * stays fail-loud (pull-only `Option<T>`, no `{value, done}`).
 *
 * Each spec differential-matches (compile → cargo run → TS-via-Bun). IDs map to
 * series 065.
 */

import { expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { lower } from "../src/lower";
import { defineDifferential } from "./_support/differential";

function rejects(src: string, re: RegExp): void {
  expect(() =>
    lower(parseSync("t.ts", src).program as unknown as Program),
  ).toThrow(re);
}

defineDifferential("generator-yield-star", [
  {
    name: "YS1 `yield* inner()` delegates to another generator",
    src: `function* inner(): Generator<number> { yield 1; yield 2; }
function* outer(): Generator<number> { yield 0; yield* inner(); yield 3; }
for (const x of outer()) { console.log(x); }`,
    expected: "0\n1\n2\n3",
    extra: ({ rust }) => {
      expect(rust).toContain("Box<dyn Iterator<Item = f64>>");
      expect(rust).toContain("inner().into_iter()");
    },
  },
  {
    name: "YS2 `yield* [array]` delegates to a non-generator iterable",
    src: `function* g(): Generator<number> { yield 10; yield* [20, 30]; yield 40; }
for (const x of g()) { console.log(x); }`,
    expected: "10\n20\n30\n40",
  },
  {
    name: "YS3 chained `yield*` compose",
    src: `function* a(): Generator<number> { yield 1; }
function* b(): Generator<number> { yield* a(); yield 2; }
function* c(): Generator<number> { yield* b(); yield 3; }
let sum: number = 0;
for (const x of c()) { sum = sum * 10 + x; }
console.log(sum);`,
    expected: "123",
  },
  {
    name: "CON1 `[...g()]` collects a generator into a `Vec`",
    src: `function* g(): Generator<number> { yield 5; yield 6; yield 7; }
const arr: Array<number> = [...g()];
console.log(arr.length, arr[0], arr[2]);`,
    expected: "3 5 7",
    extra: ({ rust }) => expect(rust).toContain(".collect::<Vec<_>>()"),
  },
  {
    name: "CON2 `Array.from(g())` collects a generator into a `Vec`",
    src: `function* g(): Generator<number> { yield 1; yield 2; }
const arr: Array<number> = Array.from(g());
let sum: number = 0;
for (const x of arr) { sum = sum + x; }
console.log(arr.length, sum);`,
    expected: "2 3",
    extra: ({ rust }) => expect(rust).toContain(".collect::<Vec<_>>()"),
  },
]);

test("FL1 manual generator `.next()` is fail-loud", () => {
  rejects(
    `function* g(): Generator<number> { yield 1; }
g().next();`,
    /next|pull-only|Iterator/i,
  );
});
