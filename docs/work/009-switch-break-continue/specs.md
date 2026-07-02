# 009 — Specs

Unit specs drive the public `emit(...)` entry (parse → lower → emit → Rust
string) and assert the emitted shape of `switch → match` (guarded wildcard arms)
and `break`/`continue`. The cargo-backed COMPILES/BEHAVES proof lives in the
fixture and differential tests. IDs are referenced from the test files.

## Unit — `switch` via `emit` (`tests/switch.test.ts`)

Reference program unless noted (the `05_switch` fixture):
```ts
function matchNum(x: number): string {
  switch (x) {
    case 1: return "one";
    case 2: return "two";
    default: return "other";
  }
}
```

- **SW1** the switch lowers to a `match` over the discriminant.
  emitted Rust contains `match x {`.

- **SW2** a `case` becomes a guarded wildcard arm.
  emitted Rust contains `_ if x == 1.0 =>` and `_ if x == 2.0 =>`.

- **SW3** `default` becomes the wildcard arm.
  emitted Rust contains `_ => {` and the arm returns `"other"`.

- **SW4** a `switch` with no `default` gets a synthetic exhaustive catch-all.
  `function f(x: number): void { switch (x) { case 1: break; } }` → emitted Rust
  contains `_ => {` (the synthetic arm) and the `case 1` arm body is **empty**
  (the trailing `break` was stripped, not emitted as `break;`).

- **SW5** a non-terminating, non-final case is rejected (no fall-through).
  `switch (x) { case 1: console.log(1); case 2: break; }` → `emit` throws
  `UnsupportedError`.

- **SW6 (green control)** an `if`/`else` program (no `switch`) still emits — the
  `match` node and seam don't regress earlier lowering.

## Unit — `break`/`continue` via `emit` (`tests/break_continue.test.ts`)

- **BC1** `break` in a `while` emits `break;`.
  `while (i < 10) { break; }` → contains `break;`.

- **BC2** `continue` in a `while` emits `continue;`.
  `while (i < 10) { i = i + 1; continue; }` → contains `continue;`.

- **BC3** `break`/`continue` in a `for…of` emit inside the loop.
  `for (const v of arr) { if (...) { continue; } }` → contains `continue;`.

- **BC4** `break` in a C-style `for` is allowed (sound — exits the desugared
  `while`). `for (…) { break; }` → contains `break;`.

- **BC5** `continue` in a C-style `for` is rejected (unsound desugar).
  `for (let i: number = 0; i < 5; i = i + 1) { continue; }` → `emit` throws
  `UnsupportedError`.

- **BC6 (green control)** a loop **without** `break`/`continue` still emits — the
  new nodes and the `for`-`continue` guard don't regress earlier lowering.

## Oracle — fixture + differentials (`tests/compiler.test.ts`)

- **Tier 1 (COMPILES):** `02_control_flow/05_switch` moves into `SUPPORTED`.

- **Tier 2 (BEHAVES) — switch:**
  ```ts
  function classify(x: number): string {
    switch (x) { case 1: return "one"; case 2: return "two"; default: return "other"; }
  }
  console.log(classify(1)); console.log(classify(2)); console.log(classify(9));
  ```
  → `one` / `two` / `other`.

- **Tier 2 (BEHAVES) — while + break:** a loop that breaks at `i === 5` → `5`.

- **Tier 2 (BEHAVES) — while + continue:** a loop that `continue`s on `i === 3`
  while summing `1..=5` → `12`.

- **Tier 2 (BEHAVES) — for…of + continue:** sum `[1,2,3]` keeping only the first
  two elements (skip by a local counter, `count > 2` → `continue`) → `3`.
  (Skipping compares a local `f64`, not the element: a `for…of` element binds as
  `&T` and `&f64 == f64` has no impl — a deferred for…of ergonomics gap,
  orthogonal to `continue`.)
