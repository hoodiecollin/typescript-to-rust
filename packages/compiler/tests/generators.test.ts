/**
 * Specs for series 025d — sync generators → `impl Iterator` (first slice).
 *
 * A straight-line finite-yield generator (`function* g(): Generator<T> { yield a;
 * yield b; … }`) lowers to `fn g(…) -> impl Iterator<Item = T> { vec![a, b, …]
 * .into_iter() }` — idiomatic, no state machine. A `for (const x of g())`
 * consumes the returned iterator directly (no `.iter()`, bound by value).
 *
 * State-machine shapes (yield in a loop / branch, `yield*`, async generators) and
 * an un-annotated item type stay fail-loud — a later increment, never a silent
 * miscompile.
 *
 * Differential: emitted Rust compiles AND matches the TS run.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";
import { DialectError, UnsupportedError } from "../src/emitter";

const finite = `function* g(): Generator<number> {
  yield 1;
  yield 2;
  yield 3;
}
for (const x of g()) {
  console.log(x);
}`;

defineDifferential("generators", [
  {
    name: "a finite-yield generator, consumed by for-of, behaves",
    src: finite,
    expected: "1\n2\n3",
  },
  {
    name: "a generator with a parameter captures it into the yielded sequence",
    src: `function* g(n: number): Generator<number> {
  yield n;
  yield n * 2;
  yield n * 3;
}
for (const x of g(5)) {
  console.log(x);
}`,
    expected: "5\n10\n15",
  },
  {
    name: "a non-yield statement interleaved with a yield now behaves (state machine, series 052)",
    src: `function* g(): Generator<number> {
  console.log("side effect");
  yield 1;
}
for (const x of g()) { console.log(x); }`,
    expected: "side effect\n1",
  },
  {
    name: "a yield inside a loop now behaves (state machine, series 052)",
    src: `function* g(): Generator<number> {
  for (let i = 0; i < 3; i = i + 1) {
    yield i;
  }
}
for (const x of g()) { console.log(x); }`,
    expected: "0\n1\n2",
  },
]);

test("emits `impl Iterator` + `into_iter()`, and for-of has no `.iter()`", () => {
  const rust = compile(finite);
  expect(rust).toContain("fn g() -> impl Iterator<Item = f64>");
  expect(rust).toContain("vec![1.0, 2.0, 3.0].into_iter()");
  expect(rust).toContain("for x in g() {");
  expect(rust).not.toContain("g().iter()");
});

test("a generator without a `Generator<T>` return annotation fails loud", () => {
  expect(() =>
    compile(`function* g() {
  yield 1;
}`),
  ).toThrow(UnsupportedError);
});

test("an async generator is rejected (needs Stream, out of std)", () => {
  expect(() =>
    compile(`async function* g(): AsyncGenerator<number> {
  yield 1;
}`),
  ).toThrow(DialectError);
});
