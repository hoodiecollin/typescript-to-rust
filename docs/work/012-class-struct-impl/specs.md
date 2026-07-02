# 012 — Specs

Unit specs drive the public `emit(...)` entry (parse → lower → emit → Rust
string) and assert the emitted shape of a `class` → `struct` + `impl`: the struct
and impl blocks, the `new` constructor building a struct literal, a `&mut self`
method, and `this`/`new` translation. The cargo-backed COMPILES/BEHAVES proof
lives in the fixture and differential test. IDs are referenced from the test
files.

## Unit — classes via `emit` (`tests/classes.test.ts`)

Reference program unless noted:
```ts
class Counter {
  count: number;
  constructor(start: number) {
    this.count = start;
  }
  increment(): void {
    this.count = this.count + 1;
  }
}
```

- **CLS1** the class lowers to a `struct` and an `impl` block.
  emitted Rust contains `struct Counter {`, `count: f64,`, and `impl Counter {`.

- **CLS2** the constructor lowers to an associated `new` returning a struct
  literal.
  emitted Rust contains `fn new(start: f64) -> Counter {` and
  `Counter { count: start }`.

- **CLS3** a mutating method takes `&mut self` and uses `self`.
  emitted Rust contains `fn increment(&mut self) {` and
  `self.count = self.count + 1.0;`.

- **CLS4** `new` and `this` translate at a use site.
  program `+ \nconst c: Counter = new Counter(5);` → emitted Rust contains
  `Counter::new(5.0)`; and CLS3 already fixes `this`→`self`.

- **CLS5 (green control)** a program **without** any class still emits unchanged —
  the `HirClass` node, the `recv` receiver, and the class seam do not regress
  existing lowering (a free function keeps no receiver).
  `function id(n: number): number { return n; }` → contains
  `fn id(n: f64) -> f64 {` and **not** `self`.

## Oracle — fixture + differential (`tests/compiler.test.ts`)

- **Tier 1 (COMPILES):** `06_classes/01_basic` moves into `SUPPORTED`; its emitted
  Rust (struct + impl) must pass `cargo check`.

- **Tier 2 (BEHAVES):** construct, mutate through a method, read
  ```ts
  class Counter {
    count: number;
    constructor(start: number) { this.count = start; }
    increment(): void { this.count = this.count + 1; }
  }
  const c: Counter = new Counter(1);
  c.increment();
  c.increment();
  console.log(c.count);
  ```
  → Rust stdout equals the TS stdout (`3`). The `const c` binding is marked `mut`
  because `increment` is a self-mutating method (const→let, `mut` from use).
