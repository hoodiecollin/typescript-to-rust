/**
 * Specs for series 062 — escaping shared-mutable aliasing → auto-`Rc<RefCell<T>>`.
 * A JS object is a shared mutable reference, so `const b = a; a.inc(); use(b)` must
 * observe the mutation. The alias-escape analysis detects the aliased-and-mutated
 * class-binding closure and promotes it to `Rc<RefCell<T>>` (reusing 028b's
 * `refineRc`) — surgically, per-binding, with no `"use rc"` directive. Method calls
 * on a promoted binding route through `.borrow()` / `.borrow_mut()`.
 *
 * Each spec differential-matches (compile → cargo run → TS-via-Bun). IDs map to
 * docs/work/062-alias-escape-auto-rc/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
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

const COUNTER = `class Counter {
  n: number;
  constructor(n: number) { this.n = n; }
  inc(): void { this.n = this.n + 1; }
}
`;

describe("062 alias-escape auto-Rc", () => {
  test("AR1 shared-mutation through an alias observes the mutation", async () => {
    const src = `${COUNTER}const a: Counter = new Counter(0);
const b: Counter = a;
a.inc();
console.log(b.n);`;
    await behaves(src, "1");
    const rust = compile(src);
    expect(rust).toContain("Rc<RefCell<Counter>>");
    expect(rust).toContain("Rc::clone(&a)");
    expect(rust).toContain("a.borrow_mut().inc()");
    expect(rust).toContain("b.borrow().n");
  });

  test("AR2 a field write through one alias is seen through the other", async () => {
    const src = `${COUNTER}const a: Counter = new Counter(10);
const b: Counter = a;
b.n = 99;
console.log(a.n, b.n);`;
    await behaves(src, "99 99");
    expect(compile(src)).toContain("borrow_mut()");
  });

  test("AR3 a non-shared class binding stays a plain owned value (no Rc)", async () => {
    const src = `class Box {
  v: number;
  constructor(v: number) { this.v = v; }
}
const p: Box = new Box(3);
const q: Box = new Box(4);
console.log(p.v + q.v);`;
    await behaves(src, "7");
    expect(compile(src)).not.toContain("Rc<RefCell");
  });

  test("AR4 an aliased-but-never-mutated pair stays a plain clone (no Rc)", async () => {
    const src = `class Point {
  x: number;
  constructor(x: number) { this.x = x; }
}
const a: Point = new Point(5);
const b: Point = a;
console.log(a.x + b.x);`;
    await behaves(src, "10");
    expect(compile(src)).not.toContain("Rc<RefCell");
  });

  test("AR5 three-way alias closure all observe the mutation", async () => {
    const src = `${COUNTER}const a: Counter = new Counter(0);
const b: Counter = a;
const c: Counter = b;
c.inc();
c.inc();
console.log(a.n, b.n, c.n);`;
    await behaves(src, "2 2 2");
    expect(compile(src)).toContain("Rc<RefCell<Counter>>");
  });
});
