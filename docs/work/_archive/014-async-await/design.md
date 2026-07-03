# 014 — Async: `async`/`await` → `async fn` + `#[tokio::main]`

## Problem

TypeScript's `async function` returns a `Promise<T>`; `await` suspends until the
promise settles and yields its `T`. Rust models the same with `async fn` (which
returns an `impl Future<Output = T>`) and the postfix `.await`, but a future does
nothing until it is polled by a **runtime** — there is no ambient event loop. The
generated entry point therefore needs `#[tokio::main]`, which wraps `main` in a
runtime. The `07_async/01_async_await.ts` fixture is the smallest case (still
`test.todo`).

The scratch crate already pins `tokio` (see `.scratch/Cargo.toml`), so the
runtime is available; this slice is the lowering, not the plumbing.

The targets compile and run (verified with `cargo` against the scratch crate):

```rust
// library (the fixture — bare async fns, no runtime needed to *define* them)
async fn doFetch(id: f64) -> String {
    return "row".to_string();
}
async fn fetchData(id: f64) -> String {
    let res: String = doFetch(id).await;
    return res;
}
```

```rust
// binary (top-level await forces an async runtime `main`)
#[tokio::main]
async fn main() {
    let out: String = fetchData(1.0).await;
    println!("{}", out);
}
```

## Scope (decided 2026-07-02)

**In:** the smallest coherent async slice — a **free** `async function`, `await`
of a call to one, and the runtime `main` when the top-level script awaits.

- **`async function` → `async fn`.** The emitter already renders `fn.isAsync`
  (`emitFn`), and lowering already threads `func.async` into `HirFn.isAsync`. The
  only lowering change is to *stop rejecting* a non-fallible `async` function
  (today it falls through to `lowerType(Promise<…>)`, which is fail-loud on the
  unknown `Promise` name).
- **`Promise<T>` → `T`.** An `async fn`'s Rust return type is its resolved `T`, not
  a wrapper (Rust wraps in `Future` implicitly). `lowerType` unwraps
  `Promise<T>` → `lowerType(T)` (`Promise<void>` → `()`). `Promise` is only
  in-dialect as an `async` return annotation; unwrapping it elsewhere is
  documented below.
- **`await <asyncCall>` → `<call>.await`.** A new `HirExpr`
  `{ kind: "await"; expr }` → `<expr>.await`. Only `await` of a **call to a known
  `async` function** is accepted; anything else is fail-loud (below).
- **Runtime `main`.** When the top-level script contains an `await`, the generated
  entry becomes `#[tokio::main] async fn main()`. `HirModule` gains an optional
  `mainAsync?: boolean` (absent ⇒ a plain `fn main()`, the existing behaviour).
  Detected by a generic HIR walk over `main` for an `await` node — nested
  functions are separate `items`, so a walk of `main` sees exactly script-scope
  awaits.
- **`async` set.** `analysis.asyncFns: Set<string>` — the names of top-level
  `async` function declarations. Drives both the `await`-target check and the
  un-awaited-call rejection.

**Deferred — own later series (documented, fail-loud, not silently handled):**

- **A call to an `async` function that is not directly `await`ed** — in Rust a
  bare `asyncFn()` is an *unpolled* future: it compiles (a `must_use` **warning**)
  but never runs, a silent behaviour divergence from TS (which starts the promise
  eagerly). Rejected `UnsupportedError` so no non-running Rust is emitted. The
  dialect shape is exactly `await asyncFn(...)`.
- **`await` of a non-call, or of a call to a non-`async` function** — `await 5`,
  `await x`, `await Promise.all(...)`, `await syncFn()`. Rejected; only
  `await <asyncFn>(...)` maps.
- **`async` + `throw` (a fallible `async` function)** — already rejected (series
  013); `async` + `Result` is its own combination. (The generated `main` *may* be
  both `#[tokio::main]` and `-> Result<(), String>` when the script both awaits
  and throws — that combination compiles, verified — but no fixture exercises it.)
- **`async` methods / `async` in a class** — `asyncFns` tracks free functions
  only; an `async` method is rejected at definition (`lowerMethod`). Async in an
  `impl` is a later series.
- **`async` arrow functions** — arrows are unsupported wholesale (`03_functions/
  02_arrow` is a separate todo); an `async` arrow rides that.
- **`Promise` combinators / concurrency** — `Promise.all`, `Promise.race`,
  `setTimeout`, spawning, `.then()` chains, cancellation. Out of scope; this slice
  is sequential `await` only.

**Out:** any real I/O (`fetch`, timers, sockets) — the dialect has no async I/O
surface; async functions here are ordinary computations marked `async`.

## Design

### AST (`ast.ts`)

Add `AwaitExpression { type: "AwaitExpression"; argument: Expression }` and add it
to the `Expression` union. (Verified against the parser: `await doFetch(id)`
parses as an `AwaitExpression` whose `argument` is a `CallExpression`.)

### HIR (`hir.ts`)

```ts
export type HirExpr = … | { kind: "await"; expr: HirExpr };   // expr.await
export interface HirModule { …; mainAsync?: boolean; }        // absent ⇒ plain main
```

### Emitter (`emitter.ts`) — the shape (lands in the scaffold)

- `emitExpr`: `await` → `` `${emitExpr(e.expr)}.await` ``.
- `emitModule`: when `mod.mainAsync`, prefix the `main` item with `#[tokio::main]\n`
  and an `async ` keyword. Composes with the existing `mainRet` (a future combined
  async+fallible `main` reads `#[tokio::main]\nasync fn main() -> Result<…>`).

The pure/total emitter's exhaustiveness guard forces the `await` case the moment
the HIR kind is added.

### Analysis (`analysis.ts`)

`analyzeModule` collects `asyncFns` — top-level `FunctionDeclaration`s whose
`async` flag is set — into the new `ModuleAnalysis.asyncFns` set.

### Lowering (`lower.ts`) — the gate

- `lowerType`: a `TSTypeReference` to `Promise` unwraps its single type argument
  (`Promise<T>` → `lowerType(T)`; missing arg is fail-loud).
- `lowerFunction`: a non-fallible `async` function lowers with `isAsync: true` and
  the (now `Promise`-unwrapped) return type — no longer fail-loud. The fallible
  `async` rejection stays.
- `lowerExpr` gains an `AwaitExpression` case: require the argument to be a call to
  a known `async` function (else fail-loud), and return `{ kind: "await", expr:
  lowerCall(call, analysis, /*awaited*/ true) }`.
- `lowerCall(call, analysis, awaited = false)`: a call whose callee ∈ `asyncFns`
  is only valid when `awaited` (else fail-loud — the un-polled-future footgun);
  when awaited it lowers to a plain `call` node (async fns are never fallible, so
  no `?`).
- `lowerMethod`: reject an `async` method (fail-loud — async in a class deferred).
- `lower()`: after lowering the script, if `main` contains an `await` node (generic
  walk), set `mainAsync = true` so the entry becomes `#[tokio::main] async fn
  main()`.

### Numeric pass (`numeric.ts`)

`eachExpr` recurses the new node: `case "await": eachExpr(e.expr, fn)` (so a
numeric literal inside an awaited call still reaches inference). `refineStrings`
is unaffected (it walks parameters only).

## Limits (documented, not silently handled)

- **`await` only wraps a call to a known free `async` function** — every other
  `await` shape and every un-awaited `async` call is rejected.
- **`Promise<T>` unwraps to `T` wherever it appears** in a type annotation, not
  only in return position. In-dialect `Promise` only ever annotates an `async`
  return; a `Promise`-typed parameter/variable is out-of-dialect input and its
  unwrapping is unspecified.
- **No concurrency / no async I/O** — sequential `await` of in-process async
  computations only.

## Verification

- **Unit (cargo-free):** `tests/async.test.ts` drives `emit(…)` — `async fn` with
  a `Promise<string>` return unwrapped to `String` (ASYNC1), `await` → `.await`
  (ASYNC2), a top-level `await` producing `#[tokio::main] async fn main()`
  (ASYNC3), `Promise<void>` → `()` (ASYNC4), a non-async green control unchanged
  (ASYNC5), and two fail-loud rejections — an un-awaited `async` call and an
  `await` of a sync call (ASYNC6/ASYNC7).
- **Oracle (cargo-backed):** flip `07_async/01_async_await` to `SUPPORTED` (tier 1:
  COMPILES, as a library — two `async fn`s, one awaiting the other), after making
  the fixture self-contained (it currently calls an undefined `doFetch`). Add a
  tier-2 differential: the same two async functions plus a top-level `await`
  driving `#[tokio::main] async fn main()`, asserting Rust stdout equals the
  TypeScript's (`row`).

## Workflow note

Full spec-first: docs → scaffold (the HIR `await` node and `mainAsync`, the
emitter `await` case + `mainAsync` main, the AST `AwaitExpression`, `asyncFns` in
analysis, the numeric descent, and a lowering **seam** — an early `async` guard in
`lowerFunction` plus an `AwaitExpression` case, both throwing `UnsupportedError`
"async/await lowering pending" — so specs are **RED**) → **RED** → real
`Promise` unwrap, `async fn` lowering, `await` lowering, the awaited-call gate, the
`async` method rejection, and `mainAsync` detection to **GREEN** → archive.
`async` methods, `Promise` combinators/concurrency, and `async` arrows each get a
**new** series.
