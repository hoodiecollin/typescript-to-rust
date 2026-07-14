/**
 * Specs for series 076 — bidirectional generators (issue #32). Graduates the
 * `gen.next(v)` resume-value deferral over 052's state machine + 075's shared
 * `GenStep<Y, R>` enum, adding a `resume(&mut self, sent: TNext) -> GenStep<Y, R>`
 * inherent method: the send value (value **in**) threads into the resumed `yield`
 * expression (`const x = yield e`). Stable Rust — no nightly `Coroutine`.
 *
 *   - send-value round-trips through `resume` (first `next(x)` discards `x`);
 *   - the dual surface (`impl Iterator` via `resume(<default>)`) when `TNext` is
 *     defaultable (includes `undefined`), so `for-of` still composes;
 *   - fail-loud: non-defaultable `TNext` under for-of; unannotated `TNext` with a
 *     read yield result.
 *
 * Each spec differential-matches (compile → cargo run → TS-via-Bun). IDs map to
 * docs/work/076-bidirectional-generators/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { lower } from "../src/lower";
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

function rejects(src: string, re: RegExp): void {
  expect(() =>
    lower(parseSync("t.ts", src).program as unknown as Program),
  ).toThrow(re);
}

describe("076 resume — send-value round-trips", () => {
  test("SR1 `.next(v)` threads the sent value into the resumed yield", async () => {
    // Drive the first `yield` with a bare `.next()` (the value discarded on resume),
    // then send `10` — `a = 10`, so `yield a * 2` yields `20`. Read via the supported
    // `{ value, done }` shorthand (075's rewrite; `Y === R === number` satisfies the
    // gate). Proves the sent value reaches the resumed `yield` expression.
    const src = `function* g(): Generator<number, number, number> {
  const a = yield 1;
  const b = yield a * 2;
  return 0;
}
const it = g();
it.next();
const { value, done } = it.next(10);
console.log(value, done);`;
    await behaves(src, "20 false");
  });

  test("SR2 the sent value is used in a later computation", async () => {
    // An accumulator: each `yield` returns the sent value, folded into `total`. Drive
    // past the first two yields (sending 5 then 10), read the running total at the
    // third — `0 + 5 + 10 = 15`.
    const src = `function* acc(): Generator<number, number, number> {
  let total: number = 0;
  const a = yield total;
  total = total + a;
  const b = yield total;
  total = total + b;
  yield total;
  return 0;
}
const it = acc();
it.next();
it.next(5);
const { value, done } = it.next(10);
console.log(value, done);`;
    await behaves(src, "15 false");
  });

  test("SR3 a bare `.next()` (no arg) sends the TNext default", async () => {
    // A defaultable `TNext` (`number | undefined`): each `.next()` sends the default
    // (`None` / `undefined`). The generator ignores the sent values, so it yields
    // `1`, then `2`.
    const src = `function* g(): Generator<number, number, number | undefined> {
  const a = yield 1;
  const b = yield 2;
  return 0;
}
const it = g();
it.next();
const { value, done } = it.next();
console.log(value, done);`;
    await behaves(src, "2 false");
  });

  test("SR4 the emitted Rust carries a `resume` inherent method", () => {
    const src = `function* g(): Generator<number, number, number> {
  const a = yield 1;
  const b = yield a * 2;
  return 0;
}
const it = g();
it.next();
const { value, done } = it.next(10);
console.log(value, done);`;
    const rust = compile(src);
    expect(rust).toContain("fn resume(&mut self, sent:");
    expect(rust).toContain("GenStep::Yield");
  });
});

describe("076 dual surface — impl Iterator when TNext is defaultable", () => {
  test("DS1 for-of over a defaultable-`TNext` bidirectional generator", async () => {
    const src = `function* g(): Generator<number, void, number | undefined> {
  const a = yield 1;
  const b = yield 2;
  yield 3;
}
for (const x of g()) { console.log(x); }`;
    await behaves(src, "1\n2\n3");
  });

  test("DS2 `next()` routes through `resume(<default>)` for a defaultable generator", () => {
    const src = `function* g(): Generator<number, void, number | undefined> {
  const a = yield 1;
  yield 2;
}
for (const x of g()) { console.log(x); }`;
    const rust = compile(src);
    // impl Iterator is present and its `next` delegates to `resume`.
    expect(rust).toContain("impl Iterator for");
    expect(rust).toContain("self.resume(");
  });
});

describe("076 fail-loud residuals", () => {
  test("FL1 non-defaultable `TNext` under for-of is fail-loud", () => {
    const src = `function* g(): Generator<number, void, number> {
  const a = yield 1;
  const b = yield 2;
}
for (const x of g()) { console.log(x); }`;
    rejects(src, /non-defaultable|resume-only|TNext/);
  });

  test("FL2 unannotated `TNext` with a read yield result is fail-loud", () => {
    const src = `function* g(): Generator<number> {
  const a = yield 1;
  yield a;
}
const it = g();
it.next();
it.next(10);`;
    rejects(src, /annotat|TNext|resume/);
  });
});

describe("076 regression — 075/052 pull-only path unchanged", () => {
  test("REG1 a generator with no read yield result has no `resume`", () => {
    const src = `function* g(): Generator<number, number> { yield 1; yield 2; return 9; }
const it = g();
const { value, done } = it.next();
console.log(value, done);`;
    const rust = compile(src);
    expect(rust).not.toContain("fn resume(");
    expect(rust).toContain("Steppable");
  });

  test("REG2 plain for-of over a non-bidirectional generator is unchanged", async () => {
    const src = `function* range(n: number): Generator<number> {
  let i: number = 0;
  while (i < n) { yield i; i = i + 1; }
}
for (const x of range(3)) { console.log(x); }`;
    await behaves(src, "0\n1\n2");
  });
});
