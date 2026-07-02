# 011 — Specs

Unit specs drive the public `emit(...)` entry (parse → lower → emit → Rust
string) and assert the emitted shape of an `interface` → `struct`: the struct
definition, the named-struct literal, the named-type binding, and a field read.
The cargo-backed COMPILES/BEHAVES proof lives in the fixture and differential
test. IDs are referenced from the test files.

## Unit — interfaces via `emit` (`tests/interfaces.test.ts`)

Reference program unless noted:
```ts
interface Point {
  x: number;
  y: number;
}
const p: Point = { x: 10, y: 20 };
```

- **INT1** the interface lowers to a `struct` with typed fields.
  emitted Rust contains `struct Point {`, `x: f64,`, and `y: f64,`.

- **INT2** the object literal lowers to a named struct literal.
  emitted Rust contains `Point { x: 10.0, y: 20.0 }`.

- **INT3** the named-type binding resolves to the struct name.
  emitted Rust contains `let p: Point = Point { x: 10.0, y: 20.0 };`.

- **INT4** a field read lowers to Rust field access.
  program `+ \nconst gx: number = p.x;` → emitted Rust contains
  `let gx: f64 = p.x;`.

- **INT5 (green control)** a program **without** any interface still emits
  unchanged — the `struct`/`structLit` nodes and the interface seam do not
  regress existing lowering.
  `function id(n: number): number { return n; }` → contains
  `fn id(n: f64) -> f64 {`.

## Oracle — fixture + differential (`tests/compiler.test.ts`)

- **Tier 1 (COMPILES):** `05_interfaces/01_basic` moves into `SUPPORTED`; its
  emitted Rust must pass `cargo check`.

- **Tier 2 (BEHAVES):** construct a struct and print a field
  ```ts
  interface Point {
    x: number;
    y: number;
  }
  const p: Point = { x: 10, y: 20 };
  console.log(p.x);
  ```
  → Rust stdout equals the TS stdout (`10`).
