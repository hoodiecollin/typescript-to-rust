# 021 — Specs

Unit specs drive the public `emit(...)` entry (parse → lower → emit → Rust
string) and assert the emitted shape of `try`/`catch`/`finally`: the IIFE closure
returning `Result`, `?` surviving inside the try body, the `if let Err(...)`
catch (bound and no-binding), `finally` emitted after, the enclosing function
staying non-`Result` (fallibility shielding), and a non-`try` green control. The
cargo-backed COMPILES/BEHAVES proof lives in the fixture + differential test.

## Unit — try/catch via `emit` (`tests/try-catch.test.ts`)

Reference program unless noted:
```ts
function risky(n: number): void {
  if (n < 0) {
    throw new Error("negative");
  }
  console.log("ran");
}
function attempt(n: number): void {
  try {
    risky(n);
    console.log("try-ok");
  } catch (e) {
    console.log("caught");
  } finally {
    console.log("finally");
  }
}
```

- **TRY1** the `try` block lowers to a `Result`-returning IIFE closure.
  emitted Rust contains `(|| -> Result<(), String> {`.

- **TRY2** a fallible call inside the try body keeps its `?` (propagates to the
  closure, not the function).
  emitted Rust contains `risky(n)?;`.

- **TRY3** `catch (e)` lowers to `if let Err(e) = …`, and a no-binding catch to
  `if let Err(_) = …`.
  reference → contains `if let Err(e) =`; the same program with `catch {` (no
  param) → contains `if let Err(_) =`.

- **TRY4** `finally` emits its statements after the `if let` (the caught branch),
  not inside it.
  emitted Rust contains `println!("finally")`, and it appears *after* the
  `if let Err` line (index check).

- **TRY5 (shielding)** a `try` **with a handler** catches its error, so the
  enclosing function is **not** fallible.
  emitted Rust contains `fn attempt(n: f64) {` and **not** `fn attempt(n: f64) ->
  Result`.

- **TRY6 (green control)** a program with no `try` emits unchanged — no closure,
  no `if let Err`. `function id(n: number): number { return n; }` → contains
  `fn id(n: f64) -> f64 {` and **not** `if let Err`.

## Deferral specs (fail-loud, `UnsupportedError`)

- **TRYX1** a `return` inside a `try` body is rejected (`return` would escape the
  closure). `function f(): number { try { return risky2(); } catch (e) { return 0; } }`
  (where `risky2` is fallible) → `emit` throws.
- **TRYX2** a `try`/`finally` with no `catch` handler is rejected.
  `try { risky(1); } finally { cleanup(); }` → `emit` throws.

## Oracle — fixture + differential (`tests/compiler.test.ts`)

- **Tier 1 (COMPILES):** `08_errors/02_try_catch` moves into `SUPPORTED`; its
  emitted Rust must pass `cargo check`.
  ```ts
  function risky(n: number): void {
    if (n < 0) { throw new Error("negative"); }
    console.log("ran");
  }
  function attempt(n: number): void {
    try {
      risky(n);
    } catch (e) {
      console.log("caught");
    } finally {
      console.log("done");
    }
  }
  ```

- **Tier 2 (BEHAVES):** the reference `attempt` called on both paths
  ```ts
  attempt(5);    // ran / (no catch) / done
  attempt(-1);   // caught / done
  ```
  → Rust stdout equals the TS stdout. Exercises the IIFE, the `?` inside,
  `if let Err`, the `finally`-after emit, and the fallibility shielding (both
  `attempt` and `main` stay non-`Result`).
