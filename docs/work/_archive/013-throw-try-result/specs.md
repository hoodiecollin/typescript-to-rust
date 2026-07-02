# 013 — Specs

Unit specs drive the public `emit(...)` entry (parse → lower → emit → Rust
string) and assert the emitted shape of `throw` → `Result<T, E>` + `?`: the
return-type wrap, `throw` → `return Err(...)`, a normal `return` wrapped in `Ok`,
`?` propagation with `main` returning `Result`, and a non-throwing green control.
The cargo-backed COMPILES/BEHAVES proof lives in the fixture and differential
test. IDs are referenced from the test files.

## Unit — errors via `emit` (`tests/errors.test.ts`)

Reference program unless noted:
```ts
function half(n: number): number {
  if (n < 0) {
    throw new Error("negative");
  }
  return n / 2;
}
```

- **ERR1** a throwing function's return type wraps in `Result`.
  emitted Rust contains `fn half(n: f64) -> Result<f64, String> {`.

- **ERR2** `throw new Error(msg)` lowers to `return Err(msg)`.
  emitted Rust contains `return Err("negative".to_string());`.

- **ERR3** a normal `return` inside a fallible function wraps in `Ok`.
  emitted Rust contains `return Ok(n / 2.0);`.

- **ERR4** a call to a fallible function propagates with `?`, and the script's
  `main` returns `Result` with a trailing `Ok(())`.
  program `+ \nconst x: number = half(10);\nconsole.log(x);` → emitted Rust
  contains `half(10.0)?`, `fn main() -> Result<(), String> {`, and `return
  Ok(());`.

- **ERR5 (green control)** a program with no `throw` and no fallible call emits
  unchanged — no `Result`, no `?`, no `Ok(`. The `result`/`ok`/`try`/`throw` nodes
  and the fallibility fixpoint do not regress existing lowering.
  `function id(n: number): number { return n; }` → contains
  `fn id(n: f64) -> f64 {` and **not** `Result`, **not** `?`.

## Oracle — fixture + differential (`tests/compiler.test.ts`)

- **Tier 1 (COMPILES):** `08_errors/01_throw` moves into `SUPPORTED`; its emitted
  Rust (`fn crash() -> Result<(), String> { return Err("Crash!".to_string()); }`)
  must pass `cargo check` (as a library — a dead-code warning does not fail
  `cargo check`).

- **Tier 2 (BEHAVES):** propagate through `main` on the success path
  ```ts
  function half(n: number): number {
    if (n < 0) { throw new Error("negative"); }
    return n / 2;
  }
  function announce(n: number): void {
    if (n < 0) { throw new Error("negative n"); }
    console.log(n);
  }
  announce(7);
  const x: number = half(10);
  console.log(x);
  ```
  → Rust stdout equals the TS stdout (`7\n5`). Exercises the return-type wrap
  (both functions), `Err`/`Ok` wrapping, the trailing `Ok(())` (the `void`
  `announce` and `main`), and `?` propagation through `main` — while both throwing
  branches stay untaken so the two runtimes agree.
