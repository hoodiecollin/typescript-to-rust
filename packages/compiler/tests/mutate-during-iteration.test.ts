/**
 * Specs for series 077 — robust mutate-during-iteration over an aliased container
 * (issue #41, split from #38). Graduates the sole hard `DialectError` 062 left
 * behind: iterating a field held in an `Rc<RefCell<T>>` alias closure while the
 * body mutates the *same* cell would `RefCell`-panic under the clean lowering
 * (a `borrow()` held across the body's `borrow_mut()`). This series rewrites it to
 * an **index-based re-borrow** loop that holds no borrow across the body, so it
 * never panics and reproduces JS's live-cursor semantics.
 *
 * Correctness bar: NEVER-PANIC + JS-semantics-faithful. Each behavioral spec
 * differential-matches (compile → `cargo run` → compare vs Bun-run TS). Fail-loud
 * residuals stay `DialectError`/cargo-loud, never a silent miscompile. IDs map to
 * docs/work/077-mutate-during-iteration/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { checkRust, runRust } from "../src/harness";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program, src);
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

const BAG = `class Bag {
  items: Array<number>;
  constructor() { this.items = []; }
  add(x: number): void { this.items.push(x); }
  removeLast(): void { this.items.pop(); }
  setAt(i: number, v: number): void { this.items[i] = v; }
}
`;

const MAPBAG = `class MapBag {
  items: Map<string, number>;
  constructor() { this.items = new Map<string, number>(); }
}
`;

const SETBAG = `class SetBag {
  items: Set<number>;
  constructor() { this.items = new Set<number>(); }
}
`;

describe("077 mutate-during-iteration over an aliased container", () => {
  test("MDI1 array: the 062 panic pattern runs, no panic, bounded self-feed matches JS", async () => {
    const src = `${BAG}const a: Bag = new Bag();
a.add(1); a.add(2); a.add(3);
const b: Bag = a;
for (const x of a.items) { if (x < 3) b.add(x + 10); }
let total: number = 0;
for (const y of a.items) { total = total + y; }
console.log(a.items.length);
console.log(total);`;
    // JS: [1,2,3] → push 11 (from 1), 12 (from 2) → 5 elements, sum 1+2+3+11+12=29.
    await behaves(src, "5\n29");
    const rust = compile(src);
    // No borrow held across the body — the index-based re-borrow loop.
    expect(rust).not.toContain("for x in a.borrow().items.iter()");
    expect(rust).toContain("__i077");
  });

  test("MDI2 array: shrink-during-iteration re-reads len(), matches JS index walk", async () => {
    // Removing the tail mid-iteration: the re-read `len()` shrinks, so the walk
    // stops where JS's positional for-of does. Count visits (avoid pushing the
    // borrowed element — a pre-existing array-of-ref limitation).
    const src = `${BAG}const a: Bag = new Bag();
a.add(1); a.add(2); a.add(3); a.add(4);
const b: Bag = a;
let visits: number = 0;
for (const x of a.items) { visits = visits + 1; if (x === 2) b.removeLast(); }
console.log(visits);`;
    // JS: [1,2,3,4]; at x=2 pop() → [1,2,3]; index walk visits 1,2,3 = 3 visits.
    await behaves(src, "3");
  });

  test("MDI3 array: a live value read observes a mid-iteration write", async () => {
    const src = `${BAG}const a: Bag = new Bag();
a.add(1); a.add(2); a.add(3);
const b: Bag = a;
let sum: number = 0;
for (const x of a.items) { sum = sum + x; if (x === 1) b.setAt(2, 99); }
console.log(sum);`;
    // JS: visit 1 (sum 1) → set slot2=99; visit 2 (sum 3); visit 99 (sum 102).
    await behaves(src, "102");
  });

  test("MDI4 map: delete-before-visit through the alias is skipped", async () => {
    // Print each visited key on its own line (the borrowed key can't be pushed into
    // a Vec — a pre-existing for-of-map limitation, orthogonal to this series).
    const src = `${MAPBAG}const a: MapBag = new MapBag();
a.items.set("a", 1); a.items.set("b", 2); a.items.set("c", 3);
const b: MapBag = a;
for (const [k, v] of a.items) { console.log(k); if (k === "a") b.items.delete("c"); }`;
    await behaves(src, "a\nb");
    expect(compile(src)).toContain("__added077");
  });

  test("MDI5 map: a mid-iteration value update is observed live", async () => {
    const src = `${MAPBAG}const a: MapBag = new MapBag();
a.items.set("a", 1); a.items.set("b", 2);
const b: MapBag = a;
for (const [k, v] of a.items) { if (k === "a") b.items.set("b", 99); console.log(v); }`;
    await behaves(src, "1\n99");
  });

  test("MDI6 map: a visible add-during-iteration is enqueued and visited in order", async () => {
    const src = `${MAPBAG}const a: MapBag = new MapBag();
a.items.set("a", 1);
const b: MapBag = a;
for (const [k, v] of a.items) {
  console.log(k);
  if (k === "a") b.items.set("b", 2);
  if (k === "b") b.items.set("c", 3);
}`;
    await behaves(src, "a\nb\nc");
  });

  test("MDI7 set: a visible add-during-iteration is enqueued and visited", async () => {
    const src = `${SETBAG}const a: SetBag = new SetBag();
a.items.add(1);
const b: SetBag = a;
for (const x of a.items) { console.log(x); if (x === 1) b.items.add(2); }`;
    await behaves(src, "1\n2");
  });

  test("MDI8 regression: a non-aliased mutate-during-iteration stays cargo-loud (no Rc, no rewrite)", async () => {
    // No alias → not promoted → not the 062 panic shape. Stays fail-loud as 078's
    // FC8 shipped it (double-borrow / no such method); no index-based rewrite.
    const src = `${MAPBAG}const a: MapBag = new MapBag();
a.items.set("k", 1);
for (const [k, v] of a.items) { a.items.set(k, v + 1); }
console.log(a.items.get("k") ?? -1);`;
    const rust = compile(src);
    expect(rust).not.toContain("__i077");
    expect(rust).not.toContain("__added077");
    expect(rust).not.toContain("Rc<RefCell");
    const r = await checkRust(rust);
    expect(r.ok).toBe(false);
  });

  test("MDI9 regression: an aliased loop with a non-mutating body keeps the clean iter() lowering", async () => {
    const src = `${BAG}const a: Bag = new Bag();
a.add(1); a.add(2);
const b: Bag = a;
let sum: number = 0;
for (const x of a.items) { sum = sum + x; }
console.log(sum);
console.log(b.items.length);`;
    await behaves(src, "3\n2");
    const rust = compile(src);
    // Clean lowering, no index-based rewrite.
    expect(rust).toContain("for x in a.borrow().items.iter()");
    expect(rust).not.toContain("__i077");
  });

  test("MDI10 fail-loud: an opaque add during Map iteration through the alias", () => {
    // The body mutates the iterated cell through an opaque `&mut self` method
    // (`b.grow()` inserts) — the emitter can't see/rewrite the insert to enqueue
    // it, so a mid-iteration add can't be faithfully visited → DialectError.
    const src = `class Grow {
  items: Map<string, number>;
  constructor() { this.items = new Map<string, number>(); }
  grow(k: string): void { this.items.set(k, 1); }
}
const a: Grow = new Grow();
a.items.set("a", 1);
const b: Grow = a;
for (const [k, v] of a.items) { if (k === "a") b.grow("z"); }
console.log(a.items.size);`;
    expect(() => compile(src)).toThrow(/opaque|series 077/);
  });

  test("MDI11 fail-loud: a non-Clone element container cannot be re-borrow-iterated", () => {
    // A field-pointer element (`fnPtr`) is non-`Clone` in our layer, so the
    // per-step clone-out that releases the borrow is impossible → DialectError.
    const src = `class Handlers {
  fns: Array<(x: number) => number>;
  constructor() { this.fns = []; }
  add(f: (x: number) => number): void { this.fns.push(f); }
}
const a: Handlers = new Handlers();
const b: Handlers = a;
for (const f of a.fns) { b.add(f); }
console.log(a.fns.length);`;
    expect(() => compile(src)).toThrow(/Clone|series 077/);
  });
});
