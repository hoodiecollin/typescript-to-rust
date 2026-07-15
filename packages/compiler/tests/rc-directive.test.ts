/**
 * Specs for series 028b — the `"use rc"` per-scope directive. A leading
 * `"use rc"` opts a scope into the Option-B fallback: class-typed bindings
 * translate under `Rc<RefCell<T>>` (shared, interior-mutable) instead of plain
 * moves, so shared-mutable aliasing — a move error under Option A — compiles.
 *
 *   - `new C(…)`      → `Rc::new(RefCell::new(C::new(…)))`
 *   - `const b = a`   → `Rc::clone(&a)`   (a second handle to the same value)
 *   - read  `a.field` → `a.borrow().field`
 *   - write `a.field` → `a.borrow_mut().field`
 *
 * Differential: emitted Rust compiles AND matches the TS run (both observe the
 * mutation through the alias).
 */

import { describe, expect, test } from "bun:test";
import { UnsupportedError } from "../src/errors";
import { compile, defineDifferential } from "./_support/differential";

const shared = `"use rc";
class Counter {
  count: number;
  constructor(start: number) { this.count = start; }
}
const a: Counter = new Counter(1);
const b: Counter = a;
a.count = 5;
console.log(b.count);
console.log(a.count);`;

defineDifferential("rc-directive", [
  {
    // Under Option A `const b = a` moves `a`; `"use rc"` makes them share, so
    // writing through `a` is visible through `b`. Both print 5.
    name: "shared mutable aliasing behaves — the alias observes the mutation",
    src: shared,
    expected: "5\n5",
  },
  {
    name: "`use rc` in a free function scope shares within that function",
    src: `function build(): number {
  "use rc";
  const a: Counter = new Counter(10);
  const b: Counter = a;
  a.count = 7;
  return b.count;
}
class Counter {
  count: number;
  constructor(start: number) { this.count = start; }
}
console.log(build());`,
    expected: "7",
  },
  {
    name: "no `use rc` → the alias is auto-promoted to Rc<RefCell> (series 062)",
    // Series 062 graduates this: the alias-escape analysis sees `const b = a`
    // aliased with a mutation (`a.count = 5`) and auto-promotes both to
    // `Rc<RefCell<Counter>>` — no directive, and the alias observes the mutation.
    src: `class Counter {
  count: number;
  constructor(start: number) { this.count = start; }
}
const a: Counter = new Counter(1);
const b: Counter = a;
a.count = 5;
console.log(b.count);`,
    expected: "5",
    extra: ({ rust }) => expect(rust).toContain("Rc::clone(&a)"),
  },
]);

describe("028b use rc", () => {
  test("emits Rc<RefCell<…>> construction, clone, and borrow forms", () => {
    const rust = compile(shared);
    expect(rust).toContain("use std::rc::Rc;");
    expect(rust).toContain("use std::cell::RefCell;");
    expect(rust).toContain("Rc::new(RefCell::new(Counter::new(1.0)))");
    expect(rust).toContain("let b: Rc<RefCell<Counter>> = Rc::clone(&a);");
    expect(rust).toContain("a.borrow_mut().count = 5.0;");
    expect(rust).toContain("b.borrow().count");
    // Interior mutability — the handles are not `mut`, and the directive string
    // never leaks as an expression statement.
    expect(rust).not.toContain("let mut a");
    expect(rust).not.toContain('"use rc"');
  });

  test("`use rc` outside a free fn / script (a method body) fails loud", () => {
    expect(() =>
      compile(`class C {
  m(): void { "use rc"; }
}`),
    ).toThrow(UnsupportedError);
  });
});
