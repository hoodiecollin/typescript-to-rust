# 008 — Specs

Unit specs drive the public `emit(...)` entry (parse → lower → emit → Rust
string) and assert the emitted shape of a `for…of`: a Rust `for <pat> in
<iterable>.iter() { … }`, iterating by reference. The cargo-backed
COMPILES/BEHAVES proof lives in the fixture and differential test. IDs are
referenced from the test files.

## Unit — `for…of` via `emit` (`tests/for_of.test.ts`)

Reference program unless noted:
```ts
function sumArray(arr: Array<number>): number {
  let total: number = 0;
  for (const val of arr) { total = total + val; }
  return total;
}
```

- **FOF1** the iterable is iterated by reference via `.iter()`.
  emitted Rust contains `for val in arr.iter() {`.

- **FOF2** the loop body nests inside the loop braces, indented.
  emitted Rust matches `for val in arr.iter() {\n` then an indented
  `total = total + val;`.

- **FOF3** the read-only array parameter is borrowed (`&Vec<f64>`).
  emitted Rust contains `arr: &Vec<f64>` — the element binding is `&T`, so this
  and FOF1 together fix iteration-by-reference.

- **FOF4** a `for…of` with an empty body still emits a well-formed loop.
  `function f(xs: Array<number>): void { for (const x of xs) {} }` → contains
  `for x in xs.iter() {`.

- **FOF5 (green control)** a control-flow program **without** `for…of` (a C-style
  `for` from series 007) still emits unchanged — the `forIn` node and seam do not
  regress existing lowering.

## Oracle — fixture + differential (`tests/compiler.test.ts`)

- **Tier 1 (COMPILES):** `02_control_flow/04_for_of_loop` moves into `SUPPORTED`;
  its emitted Rust must pass `cargo check`.

- **Tier 2 (BEHAVES):** summing an array
  ```ts
  function sumArray(arr: Array<number>): number {
    let total: number = 0;
    for (const val of arr) { total = total + val; }
    return total;
  }
  console.log(sumArray([1, 2, 3]));
  ```
  → Rust stdout equals the TS stdout (`6`).
