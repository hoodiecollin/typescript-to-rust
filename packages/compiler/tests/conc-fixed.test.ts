/**
 * Specs for series 051a — fixed-arity async-concurrency combinators (CONC1–9).
 * Under `await`, three shapes map onto tokio macros:
 *
 *   - `asyncFn(...).then(cb)` (non-async single-expr `cb`) → a sequential `await`
 *     of the receiver applied to a lifted `fn __cb_then_<n>` (no `.then` output).
 *   - `Promise.all([a(), b(), …])` (fixed-arity array literal) → `tokio::join!`
 *     (a tuple), or `tokio::try_join!(…)?` when any element is fallible.
 *   - `Promise.race([a(), b(), …])` → `tokio::select!` (first to complete).
 *
 * Differential specs (CONC3, CONC5, CONC7) assert Rust stdout === TS stdout ===
 * expected; substring specs (CONC1, CONC2, CONC4, CONC6) pin the tokio shape;
 * CONC8/CONC9 are fail-loud. IDs map to series 051.
 *
 * Fixture adjustments (noted): CONC1's callback is `x => x + 1` (a numeric-surface
 * body) rather than the illustrative `row => row.length` — the lift's callback
 * typer supports the numeric surface only, and `.length` is not liftable; the
 * spec's intent (a non-async single-expr `cb` lifts + the `.then` desugars) is
 * unchanged. Tuple-destructure bindings omit the `[T, T]` annotation (a
 * `TSTupleType` is not in the dialect); Rust infers the `join!` tuple.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("conc-fixed", [
  {
    name: "CONC3 (differential) `join!` yields both results, order preserved",
    src: `async function one(): Promise<number> { return 1; }
async function two(): Promise<number> { return 2; }
async function run(): Promise<void> {
  const [a, b] = await Promise.all([one(), two()]);
  console.log(a, b);
}
await run();`,
    expected: "1 2",
  },
  {
    // Both TS and Rust surface the rejection: nothing prints before the error.
    // The program errors out (a propagated rejection); no "1 2" is printed.
    name: "CONC5 (differential) `try_join!` short-circuits on the first Err",
    src: `async function ok(): Promise<number> {
  if (false) { throw new Error("no"); }
  return 1;
}
async function boom(): Promise<number> {
  if (true) { throw new Error("boom"); }
  return 2;
}
async function run(): Promise<void> {
  const [a, b] = await Promise.all([ok(), boom()]);
  console.log(a, b);
}
await run();`,
    // The program *errors out* (a propagated rejection / `try_join!` short-circuit)
    // — a non-zero exit on BOTH sides, so `expectFail` (not a plain ok-differential),
    // with the extra pinning the "nothing is printed" intent (no "1 2").
    expectFail: true,
    extra: ({ result }) => expect(result.stdout.trim()).toBe(""),
  },
  {
    // Both futures resolve immediately. tokio's `select!` picks a *random* ready
    // arm (JS `race` picks the first-settled), so the winner's identity is not
    // portable across runtimes — the documented `race`-drops-losers divergence.
    // To keep the differential deterministic (Rust stdout === TS stdout) while
    // still exercising "a winner wins, the loser is dropped", both arms resolve
    // to the SAME value: whichever the runtime selects, the printed value matches.
    // (Fixture adjustment noted in the file header vs. the spec's `fast`-wins
    // phrasing — the intent, one arm's value surfaces, is unchanged.)
    name: "CONC7 (differential) `race` yields a winner's value, loser dropped",
    src: `async function fast(): Promise<number> { return 42; }
async function slow(): Promise<number> { return 42; }
async function run(): Promise<void> {
  const w: number = await Promise.race([fast(), slow()]);
  console.log(w);
}
await run();`,
    expected: "42",
  },
]);

test("CONC1 `.then(cb)` lifts the cb and desugars to a sequential await", () => {
  const src = `async function fetchNum(id: number): Promise<number> { return 5; }
async function run(): Promise<void> {
  const n: number = await fetchNum(1).then(x => x + 1);
  console.log(n);
}
await run();`;
  const rust = compile(src);
  expect(rust).toContain(".await");
  expect(rust).toContain("fn __cb_then");
  expect(rust).not.toContain(".then");
  // The desugar applies the lifted cb to the awaited receiver.
  expect(rust).toContain("__cb_then_1(fetchNum(1.0).await)");
});

test("CONC2 `Promise.all([a(), b()])` → `tokio::join!` + tuple destructure", () => {
  const src = `async function getA(): Promise<number> { return 1; }
async function getB(): Promise<number> { return 2; }
async function run(): Promise<void> {
  const [a, b] = await Promise.all([getA(), getB()]);
  console.log(a, b);
}
await run();`;
  const rust = compile(src);
  expect(rust).toContain("tokio::join!(getA(), getB())");
  expect(rust).toContain("let (a, b) =");
});

test("CONC4 a fallible `Promise.all` → `tokio::try_join!(` + `?`", () => {
  const src = `async function getA(): Promise<number> {
  if (false) { throw new Error("no"); }
  return 1;
}
async function getB(): Promise<number> {
  if (false) { throw new Error("no"); }
  return 2;
}
async function run(): Promise<void> {
  const [a, b] = await Promise.all([getA(), getB()]);
  console.log(a, b);
}
await run();`;
  const rust = compile(src);
  expect(rust).toContain("tokio::try_join!(");
  expect(rust).toContain("?");
  // The enclosing fn is fallible → returns a Result.
  expect(rust).toContain("async fn run() -> Result<");
});

test("CONC6 `Promise.race([a(), b()])` → `tokio::select!` with one arm per future", () => {
  const src = `async function slow(): Promise<number> { return 1; }
async function fast(): Promise<number> { return 2; }
async function run(): Promise<void> {
  const w: number = await Promise.race([slow(), fast()]);
  console.log(w);
}
await run();`;
  const rust = compile(src);
  expect(rust).toContain("tokio::select!");
  expect(rust).toContain("res = slow() => res");
  expect(rust).toContain("res = fast() => res");
});

test("CONC8 (fail-loud) a heterogeneous `Promise.race` is UnsupportedError", () => {
  const src = `async function num(): Promise<number> { return 1; }
async function str(): Promise<string> { return "x"; }
async function run(): Promise<void> {
  const w: number = await Promise.race([num(), str()]);
  console.log(w);
}
await run();`;
  expect(() => compile(src)).toThrow(/heterogeneous Promise.race/);
});

test("CONC9 (fail-loud) a two-arg `.then(onOk, onErr)` is UnsupportedError", () => {
  const src = `async function fetchNum(id: number): Promise<number> { return 5; }
async function run(): Promise<void> {
  const n: number = await fetchNum(1).then(x => x + 1, e => 0);
  console.log(n);
}
await run();`;
  expect(() => compile(src)).toThrow(/reject handler/);
});
