# 007 — Specs

Unit specs drive the public `emit(...)` entry (parse → lower → emit → Rust
string) and assert the **desugared structure** of a C-style `for`: a scope-
containing block wrapping the `init` and a `while` whose body ends with the
`update`. The cargo-backed COMPILES/BEHAVES proof lives in the fixture and
differential test. IDs are referenced from the test files.

## Unit — `for` via `emit` (`tests/for_loop.test.ts`)

Reference program unless noted:
```ts
function sum(): number {
  let total: number = 0;
  for (let i: number = 0; i < 5; i = i + 1) { total = total + i; }
  return total;
}
```

- **FOR1** the loop variable is hoisted into a wrapping block as `let mut i`.
  emitted Rust contains `let mut i: f64 = 0.0;` **before** the `while`.

- **FOR2** the test becomes the `while` condition.
  emitted Rust contains `while i < 5.0 {`.

- **FOR3** the update is appended as the loop body's **last** statement.
  emitted Rust matches `total = total + i;` then `i = i + 1.0;` in that order,
  both inside the `while` braces.

- **FOR4** the loop variable's scope is contained by a block — the `let mut i`
  sits inside a `{ … }` that also holds the `while`, not at function top level.
  (The `let total` is at function level; `let mut i` is one indent deeper.)

- **FOR5** a `for` with an empty body still emits a well-formed loop.
  `for (let i: number = 0; i < 3; i = i + 1) {}` → contains `let mut i: f64 = 0.0;`,
  `while i < 3.0 {`, and `i = i + 1.0;` (the update alone in the body).

- **FOR6 (green control)** a control-flow program **without** a `for` (an
  `if`/`while` from series 006) still emits unchanged — the `block` node and
  `for` seam do not regress existing lowering.

## Oracle — fixture + differential (`tests/compiler.test.ts`)

- **Tier 1 (COMPILES):** `02_control_flow/03_for_loop` moves into `SUPPORTED`;
  its emitted Rust must pass `cargo check`.

- **Tier 2 (BEHAVES):** a summing loop
  ```ts
  function sum(): number {
    let total: number = 0;
    for (let i: number = 0; i < 5; i = i + 1) { total = total + i; }
    return total;
  }
  console.log(sum());
  ```
  → Rust stdout equals the TS stdout (`10`).
