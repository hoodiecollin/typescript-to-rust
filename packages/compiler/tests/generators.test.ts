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

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { DialectError, UnsupportedError, emit } from "../src/emitter";
import { runRust } from "../src/harness";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

function runTs(src: string): string {
  const proc = Bun.spawnSync(["bun", "run", "-"], {
    stdin: new TextEncoder().encode(src),
  });
  return new TextDecoder().decode(proc.stdout).trim();
}

async function behaves(src: string, expected: string): Promise<void> {
  const rust = compile(src);
  const rr = await runRust(rust);
  expect(rr.ok).toBe(true);
  expect(rr.stdout.trim()).toBe(runTs(src));
  expect(rr.stdout.trim()).toBe(expected);
}

describe("025d sync generators → impl Iterator", () => {
  const finite = `function* g(): Generator<number> {
  yield 1;
  yield 2;
  yield 3;
}
for (const x of g()) {
  console.log(x);
}`;

  test("a finite-yield generator, consumed by for-of, behaves", async () => {
    await behaves(finite, "1\n2\n3");
  });

  test("emits `impl Iterator` + `into_iter()`, and for-of has no `.iter()`", () => {
    const rust = compile(finite);
    expect(rust).toContain("fn g() -> impl Iterator<Item = f64>");
    expect(rust).toContain("vec![1.0, 2.0, 3.0].into_iter()");
    expect(rust).toContain("for x in g() {");
    expect(rust).not.toContain("g().iter()");
  });

  test("a generator with a parameter captures it into the yielded sequence", async () => {
    await behaves(
      `function* g(n: number): Generator<number> {
  yield n;
  yield n * 2;
  yield n * 3;
}
for (const x of g(5)) {
  console.log(x);
}`,
      "5\n10\n15",
    );
  });

  test("a non-yield statement interleaved with a yield now behaves (state machine, series 052)", async () => {
    await behaves(
      `function* g(): Generator<number> {
  console.log("side effect");
  yield 1;
}
for (const x of g()) { console.log(x); }`,
      "side effect\n1",
    );
  });

  test("a yield inside a loop now behaves (state machine, series 052)", async () => {
    await behaves(
      `function* g(): Generator<number> {
  for (let i = 0; i < 3; i = i + 1) {
    yield i;
  }
}
for (const x of g()) { console.log(x); }`,
      "0\n1\n2",
    );
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
});
