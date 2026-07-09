# 054 — `async` methods & `async` arrows

Graduates the async-surface deferral that #14 tracks and that **051 depends on**:
today `async` is accepted **only on free `function` declarations** (series 014/016).
`async` *methods* are fail-loud (`lowerMethod`, `lower.ts:1747`), and `async` *arrows*
are fail-loud in every form (`topLevelConstArrow` bails on `arrow.async`,
`lower.ts:329`; a callback arrow lifts to a **non-async** `fn`, `liftCallback`
hard-codes `isAsync: false`, `lower.ts:3434`). This series extends the async lowering to
**method receivers**, **top-level `const` async arrows**, and the **lambda-lift
machinery** so a callback body can be a nameable `async fn`.

Sequenced **first** in the async run (`054 → 051 → 052`, per the 051↔052 overlap spike
and Collin's 2026-07-08 decision to land #14 as its own series). 051 assumes this
machinery is present.

## Scope decision (Collin, 2026-07-08)

The async-arrow surface splits by *consumability*, and Collin chose the **wider** cut:

- **Async methods** — MODELED (directly-awaited only; see below).
- **Top-level `const f = async () => …`** — MODELED (open the normalize gate; it already
  flows through the async free-fn path).
- **Async callback lift** — the lift machinery becomes **async-aware now**
  (`liftCallback` emits an `async fn __cb_*`), but async-callback-in-**adapter**
  (`arr.map(async x => …)`) stays **fail-loud** in 054, because driving the resulting
  `Vec<Future>` to values is `Promise.all(arr.map(f))` → `join_all`, which lands in
  **051b**. This is an accepted **half-wired seam**: 054 lands the async-lift capability;
  051b flips the adapter guard and adds the `join_all` consumer. (The alternative —
  deferring the lift entirely to 051b — was rejected so 051b is a clean drop-in.)

## What stays fail-loud (maintained residuals)

- **A bare, un-awaited async call** — free fn, method, or arrow — stays fail-loud
  (`call to an async function not directly awaited`, `lowerCall`, `lower.ts:2954`). An
  un-polled future never runs; un-awaited-call-→-`spawn` is **051c** (#13). This series
  only *awaits* async things.
- **(No residual here — async + throw already composes.)** Verified empirically: a free
  `async` fn that throws already emits `async fn w() -> Result<T, String>` and awaits with
  `.await?` (the fallibility fixpoint + `lowerAwait`'s `try`-wrap handle it; the stale
  comment at `lower.ts:2951` notwithstanding). Async **methods** therefore compose the
  same way — the existing `fallibleMethods` branch in `lowerMethod` (`lower.ts:1775`)
  already emits `async fn m(&self) -> Result<…>` once the async rejection is removed, and
  `lowerAwait` `?`-propagates an awaited fallible async method exactly as for a free fn.
  Nothing new to reject.
- **`async` callback in an adapter** (`arr.map/filter/…(async …)`) — fail-loud in 054
  with a message pointing at 051b (`join_all`). The lift runs; the *consumption* is the
  residual.
- **Async generators (`async function*`)** — `DialectError`, unchanged (the async-gen
  `Stream` story is the deferred follow-up from the 051↔052 spike).

## Async methods

`lowerMethod` (`lower.ts:1738`) rejects `fn.async`. Graduation is three coordinated
edits plus one analysis addition, all mirroring the existing method-fact machinery:

1. **Analysis — `asyncMethods: Set<string>`** (`analysis.ts`), populated in the same
   `MethodDefinition` walk that builds `mutatingMethods`/`fallibleMethods`
   (`analysis.ts:526/662/912`): `if (m.value.async) asyncMethods.add(m.key.name)`. Keyed
   by method name, inheriting the existing **cross-class same-name limit** already
   documented for `fallibleMethods` (`analysis.ts:110`).
2. **`lowerMethod`** — drop the `fn.async` rejection; set `isAsync: fn.async` on the
   emitted `HirFn` (exactly as `lowerFunction` does at `lower.ts:445/452`). The `self`
   receiver (`&self`/`&mut self` from `mutatingMethods`) is unchanged; a sequential
   `await` inside the body composes because the future borrowing `&self` is awaited
   before `self` is used again.
3. **`lowerAwait`** (`lower.ts:2876`) — today requires the callee be an `Identifier` in
   `asyncFns` (`lower.ts:2885`). Extend it to accept a **member-expression callee**
   `await obj.method(...)` where the property name is in `analysis.asyncMethods`; lower
   the receiver + args as an ordinary method call and wrap in the `{kind:"await"}` node.
   A `.await` on a member call emits identically (`recv.method(args).await`). The
   maintained residual: `await obj.method()` where `method` is **not** async is fail-loud
   (`await of a call to a non-async function`, generalized to methods).

The emitter needs **no change** — it already renders `async ` from `fn.isAsync` for both
free fns and methods (`emitter.ts:240,374`).

## Top-level `const` async arrows

`arrowToFunctionDecl` **already** carries `async: arrow.async` (`lower.ts:310`) — the
synthetic `FunctionDeclaration` is async-ready. The *only* block is the guard in
`topLevelConstArrow` (`lower.ts:329`): `if (arrow.async) return null;`. Remove it, and:

- `normalizeArrows` (runs *before* analysis, `lower.ts:143`) rewrites
  `const f = async () => …` into an async `FunctionDeclaration`.
- `analyzeModule` sees it as a named async fn → `asyncFns.add(name)` (`analysis.ts:1008`).
- `lowerFunction` sets `isAsync: true` and emits `async fn f(...)`.
- `await f(...)` works through the existing `lowerAwait` Identifier path unchanged.

The `=> expr` (expression-body) desugar is already handled by `arrowToFunctionDecl`
(wraps in `{ return <expr>; }`, `lower.ts:294`). The doc comment on `normalizeArrows`
(`lower.ts:262`) is updated to drop "non-`async`". Non-top-level / `let`-bound / value-
position async arrows stay fail-loud (the existing arrow deferral boundary, unchanged).

## Async-aware lambda lift (`liftCallback`)

`liftCallback` (`lower.ts:3386`) becomes async-aware:

- Thread `isAsync: arrow.async` into the pushed `HirFn` (`lower.ts:3431-3438`) so the
  lifted callback is `async fn __cb_<method>_<n>(...) -> T { return <body>; }`.
- The body-typing (`typeCbBody`) and free-var forwarding (Copy-scalar-only) are unchanged
  — an async callback's free-var discipline is identical.

**Adapter consumption guard.** At each adapter site that lifts a callback
(`lower.ts:3024-3146`: map/filter/find/some/every/reduce/sort), if the callback arrow is
`async`, throw `UnsupportedError` **before wiring the adapter chain**:
`async callback in '.<method>' — dynamic async fan-out (Promise.all(arr.map(f)) → join_all) lands in series 051`.
So in 054 the async-lift code path is reachable and correct, but no adapter *emits* a
`Vec<Future>` it can't consume. 051b removes this guard for the `map`→`join_all` shape.

> **Testing the half-wired seam.** The `liftCallback` `isAsync` threading is
> **readiness code** — dormant in 054 (the adapter guard rejects before any async
> callback would be lifted through an adapter) and first *exercised* in 051b, where it
> becomes a clean drop-in. In 054 it is covered by two live specs: the **fail-loud spec**
> (AM14 — the precise 051-pointing message proves the guard fires) and the **non-async
> regression control** (AM15 — a plain `arr.map(x => x*2)` still lifts to a *non*-`async`
> `fn __cb_*`, proving the threading change didn't regress 048). This is the accepted
> cost of landing the seam ahead of its consumer, per the scope decision above.

## New HIR + analysis surface

- **`ModuleAnalysis.asyncMethods: Set<string>`** — the only new analysis field.
- **No new HIR node.** `HirFn.isAsync` already exists and already flows to the emitter;
  methods reuse it. `lowerAwait`'s member-callee case reuses the existing `{kind:"await"}`
  node over a method-call `HirExpr`.

## Slices (each lands green)

1. **054a — async methods.** `asyncMethods` analysis, `lowerMethod` graduation,
   `lowerAwait` member-callee case (incl. the `fallibleMethods` `?`-propagation mirror).
   Differential: an object with an `async` method, `await obj.m()`, prints the same value
   as the TS; a throwing async method propagates via `.await?` and behaves. Fail-loud:
   bare un-awaited async method call; `await` of a non-async method.
2. **054b — top-level `const` async arrows.** Open the `topLevelConstArrow` gate; update
   the doc comment + `dialect.md`. Differential: `const f = async () => …; await f()`
   (block body and `=> expr` body) behaves identically. Fail-loud: a `let`-bound / value-
   position async arrow stays rejected.
3. **054c — async-aware lift + adapter guard.** Thread `isAsync` through `liftCallback`;
   add the adapter async-callback fail-loud guard. Coverage: the fail-loud spec for
   `arr.map(async …)` (points at 051). Lands the seam 051b consumes.

## `dialect.md` sync

- Async section: `async` now accepted on **methods** and **top-level `const` arrows**
  (not just free `function`s); the directly-awaited-only rule and the maintained
  residuals (bare un-awaited call → 051c; fallible-async; async-callback-in-adapter →
  051b; `async function*` → future) stay listed.
- Closures section: note that the lambda-lift can now emit an `async fn` callback, with
  the adapter-consumption residual.
