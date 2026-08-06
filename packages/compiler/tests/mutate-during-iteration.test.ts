/**
 * Specs for series 077 — robust mutate-during-iteration over an aliased container
 * (issue #41, split from #38). Graduates the sole hard fail-loud 062 residual left
 * behind: iterating a field held in an `Rc<RefCell<T>>` alias closure while the
 * body mutates the *same* cell would `RefCell`-panic under the clean lowering
 * (a `borrow()` held across the body's `borrow_mut()`). This series rewrites it to
 * an **index-based re-borrow** loop that holds no borrow across the body, so it
 * never panics and reproduces JS's live-cursor semantics.
 *
 * Correctness bar: NEVER-PANIC + JS-semantics-faithful. Each behavioral spec
 * differential-matches (compile → `cargo run` → compare vs Bun-run TS). Fail-loud
 * residuals stay fail-loud (`UnsupportedError`)/cargo-loud, never a silent
 * miscompile. IDs map to
 * series 077.
 */

import { describe, expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

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

defineDifferential("mutate-during-iteration", [
  {
    name: "MDI1 array: the 062 panic pattern runs, no panic, bounded self-feed matches JS",
    src: `${BAG}const a: Bag = new Bag();
a.add(1); a.add(2); a.add(3);
const b: Bag = a;
for (const x of a.items) { if (x < 3) b.add(x + 10); }
let total: number = 0;
for (const y of a.items) { total = total + y; }
console.log(a.items.length);
console.log(total);`,
    // JS: [1,2,3] → push 11 (from 1), 12 (from 2) → 5 elements, sum 1+2+3+11+12=29.
    expected: "5\n29",
    extra: ({ rust }) => {
      // No borrow held across the body — the index-based re-borrow loop.
      expect(rust).not.toContain("for x in a.borrow().items.iter()");
      expect(rust).toContain("__i077");
    },
  },
  {
    name: "MDI2 array: shrink-during-iteration re-reads len(), matches JS index walk",
    // Removing the tail mid-iteration: the re-read `len()` shrinks, so the walk
    // stops where JS's positional for-of does. Count visits (avoid pushing the
    // borrowed element — a pre-existing array-of-ref limitation).
    src: `${BAG}const a: Bag = new Bag();
a.add(1); a.add(2); a.add(3); a.add(4);
const b: Bag = a;
let visits: number = 0;
for (const x of a.items) { visits = visits + 1; if (x === 2) b.removeLast(); }
console.log(visits);`,
    // JS: [1,2,3,4]; at x=2 pop() → [1,2,3]; index walk visits 1,2,3 = 3 visits.
    expected: "3",
  },
  {
    name: "MDI3 array: a live value read observes a mid-iteration write",
    src: `${BAG}const a: Bag = new Bag();
a.add(1); a.add(2); a.add(3);
const b: Bag = a;
let sum: number = 0;
for (const x of a.items) { sum = sum + x; if (x === 1) b.setAt(2, 99); }
console.log(sum);`,
    // JS: visit 1 (sum 1) → set slot2=99; visit 2 (sum 3); visit 99 (sum 102).
    expected: "102",
  },
  {
    name: "MDI4 map: delete-before-visit through the alias is skipped",
    // Print each visited key on its own line (the borrowed key can't be pushed into
    // a Vec — a pre-existing for-of-map limitation, orthogonal to this series).
    src: `${MAPBAG}const a: MapBag = new MapBag();
a.items.set("a", 1); a.items.set("b", 2); a.items.set("c", 3);
const b: MapBag = a;
for (const [k, v] of a.items) { console.log(k); if (k === "a") b.items.delete("c"); }`,
    expected: "a\nb",
    extra: ({ rust }) => expect(rust).toContain("__added077"),
  },
  {
    name: "MDI5 map: a mid-iteration value update is observed live",
    src: `${MAPBAG}const a: MapBag = new MapBag();
a.items.set("a", 1); a.items.set("b", 2);
const b: MapBag = a;
for (const [k, v] of a.items) { if (k === "a") b.items.set("b", 99); console.log(v); }`,
    expected: "1\n99",
  },
  {
    name: "MDI6 map: a visible add-during-iteration is enqueued and visited in order",
    src: `${MAPBAG}const a: MapBag = new MapBag();
a.items.set("a", 1);
const b: MapBag = a;
for (const [k, v] of a.items) {
  console.log(k);
  if (k === "a") b.items.set("b", 2);
  if (k === "b") b.items.set("c", 3);
}`,
    expected: "a\nb\nc",
  },
  {
    name: "MDI7 set: a visible add-during-iteration is enqueued and visited",
    src: `${SETBAG}const a: SetBag = new SetBag();
a.items.add(1);
const b: SetBag = a;
for (const x of a.items) { console.log(x); if (x === 1) b.items.add(2); }`,
    expected: "1\n2",
  },
  {
    name: "MDI8 regression: a non-aliased mutate-during-iteration stays cargo-loud (no Rc, no rewrite)",
    // No alias → not promoted → not the 062 panic shape. Stays fail-loud as 078's
    // FC8 shipped it (double-borrow / no such method); no index-based rewrite.
    src: `${MAPBAG}const a: MapBag = new MapBag();
a.items.set("k", 1);
for (const [k, v] of a.items) { a.items.set(k, v + 1); }
console.log(a.items.get("k") ?? -1);`,
    expectFail: true,
    extra: ({ rust }) => {
      expect(rust).not.toContain("__i077");
      expect(rust).not.toContain("__added077");
      expect(rust).not.toContain("Rc<RefCell");
    },
  },
  {
    name: "MDI9 regression: an aliased loop with a non-mutating body keeps the clean iter() lowering",
    src: `${BAG}const a: Bag = new Bag();
a.add(1); a.add(2);
const b: Bag = a;
let sum: number = 0;
for (const x of a.items) { sum = sum + x; }
console.log(sum);
console.log(b.items.length);`,
    expected: "3\n2",
    extra: ({ rust }) => {
      // Clean lowering, no index-based rewrite.
      expect(rust).toContain("for x in a.borrow().items.iter()");
      expect(rust).not.toContain("__i077");
    },
  },
]);

describe("077 mutate-during-iteration over an aliased container", () => {
  test("MDI10 fail-loud: an opaque add during Map iteration through the alias", () => {
    // The body mutates the iterated cell through an opaque `&mut self` method
    // (`b.grow()` inserts) — the emitter can't see/rewrite the insert to enqueue
    // it, so a mid-iteration add can't be faithfully visited → UnsupportedError.
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
    // per-step clone-out that releases the borrow is impossible → UnsupportedError.
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
