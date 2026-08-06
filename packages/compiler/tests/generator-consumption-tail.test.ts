/**
 * Specs for series 075 — the generator consumption tail (issue #39). Graduates the
 * four 065 deferred residuals over the shared `GenStep<Y, R>` tslib enum + the
 * `Steppable` trait + an inherent `step()` on every state-machine generator struct:
 *
 *   - `Array.from(src, fn)` — the mapping overload (any array/iterable source);
 *   - manual `{ value, done }` read (`const { value, done } = it.next()`);
 *   - generator `return <value>` → the `GenStep::Return(R)` payload;
 *   - `yield*` completion value (`const r = yield* inner()`);
 *   - generator array-destructuring (`const [a, b] = g()`, rides 067).
 *
 * Each spec differential-matches (compile → cargo run → TS-via-Bun). IDs map to
 * series 075.
 */

import { expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { lower } from "../src/lower";
import { compile, defineDifferential } from "./_support/differential";

function rejects(src: string, re: RegExp): void {
  expect(() =>
    lower(parseSync("t.ts", src).program as unknown as Program),
  ).toThrow(re);
}

defineDifferential("generator-consumption-tail", [
  {
    name: "AF1 `Array.from(g(), x => x * 2)` maps a generator source",
    src: `function* g(): Generator<number> { yield 1; yield 2; yield 3; }
const a = Array.from(g(), x => x * 2);
console.log(a[0], a[1], a[2]);`,
    expected: "2 4 6",
    extra: ({ rust }) => {
      expect(rust).toContain(".map(");
      expect(rust).toContain(".collect::<Vec<_>>()");
    },
  },
  {
    name: "AF2 `Array.from([1,2,3], (x,i) => x + i)` — array source, index overload",
    src: `const b = Array.from([1, 2, 3], (x, i) => x + i);
console.log(b[0], b[1], b[2]);`,
    expected: "1 3 5",
    extra: ({ rust }) => expect(rust).toContain(".enumerate()"),
  },
  {
    name: "AF3 `Array.from(g(), (x,i) => x + i)` — generator source, index overload",
    src: `function* g(): Generator<number> { yield 10; yield 20; }
const c = Array.from(g(), (x, i) => x + i);
console.log(c[0], c[1]);`,
    expected: "10 21",
    extra: ({ rust }) => expect(rust).toContain(".enumerate()"),
  },
  {
    name: "AF4 `Array.from(g())` (no mapping) still collects (065 regression)",
    src: `function* g(): Generator<number> { yield 5; yield 6; }
const a: Array<number> = Array.from(g());
console.log(a.length, a[0], a[1]);`,
    expected: "2 5 6",
  },
  {
    name: "MN1 `const { value, done } = it.next()` reads the first step",
    src: `function* g(): Generator<number, number> { yield 1; yield 2; return 9; }
const it = g();
const { value, done } = it.next();
console.log(value, done);`,
    expected: "1 false",
    extra: ({ rust }) => {
      expect(rust).toContain("GenStep::Yield");
      expect(rust).toContain("Steppable::step");
    },
  },
  {
    // A generator with no `yield` (just `return 42`): the first `{ value, done }`
    // read is the completion — `value: 42, done: true`. Exercises the terminal
    // `GenStep::Return(R)` payload through the manual `step()` surface.
    name: "MN2 a generator that immediately returns reads `done: true` at the first step",
    src: `function* g(): Generator<number, number> { return 42; }
const it = g();
const { value, done } = it.next();
console.log(value, done);`,
    expected: "42 true",
  },
  {
    name: "MN3 a direct `g().next()` destructure works",
    src: `function* g(): Generator<number, number> { yield 3; return 4; }
const { value, done } = g().next();
console.log(value, done);`,
    expected: "3 false",
  },
  {
    name: "RV1 a `return <value>` generator compiles; for-of drops the value",
    src: `function* g(): Generator<number, number> { yield 1; yield 2; return 9; }
for (const x of g()) { console.log(x); }`,
    expected: "1\n2",
    extra: ({ rust }) => expect(rust).toContain("__ret"),
  },
  {
    name: "RV2 an inferred `R` (no 2nd type arg) compiles",
    src: `function* g(): Generator<number> { yield 5; return 6; }
for (const x of g()) { console.log(x); }`,
    expected: "5",
  },
  {
    name: "YR1 `const r = yield* inner()` binds the completion value",
    src: `function* inner(): Generator<number, number> { yield 1; yield 2; return 99; }
function* outer(): Generator<number, number> {
  yield 0;
  const r = yield* inner();
  yield r;
  return 0;
}
for (const x of outer()) { console.log(x); }`,
    expected: "0\n1\n2\n99",
    extra: ({ rust }) => expect(rust).toContain("dyn tslib::gen::Steppable"),
  },
  {
    name: "GD1 `const [a, b] = pair()` pulls a fixed-arity prefix",
    src: `function* pair(): Generator<number> { yield 10; yield 20; yield 30; }
const [a, b] = pair();
console.log(a, b);`,
    expected: "10 20",
    extra: ({ rust }) => expect(rust).toContain(".next().unwrap()"),
  },
  {
    name: "REG1 `[...g()]` still collects to a Vec",
    src: `function* g(): Generator<number> { yield 1; yield 2; yield 3; }
const arr: Array<number> = [...g()];
console.log(arr.length, arr[0], arr[2]);`,
    expected: "3 1 3",
  },
  {
    name: "REG3 plain for-of over a state-machine generator is unchanged",
    src: `function* range(n: number): Generator<number> {
  let i: number = 0;
  while (i < n) { yield i; i = i + 1; }
}
for (const x of range(3)) { console.log(x); }`,
    expected: "0\n1\n2",
  },
]);

test("MN4 fail-loud: binding the whole `it.next()` result", () => {
  const src = `function* g(): Generator<number, number> { yield 1; return 2; }
const it = g();
const s = it.next();
console.log(s.value);`;
  rejects(src, /without a type annotation/);
});

test("MN5 fail-loud: renamed `{ value, done }` destructure (shorthand only)", () => {
  const src = `function* g(): Generator<number, number> { yield 1; return 2; }
const it = g();
const { value: v, done: d } = it.next();`;
  rejects(src, /shorthand/);
});

test("YR2 `yield*` with the result unread keeps 065's `dyn Iterator` box", () => {
  const src = `function* inner(): Generator<number> { yield 1; yield 2; }
function* outer(): Generator<number> { yield 0; yield* inner(); yield 3; }
for (const x of outer()) { console.log(x); }`;
  const rust = compile(src);
  expect(rust).toContain("Box<dyn Iterator<Item = f64>>");
  expect(rust).not.toContain("dyn tslib::gen::Steppable");
});

test("YR3 fail-loud: read `yield*` over a non-generator iterable", () => {
  const src = `function* outer(): Generator<number> {
  const r = yield* [1, 2, 3];
  yield r;
}
for (const x of outer()) { console.log(x); }`;
  rejects(src, /non-generator iterable/);
});

test("GD2 fail-loud: rest element `const [a, ...rest] = g()`", () => {
  // Series 097 allows array rest over a Vec *variable*, not over a generator call
  // (a non-identifier source) — still fail-loud, bind it to a variable first.
  const src = `function* g(): Generator<number> { yield 1; yield 2; yield 3; }
const [a, ...rest] = g();`;
  rejects(src, /rest|non-identifier|destructuring/i);
});
