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
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { UnsupportedError } from "../src/errors";
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

describe("028b use rc", () => {
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

  test("shared mutable aliasing behaves — the alias observes the mutation", async () => {
    // Under Option A `const b = a` moves `a`; `"use rc"` makes them share, so
    // writing through `a` is visible through `b`. Both print 5.
    await behaves(shared, "5\n5");
  });

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

  test("`use rc` in a free function scope shares within that function", async () => {
    await behaves(
      `function build(): number {
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
      "7",
    );
  });

  test("no `use rc` → the alias is auto-promoted to Rc<RefCell> (series 062)", async () => {
    // Series 062 graduates this: the alias-escape analysis sees `const b = a`
    // aliased with a mutation (`a.count = 5`) and auto-promotes both to
    // `Rc<RefCell<Counter>>` — no directive, and the alias observes the mutation.
    const src = `class Counter {
  count: number;
  constructor(start: number) { this.count = start; }
}
const a: Counter = new Counter(1);
const b: Counter = a;
a.count = 5;
console.log(b.count);`;
    const rust = compile(src);
    expect(rust).toContain("Rc::clone(&a)");
    const rr = await runRust(rust);
    expect(rr.ok).toBe(true);
    expect(rr.stdout.trim()).toBe(runTs(src));
    expect(rr.stdout.trim()).toBe("5");
  });

  test("`use rc` outside a free fn / script (a method body) fails loud", () => {
    expect(() =>
      compile(`class C {
  m(): void { "use rc"; }
}`),
    ).toThrow(UnsupportedError);
  });
});
