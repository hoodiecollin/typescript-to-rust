# 016 — Async × errors: a fallible `async function` → `async fn … -> Result<T, String>`

## Problem

Series 013 (`throw` → `Result` + `?`) and 014 (`async` → `async fn`) each shipped,
but their **intersection** was rejected fail-loud: an `async function` that
`throw`s (or calls a thrower) hits `lowerFunction`'s guard
(`"async throwing function (async + Result deferred)"`). Nothing is unsound about
the combination — Rust writes it directly, and series 014 already verified that
`#[tokio::main] async fn main() -> Result<(), String>` compiles. This slice
removes the rejection and wires the one missing piece: propagating a fallible
`await` with `.await?`.

The targets compile and run (verified with `cargo` — prints `5`):

```rust
async fn risky(n: f64) -> Result<f64, String> {
    if n < 0.0 { return Err("neg".to_string()); }
    return Ok(n / 2.0);
}
async fn caller(n: f64) -> Result<f64, String> {
    let x: f64 = risky(n).await?;      // await THEN propagate
    return Ok(x);
}
#[tokio::main]
async fn main() -> Result<(), String> {
    let r: f64 = caller(10.0).await?;
    println!("{}", r);
    return Ok(());
}
```

## Scope (decided 2026-07-02)

**In:** the async×error intersection over the existing machinery.

- **A fallible `async function` → `async fn … -> Result<T, String>`.** Remove the
  `func.async` guard inside `lowerFunction`'s fallible branch. An `async` fallible
  fn then lowers exactly like a sync fallible fn (return type wraps in `Result`,
  `makeFallible` wraps returns in `Ok` and keeps `throw`s as `Err`) — plus the
  already-threaded `isAsync: true`. No new HIR/emitter/analysis shape: the emitter
  already composes `async fn … -> Result<…>` (`emitFn`) and `#[tokio::main] async
  fn main() -> Result<(), String>` (`emitModule`).
- **`await <fallibleAsyncCall>` → `<call>.await?`.** Today `lowerAwait` produces
  `<call>.await` (no `?`) because "async fns are never fallible." Now a call to a
  fallible **and** async fn must first `.await` the future, then `?`-propagate the
  `Result` it yields. `lowerAwait` wraps the `await` node in a `try` node
  (`{ kind: "try", expr: { kind: "await", … } }` → `<call>.await?`) when the
  callee ∈ `analysis.fallible`. The fallibility fixpoint already makes the
  enclosing function (and the generated `main`) fallible — `analyzeFallible`'s
  `calledNames` walks the `CallExpression` inside the `AwaitExpression`
  regardless of `async` — so `?` is always well-typed.

**Deferred — own later series (documented, fail-loud, not silently handled):**

- **A non-awaited fallible `async` call** — still rejected by the existing
  un-awaited-call guard (an un-polled future never runs, `Result` or not). The
  dialect shape stays `await asyncFn(...)`.
- **`async` methods / `async` in a class** — still rejected at `lowerMethod`;
  fallible or not, async in an `impl` is its own series.
- **Catching an async error** — `try`/`catch` around an `await` is the recovery
  side (series-TBD), orthogonal to this propagation-only slice.
- **`Promise` combinators / concurrency** — unchanged from 014.

**Out:** any real async I/O; the `E` type stays uniformly `String` (custom error
types remain a separate error-model series).

## Design

No AST, HIR, emitter, or analysis **shape** change — this is two edits in
`lower.ts`:

1. **`lowerFunction`** — delete the `if (func.async) throw …` inside the
   `analysis.fallible.has(name)` branch. The branch already sets
   `isAsync: func.async`, so an async fallible fn now returns
   `{ isAsync: true, ret: Result<…>, body: makeFallible(…) }`.
2. **`lowerAwait`** — after building `{ kind: "await", expr: lowerCall(call, …,
   true) }`, wrap it in `{ kind: "try", expr: … }` when the awaited callee ∈
   `analysis.fallible`. (A non-fallible async await is unchanged: bare `.await`.)

`lowerCall`'s async branch is unchanged: it returns the bare call for an awaited
async callee (no `?` there) — the `?` now lives in `lowerAwait`, *outside* the
`.await`, which is the correct precedence (`x.await?`, not `x?.await`).

## Limits (documented, not silently handled)

- **The `?` sits outside the `.await`** — `f().await?`, valid only because the
  enclosing fn is fallible (guaranteed by the fixpoint). An awaited fallible call
  in a *non*-fallible context cannot arise: awaiting a fallible fn makes the caller
  fallible by construction.
- **A fallible `async` fn is awaited, never bare** — the un-awaited-call guard
  still forbids `let _ = f();` on a fallible async fn.
- **`E` is still `String`** — a fallible async fn's error type is the message,
  same as every fallible fn this project emits.

## Verification

- **Unit (cargo-free):** `tests/async-throw.test.ts` drives `emit(…)` — a fallible
  async fn → `async fn … -> Result<f64, String>` with `Err`/`Ok` bodies (ATHROW1),
  a fallible `await` → `<call>.await?` (ATHROW2), a script awaiting a fallible
  async fn → `#[tokio::main] async fn main() -> Result<(), String>` (ATHROW3), a
  non-fallible async fn unchanged — no `Result` (ATHROW4, green control), and the
  still-fail-loud non-awaited fallible async call (ATHROW5).
- **Oracle (cargo-backed):** a tier-2 differential in `compiler.test.ts` — `risky`
  (a throwing async fn), `caller` (awaits it), and a top-level `await caller(10)`
  on the success path — asserts Rust stdout equals the TypeScript's (`5`),
  exercising `async fn … -> Result`, `.await?`, and the async fallible `main`.

## Workflow note

No scaffold commit: this slice adds **no** HIR/emitter/AST shape, and the
existing `func.async` rejection in `lowerFunction` already *is* the fail-loud seam
the specs are RED against. Flow: docs → **RED** specs (against the existing guard)
→ **GREEN** (drop the guard, wrap the fallible await in `try`) → archive. `async`
methods, catching an async error (`try`/`catch`), and `Promise` combinators each
remain their own series.
