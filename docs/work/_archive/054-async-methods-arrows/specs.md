# 054 — specs

Spec-ID prefix `AM`. Staged by slice. Differential specs (`behaves`) assert Rust
stdout == TS stdout == expected (Tier-1 COMPILES + Tier-2 BEHAVES via `runRust` +
Bun); emitted-substring checks pin the chosen `async fn` / `.await` shape. At least
one fail-loud spec per slice. No golden `.rs` files.

## 054a — async methods (`packages/compiler/tests/async-method.test.ts`)

- **AM1** an object/class with an `async` method emits `async fn <m>(&self, …) -> T`
  (the method signature carries `async `; the receiver is unchanged).
- **AM2** (differential) `await obj.m(x)` on an async method prints the same value as
  the TS — emitted contains `<recv>.m(<x>).await`.
- **AM3** an `async` method with a `Promise<void>` return lowers to a bare `async fn`
  (no `-> `), and a program awaiting it behaves.
- **AM4** (differential) an async method that reads `this.field` (`&self`) awaits and
  reads the same field value in both runtimes.
- **AM5** (differential) a `&mut self` async method (mutates `this.field`, sequential
  await) mutates and reads back identically.
- **AM6** (fail-loud) a **bare, un-awaited** async method call
  (`obj.m()` as a statement) is `UnsupportedError` (`not directly awaited` — un-polled
  future; spawn is 051c).
- **AM7** (differential) an `async` method that **throws** on one path composes as
  `async fn m(&self) -> Result<…>`; an `await obj.m()` propagates via `.await?` and the
  error surfaces identically in both runtimes (mirrors the free async-fn behavior — not a
  residual).
- **AM8** (fail-loud) `await obj.m()` where `m` is **not** async is `UnsupportedError`
  (`await of a call to a non-async function`, generalized to methods).

## 054b — top-level `const` async arrows (`packages/compiler/tests/async-arrow.test.ts`)

- **AM9** `const f = async (id: number): Promise<string> => { return "row"; }` emits a
  free `async fn f(id: f64) -> String` (block body, via `normalizeArrows`).
- **AM10** (differential) `const f = async () => …; const x = await f(); console.log(x)`
  behaves identically to the TS (the normalized async arrow is awaitable).
- **AM11** (differential) the **expression-body** form
  (`const dbl = async (n: number): Promise<number> => n * 2`) desugars to
  `{ return n * 2; }` inside an `async fn` and behaves.
- **AM12** a top-level async arrow with a top-level `await` of it makes the entry a
  tokio runtime main (`#[tokio::main]` + `async fn main`).
- **AM13** (fail-loud) a **`let`-bound** or **value-position** async arrow stays
  `UnsupportedError` (the arrow deferral boundary is unchanged for non-top-level-const).

## 054c — async-aware lift + adapter guard (`packages/compiler/tests/async-lift.test.ts`)

- **AM14** (fail-loud) an async callback in an adapter
  (`arr.map(async x => …)`) is `UnsupportedError` with a message pointing at series 051
  (`dynamic async fan-out … → join_all`) — the accepted half-wired seam; consumption is
  051b's.
- **AM15** (green control) the existing **non-async** callback lift is unregressed — a
  `arr.map(x => x * 2)` still lifts to a non-async `fn __cb_map_1` (no `async` keyword on
  the lifted fn) and behaves. Guards the `isAsync`-threading change against regressing
  048.
