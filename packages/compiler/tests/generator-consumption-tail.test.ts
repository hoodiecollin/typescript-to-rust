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
 * docs/work/075-generator-consumption-tail/specs.md.
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

describe("075 Array.from(src, fn) — the mapping overload", () => {
  test("AF1 `Array.from(g(), x => x * 2)` maps a generator source", async () => {
    const src = `function* g(): Generator<number> { yield 1; yield 2; yield 3; }
const a = Array.from(g(), x => x * 2);
console.log(a[0], a[1], a[2]);`;
    await behaves(src, "2 4 6");
    const rust = compile(src);
    expect(rust).toContain(".map(");
    expect(rust).toContain(".collect::<Vec<_>>()");
  });

  test("AF2 `Array.from([1,2,3], (x,i) => x + i)` — array source, index overload", async () => {
    const src = `const b = Array.from([1, 2, 3], (x, i) => x + i);
console.log(b[0], b[1], b[2]);`;
    await behaves(src, "1 3 5");
    expect(compile(src)).toContain(".enumerate()");
  });

  test("AF3 `Array.from(g(), (x,i) => x + i)` — generator source, index overload", async () => {
    const src = `function* g(): Generator<number> { yield 10; yield 20; }
const c = Array.from(g(), (x, i) => x + i);
console.log(c[0], c[1]);`;
    await behaves(src, "10 21");
    expect(compile(src)).toContain(".enumerate()");
  });

  test("AF4 `Array.from(g())` (no mapping) still collects (065 regression)", async () => {
    const src = `function* g(): Generator<number> { yield 5; yield 6; }
const a: Array<number> = Array.from(g());
console.log(a.length, a[0], a[1]);`;
    await behaves(src, "2 5 6");
  });
});

describe("075 manual `{ value, done }` read", () => {
  test("MN1 `const { value, done } = it.next()` reads the first step", async () => {
    const src = `function* g(): Generator<number, number> { yield 1; yield 2; return 9; }
const it = g();
const { value, done } = it.next();
console.log(value, done);`;
    await behaves(src, "1 false");
    const rust = compile(src);
    expect(rust).toContain("GenStep::Yield");
    expect(rust).toContain("Steppable::step");
  });

  test("MN2 a generator that immediately returns reads `done: true` at the first step", async () => {
    // A generator with no `yield` (just `return 42`): the first `{ value, done }`
    // read is the completion — `value: 42, done: true`. Exercises the terminal
    // `GenStep::Return(R)` payload through the manual `step()` surface.
    const src = `function* g(): Generator<number, number> { return 42; }
const it = g();
const { value, done } = it.next();
console.log(value, done);`;
    await behaves(src, "42 true");
  });

  test("MN3 a direct `g().next()` destructure works", async () => {
    const src = `function* g(): Generator<number, number> { yield 3; return 4; }
const { value, done } = g().next();
console.log(value, done);`;
    await behaves(src, "3 false");
  });

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
});

describe("075 generator `return <value>` → GenStep::Return", () => {
  test("RV1 a `return <value>` generator compiles; for-of drops the value", async () => {
    const src = `function* g(): Generator<number, number> { yield 1; yield 2; return 9; }
for (const x of g()) { console.log(x); }`;
    await behaves(src, "1\n2");
    expect(compile(src)).toContain("__ret");
  });

  test("RV2 an inferred `R` (no 2nd type arg) compiles", async () => {
    const src = `function* g(): Generator<number> { yield 5; return 6; }
for (const x of g()) { console.log(x); }`;
    await behaves(src, "5");
  });
});

describe("075 `yield*` completion value", () => {
  test("YR1 `const r = yield* inner()` binds the completion value", async () => {
    const src = `function* inner(): Generator<number, number> { yield 1; yield 2; return 99; }
function* outer(): Generator<number, number> {
  yield 0;
  const r = yield* inner();
  yield r;
  return 0;
}
for (const x of outer()) { console.log(x); }`;
    await behaves(src, "0\n1\n2\n99");
    expect(compile(src)).toContain("dyn tslib::gen::Steppable");
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
});

describe("075 generator array-destructuring (rides 067)", () => {
  test("GD1 `const [a, b] = pair()` pulls a fixed-arity prefix", async () => {
    const src = `function* pair(): Generator<number> { yield 10; yield 20; yield 30; }
const [a, b] = pair();
console.log(a, b);`;
    await behaves(src, "10 20");
    expect(compile(src)).toContain(".next().unwrap()");
  });

  test("GD2 fail-loud: rest element `const [a, ...rest] = g()`", () => {
    const src = `function* g(): Generator<number> { yield 1; yield 2; yield 3; }
const [a, ...rest] = g();`;
    rejects(src, /RestElement|rest element/);
  });
});

describe("075 regression — 065 collecting consumers unchanged", () => {
  test("REG1 `[...g()]` still collects to a Vec", async () => {
    const src = `function* g(): Generator<number> { yield 1; yield 2; yield 3; }
const arr: Array<number> = [...g()];
console.log(arr.length, arr[0], arr[2]);`;
    await behaves(src, "3 1 3");
  });

  test("REG3 plain for-of over a state-machine generator is unchanged", async () => {
    const src = `function* range(n: number): Generator<number> {
  let i: number = 0;
  while (i < n) { yield i; i = i + 1; }
}
for (const x of range(3)) { console.log(x); }`;
    await behaves(src, "0\n1\n2");
  });
});
