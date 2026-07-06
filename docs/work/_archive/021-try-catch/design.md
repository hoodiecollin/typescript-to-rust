# 021 — Errors: `try` / `catch` / `finally` (the recovery side)

## Problem

Series 013 shipped the **propagation** side of errors: `throw` → `return Err`,
a fallible function returns `Result<T, String>`, and a fallible call propagates
with `?`. What it deliberately left out is the **recovery** side — *catching* a
thrown error and continuing. In TypeScript:

```ts
function attempt(n: number): void {
  try {
    risky(n);          // fallible — throws when n < 0
    console.log("try-ok");
  } catch (e) {
    console.log("caught");
  } finally {
    console.log("finally");
  }
}
```

Rust has no `try`/`catch`. The idiomatic emulation on stable Rust is an
**immediately-invoked closure** that returns a `Result`, so `?` short-circuits
*to the closure* (not the enclosing function), and the caller matches on the
closure's result:

```rust
fn attempt(n: f64) {
    if let Err(e) = (|| -> Result<(), String> {
        risky(n)?;
        println!("try-ok");
        Ok(())
    })() {
        println!("caught");
    }
    println!("finally");
}
```

Verified with `rustc` (compiles + runs). This is the whole idea of the slice:
the `try` block becomes a `Result`-returning IIFE, `catch` becomes
`if let Err(<param>) = <that> { … }`, and `finally` becomes statements emitted
after.

## Scope (decided 2026-07-06)

**In:** statement-level recovery — a `try`/`catch` (optionally `+ finally`) run
for effect, where the enclosing function *fully handles* the error rather than
re-propagating it.

- **The IIFE closure.** `try { B }` lowers to a closure
  `(|| -> Result<(), Ety> { B'; Ok(()) })()`. Inside `B'`, fallible calls stay
  `?`-propagated and `throw`s stay `return Err(…)` — exactly the existing
  fallible-body lowering, because the closure *is* a little fallible function.
  `Ety` is the program error type (`String` this slice; series 022 upgrades it to
  `Box<dyn Error>` when custom error classes exist — the node carries `errTy` so
  that swap is local).
- **`catch (e) { H }`** → `if let Err(e) = <closure-call> { H' }`. The bound `e`
  is the `String` message. A **no-binding** `catch { H }` → `if let Err(_) = …`.
- **`finally { F }`** → the `F'` statements emitted *after* the `if let`. Correct
  because neither the `try` nor the `catch` body may diverge past it (see the
  rejections below), so control always reaches `finally` exactly once — matching
  JS for the in-dialect shapes.
- **Fallibility shielding (the key analysis change).** A `try` block **with a
  handler** *catches* its errors, so a fallible call or `throw` inside it must
  **not** make the enclosing function fallible. `analyzeFallible` gains a
  `try`-aware walk: the `block` of a `TryStatement` that has a `handler` is
  shielded (its throws/calls don't count toward the enclosing scope), while the
  `handler` body and the `finalizer` are walked normally (a re-throw or an
  un-caught fallible call *there* still propagates). So `attempt` above is **not**
  fallible → `fn attempt(n: f64)` with no `Result`, and its callers don't `?` it.

**Deferred — own later series (documented, not silently handled):**

- **`return` / `break` / `continue` inside the `try` or `catch` body** — rejected
  fail-loud. A `return` inside the IIFE would return from the *closure*, not the
  enclosing function (wrong semantics); `break`/`continue` can't cross the closure
  boundary at all. Value-yielding `try`/`catch` (a `try`/`catch` that computes a
  function's return value) is its own future series — it needs the closure's `Ok`
  payload to carry the returned value and both arms to yield it.
- **`try` / `finally` with no `catch` handler** — rejected. Without a handler the
  error must propagate, but `finally` must still run on the error path; that needs
  the catch-run-finally-rethrow shape, a later refinement.
- **A re-`throw` inside `catch` when a `finally` is present** — rejected. The
  re-throw would skip the trailing `finally` in this simple model (JS runs it).
  Re-throw *without* `finally` is fine (the catch's `throw` → `return Err(…)`
  propagates, and the enclosing fn is fallible because catch bodies aren't
  shielded).
- **Catching into a typed/discriminated binding** (`catch (e) { if (e instanceof
  …) }`, `e.message`, `e.name`) — the binding is the raw `String` this slice;
  type-based discrimination arrives with custom error types (series 022) and its
  own downcast/`match` handling.
- **`try`/`catch` inside a class method or constructor** — composes only once
  throw-in-method lands (series 023); until then a method body containing a
  `try` stays under the existing throw-in-method rejection.

**Out:** `panic`/unwinding-based catch (`catch_unwind`); `Result` combinators as
a catch alternative (`.unwrap_or`, `.ok()`).

## Design

### AST (`ast.ts`)

Add (verified against real parser output):

```ts
interface CatchClause { type: "CatchClause"; param: Identifier | null; body: BlockStatement; }
interface TryStatement { type: "TryStatement"; block: BlockStatement;
                         handler: CatchClause | null; finalizer: BlockStatement | null; }
```

Add `TryStatement` to the `Statement` union.

### HIR (`hir.ts`)

```ts
export type HirStmt = …
  | { kind: "tryCatch";
      tryBody: HirStmt[];            // fallible-aware; the IIFE closure body
      catchParam: string | null;    // caught binding, or null for `catch {}`
      catchBody: HirStmt[];
      finallyBody: HirStmt[] | null; // emitted after the if-let
      errTy: RustType };            // the closure's Result error type (String today)
```

### Emitter (`emitter.ts`)

`emitStmt`'s `tryCatch` case:

```
if let Err(<catchParam ?? "_">) = (|| -> Result<(), <errTy>> {
<tryBody indented>
})() {
<catchBody indented>
}
<finallyBody stmts, if present>
```

The `tryBody` already ends in `return Ok(());` (added by `makeFallible`, see
below), so the closure is well-typed. `finallyBody`, when present, is emitted as
sibling statements after the `if let` (one `emitStmt` may render multiple Rust
statements — as the `for`-desugar block already does).

### Lowering (`lower.ts`) — the gate

- `lowerStatement` gains a `TryStatement` case → `lowerTry`.
- `lowerTry`:
  - Require `stmt.handler` (no-catch `try`/`finally` → fail-loud).
  - Lower `block.body` in the enclosing scope, then run `makeFallible(tryBody,
    UNIT)` so fallible calls/`throw`s inside get the closure's `Ok(())` tail —
    reusing the existing transform (there are no `return`s to wrap; they're
    rejected).
  - Reject (fail-loud) any own-level `return`/`break`/`continue` in `tryBody` or
    `catchBody` (walk the lowered HIR, stopping at nested loops/fns — a
    `break`/`continue` that belongs to a loop *inside* the try is fine).
  - Lower `handler.body` in the enclosing scope; `catchParam = handler.param?.name
    ?? null`.
  - Lower `finalizer.body` if present. If `finallyBody` is present **and** the
    `catchBody` re-throws (contains a `throw`/`try`), fail-loud.
  - `errTy = ERR_STRING` (series 022 will thread the program error type here).
- **`analyzeFallible` (`analysis.ts`).** Replace the raw `walkOwn` over a body
  with a `try`-aware variant for both `bodyThrows` and `calledNames`: when it
  reaches a `TryStatement` whose `handler` is non-null, it does **not** descend
  into `block` (shielded), but continues into `handler.body` and `finalizer`. A
  `TryStatement` with no handler is walked whole (errors still propagate).

### Numeric / string passes

`refineNumerics`/`refineStrings` descend into the three `tryCatch` bodies (add the
node to the statement walkers), so indexing/among the try/catch/finally bodies
still refines.

## Limits (documented, not silently handled)

- **No value escape** — `return`/`break`/`continue` inside `try`/`catch` is
  rejected; the construct is run for effect only.
- **A `catch` handler is required** — `try`/`finally` alone is deferred.
- **`finally` never runs "on the way out"** — because divergence past it is
  rejected, so the simple emit-after model is exact for the in-dialect shapes.
- **`e` is the raw `String`** — no `instanceof`/`.message`/`.name` discrimination
  (custom error types, series 022).

## Verification

- **Unit (cargo-free):** `tests/try-catch.test.ts` drives `emit(…)` on a
  reference program and asserts: the IIFE header `(|| -> Result<(), String> {`
  (TRY1); the `?` inside the try body survives (TRY2); `if let Err(e) = …` with
  the bound name, and `if let Err(_)` for a no-binding catch (TRY3); the `finally`
  statements emit after the `if let` (TRY4); the enclosing function is **not**
  `Result` — shielding works (TRY5); and a green control with no `try` emits
  unchanged (TRY6).
- **Oracle (cargo-backed):** add `08_errors/02_try_catch` and flip it to
  `SUPPORTED` (COMPILES), plus a tier-2 differential: `attempt(5)` (try-ok path)
  and `attempt(-1)` (caught path) with a `finally` in both, asserting Rust stdout
  equals TS stdout.

## Workflow note

Spec-first: docs → scaffold (the HIR `tryCatch` node, the emitter case, and a
`lowerTry` seam throwing `UnsupportedError` "try/catch lowering pending"; the
fallibility-shielding walk is stubbed so specs are **RED**) → **RED** → real
`lowerTry`, the rejections, and the `try`-aware `analyzeFallible` to **GREEN** →
archive. Value-yielding `try`/`catch`, `try`/`finally` without a handler, and
typed catch bindings each get a **new** series.
</invoke>
