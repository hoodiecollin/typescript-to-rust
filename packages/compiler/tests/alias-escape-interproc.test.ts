/**
 * Specs for series 069 — the alias-escape interprocedural / field-store tail
 * (062 follow-on, issue #38). 062 shipped **intraprocedural** auto-`Rc<RefCell<T>>`;
 * this series graduates the two boundaries it left cargo-loud:
 *
 *  - **Interprocedural** — an aliased class binding passed into a callee that
 *    **retains** it (stores it in a field, or returns it) propagates promotion
 *    across the call boundary: the callee's param becomes `Rc<RefCell<T>>` and the
 *    call site passes `Rc::clone(&x)`.
 *  - **Field-store** — `container.f = a` where both are class bindings unions the
 *    container into `a`'s alias closure, so a mutation through either promotes both.
 *
 * Each spec differential-matches (compile → cargo run → TS-via-Bun). IDs map to
 * docs/work/069-alias-escape-interprocedural/specs.md.
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

const HOLDER = `class Holder {
  c: Counter;
  constructor(c: Counter) { this.c = c; }
}
`;

describe("069 alias-escape interprocedural / field-store", () => {
  test("IP1 alias passed into a retaining callee propagates promotion", async () => {
    // `store` retains its arg in a field; the arg is aliased and later mutated, so
    // promotion must thread across the call boundary (param → Rc<RefCell<Counter>>).
    const src = `${COUNTER}${HOLDER}function store(c: Counter): Holder {
  return new Holder(c);
}
const a: Counter = new Counter(0);
const b: Counter = a;
const h: Holder = store(b);
a.inc();
console.log(h.c.n);`;
    await behaves(src, "1");
    const rust = compile(src);
    expect(rust).toContain("Rc<RefCell<Counter>>");
    expect(rust).toContain("Rc::clone(&");
  });

  test("IP2 the retaining callee's param is Rc<RefCell<T>>", async () => {
    const src = `${COUNTER}${HOLDER}function store(c: Counter): Holder {
  return new Holder(c);
}
const a: Counter = new Counter(5);
const b: Counter = a;
const h: Holder = store(b);
b.inc();
console.log(a.n, h.c.n);`;
    await behaves(src, "6 6");
    const rust = compile(src);
    // The callee param `c` must carry the promoted Rc handle type.
    expect(rust).toMatch(/fn store\(\s*c:\s*Rc<RefCell<Counter>>/);
  });

  test("FS1 a field-store unions the container into the alias closure", async () => {
    // `h.c = a` after construction: mutating `a` must be observable through `h.c`.
    const src = `${COUNTER}class Box {
  c: Counter;
  constructor(c: Counter) { this.c = c; }
}
const seed: Counter = new Counter(0);
const h: Box = new Box(seed);
const a: Counter = new Counter(0);
h.c = a;
a.inc();
console.log(h.c.n);`;
    await behaves(src, "1");
    expect(compile(src)).toContain("Rc<RefCell<Counter>>");
  });

  test("FS2 field-store closure: a three-hop container observes the mutation", async () => {
    const src = `${COUNTER}class Box {
  c: Counter;
  constructor(c: Counter) { this.c = c; }
}
const a: Counter = new Counter(10);
const b: Counter = a;
const h: Box = new Box(a);
h.c = b;
b.inc();
console.log(a.n, h.c.n);`;
    await behaves(src, "11 11");
    expect(compile(src)).toContain("Rc<RefCell<Counter>>");
  });

  test("IP3 a non-retaining callee does not force promotion (no Rc)", async () => {
    // `peek` only reads its arg (borrows), never retains it, and the arg is never
    // shared-mutated → stays a plain owned value, no Rc.
    const src = `${COUNTER}function peek(c: Counter): number {
  return c.n;
}
const a: Counter = new Counter(7);
console.log(peek(a));`;
    await behaves(src, "7");
    expect(compile(src)).not.toContain("Rc<RefCell");
  });

  test("IP4 regression: intraprocedural aliasing still promotes (062 AR1)", async () => {
    const src = `${COUNTER}const a: Counter = new Counter(0);
const b: Counter = a;
a.inc();
console.log(b.n);`;
    await behaves(src, "1");
    expect(compile(src)).toContain("Rc::clone(&a)");
  });
});
