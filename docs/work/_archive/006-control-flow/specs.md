# 006 — Specs

Unit specs drive the public `emit(...)` entry (parse → lower → emit → Rust
string) and assert the **structure** of the emitted Rust for `if`/`else if`/`else`
and `while`. The oracle-backed proof (COMPILES + BEHAVES) lives in the fixtures
and differential tests; these unit specs pin the emitted shape and are what goes
RED against the lowering seam. IDs are referenced from the test files.

## Unit — control flow via `emit` (`tests/control_flow.test.ts`)

- **CF1** a bare `if` lowers and emits.
  `function f(x: number): void { if (x > 0) { console.log(x); } }` → emitted Rust
  contains `if x > 0.0 {` and no `else`.

- **CF2** `if` / `else` emits both arms.
  an `if (c) {…} else {…}` → emitted Rust contains `if` … `} else {`.

- **CF3** `else if` emits an idiomatic chain (not `else { if }`).
  an `if / else if / else` → emitted Rust contains `} else if ` and does **not**
  contain `else {\n        if` (no nested-block else-if).

- **CF4** a `while` loop lowers and emits.
  `while (i < 10) { i = i + 1; }` → emitted Rust contains `while i < 10.0 {`.

- **CF5** control-flow bodies are real blocks (statements nest and indent).
  the `while` body's `i = i + 1` emits **inside** the loop braces, indented.

- **CF6** a whole `if/else if/else` function returning a string emits all three
  return arms (`return "…".to_string();` ×3).

- **CF7 (green control)** a control-flow-free program still emits unchanged — the
  seam does not regress existing lowering.

## Oracle — fixtures + differential (`tests/compiler.test.ts`)

- **Tier 1 (COMPILES):** `02_control_flow/01_if_else` and
  `02_control_flow/02_while_loop` move into `SUPPORTED`; their emitted Rust must
  pass `cargo check`.

- **Tier 2 (BEHAVES) — if/else:** a classifier
  ```ts
  function check(x: number): string {
    if (x > 0) { return "positive"; }
    else if (x < 0) { return "negative"; }
    else { return "zero"; }
  }
  console.log(check(5));
  console.log(check(0 - 3));
  console.log(check(0));
  ```
  → Rust stdout equals the TS stdout (`positive` / `negative` / `zero`).
  (`0 - 3`, not the literal `-3`: unary minus is a separate unshipped gap, kept
  out of this control-flow slice.)

- **Tier 2 (BEHAVES) — while:** a counting loop
  ```ts
  function countUp(): number {
    let i: number = 0;
    while (i < 10) { i = i + 1; }
    return i;
  }
  console.log(countUp());
  ```
  → Rust stdout equals the TS stdout (`10`).
