/**
 * Specs for series 062 — escaping shared-mutable aliasing → auto-`Rc<RefCell<T>>`.
 * A JS object is a shared mutable reference, so `const b = a; a.inc(); use(b)` must
 * observe the mutation. The alias-escape analysis detects the aliased-and-mutated
 * class-binding closure and promotes it to `Rc<RefCell<T>>` (reusing 028b's
 * `refineRc`) — surgically, per-binding, with no `"use rc"` directive. Method calls
 * on a promoted binding route through `.borrow()` / `.borrow_mut()`.
 *
 * Each spec differential-matches (compile → cargo run → TS-via-Bun). IDs map to
 * series 062.
 */

import { expect } from "bun:test";
import { defineDifferential } from "./_support/differential";

const COUNTER = `class Counter {
  n: number;
  constructor(n: number) { this.n = n; }
  inc(): void { this.n = this.n + 1; }
}
`;

defineDifferential("alias-escape-rc", [
  {
    name: "AR1 shared-mutation through an alias observes the mutation",
    src: `${COUNTER}const a: Counter = new Counter(0);
const b: Counter = a;
a.inc();
console.log(b.n);`,
    expected: "1",
    extra: ({ rust }) => {
      expect(rust).toContain("Rc<RefCell<Counter>>");
      expect(rust).toContain("Rc::clone(&a)");
      expect(rust).toContain("a.borrow_mut().inc()");
      expect(rust).toContain("b.borrow().n");
    },
  },
  {
    name: "AR2 a field write through one alias is seen through the other",
    src: `${COUNTER}const a: Counter = new Counter(10);
const b: Counter = a;
b.n = 99;
console.log(a.n, b.n);`,
    expected: "99 99",
    extra: ({ rust }) => expect(rust).toContain("borrow_mut()"),
  },
  {
    name: "AR3 a non-shared class binding stays a plain owned value (no Rc)",
    src: `class Box {
  v: number;
  constructor(v: number) { this.v = v; }
}
const p: Box = new Box(3);
const q: Box = new Box(4);
console.log(p.v + q.v);`,
    expected: "7",
    extra: ({ rust }) => expect(rust).not.toContain("Rc<RefCell"),
  },
  {
    name: "AR4 an aliased-but-never-mutated pair stays a plain clone (no Rc)",
    src: `class Point {
  x: number;
  constructor(x: number) { this.x = x; }
}
const a: Point = new Point(5);
const b: Point = a;
console.log(a.x + b.x);`,
    expected: "10",
    extra: ({ rust }) => expect(rust).not.toContain("Rc<RefCell"),
  },
  {
    name: "AR5 three-way alias closure all observe the mutation",
    src: `${COUNTER}const a: Counter = new Counter(0);
const b: Counter = a;
const c: Counter = b;
c.inc();
c.inc();
console.log(a.n, b.n, c.n);`,
    expected: "2 2 2",
    extra: ({ rust }) => expect(rust).toContain("Rc<RefCell<Counter>>"),
  },
]);
