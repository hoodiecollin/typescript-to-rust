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

import { expect } from "bun:test";
import { defineDifferential } from "./_support/differential";

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

defineDifferential("alias-escape-interproc", [
  {
    name: "IP1 alias passed into a retaining callee propagates promotion",
    // `store` retains its arg in a field; the arg is aliased and later mutated, so
    // promotion must thread across the call boundary (param → Rc<RefCell<Counter>>).
    src: `${COUNTER}${HOLDER}function store(c: Counter): Holder {
  return new Holder(c);
}
const a: Counter = new Counter(0);
const b: Counter = a;
const h: Holder = store(b);
a.inc();
console.log(h.c.n);`,
    expected: "1",
    extra: ({ rust }) => {
      expect(rust).toContain("Rc<RefCell<Counter>>");
      expect(rust).toContain("Rc::clone(&");
    },
  },
  {
    name: "IP2 the retaining callee's param is Rc<RefCell<T>>",
    src: `${COUNTER}${HOLDER}function store(c: Counter): Holder {
  return new Holder(c);
}
const a: Counter = new Counter(5);
const b: Counter = a;
const h: Holder = store(b);
b.inc();
console.log(a.n, h.c.n);`,
    expected: "6 6",
    // The callee param `c` must carry the promoted Rc handle type.
    extra: ({ rust }) =>
      expect(rust).toMatch(/fn store\(\s*c:\s*Rc<RefCell<Counter>>/),
  },
  {
    name: "FS1 a field-store unions the container into the alias closure",
    // `h.c = a` after construction: mutating `a` must be observable through `h.c`.
    src: `${COUNTER}class Box {
  c: Counter;
  constructor(c: Counter) { this.c = c; }
}
const seed: Counter = new Counter(0);
const h: Box = new Box(seed);
const a: Counter = new Counter(0);
h.c = a;
a.inc();
console.log(h.c.n);`,
    expected: "1",
    extra: ({ rust }) => expect(rust).toContain("Rc<RefCell<Counter>>"),
  },
  {
    name: "FS2 field-store closure: a three-hop container observes the mutation",
    src: `${COUNTER}class Box {
  c: Counter;
  constructor(c: Counter) { this.c = c; }
}
const a: Counter = new Counter(10);
const b: Counter = a;
const h: Box = new Box(a);
h.c = b;
b.inc();
console.log(a.n, h.c.n);`,
    expected: "11 11",
    extra: ({ rust }) => expect(rust).toContain("Rc<RefCell<Counter>>"),
  },
  {
    name: "IP3 a non-retaining callee does not force promotion (no Rc)",
    // `peek` only reads its arg (borrows), never retains it, and the arg is never
    // shared-mutated → stays a plain owned value, no Rc.
    src: `${COUNTER}function peek(c: Counter): number {
  return c.n;
}
const a: Counter = new Counter(7);
console.log(peek(a));`,
    expected: "7",
    extra: ({ rust }) => expect(rust).not.toContain("Rc<RefCell"),
  },
  {
    name: "IP4 regression: intraprocedural aliasing still promotes (062 AR1)",
    src: `${COUNTER}const a: Counter = new Counter(0);
const b: Counter = a;
a.inc();
console.log(b.n);`,
    expected: "1",
    extra: ({ rust }) => expect(rust).toContain("Rc::clone(&a)"),
  },
]);
