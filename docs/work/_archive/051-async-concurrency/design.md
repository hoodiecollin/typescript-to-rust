# 051 — Async concurrency: Promise combinators, timers, and `tokio::spawn`

Graduates the async dialect's biggest deferred surface: **concurrency**. Series 014
(`async fn` + `.await`) and 016 (async×errors) shipped strictly *sequential* await
(`await asyncFn(...)` → `.await` / `.await?`). Everything concurrent —
`Promise.all`/`race`/`allSettled`, `.then` chains, timers, and task spawning — has
been fail-loud since. This series maps that whole surface onto tokio, and it is the
**Full** scope from issue #15 (Collin, 2026-07-07): it **includes `tokio::spawn`**,
which drags in the `Send + 'static + Arc<Mutex<…>>` ownership tax — the hard,
central new analysis work called out below. A rippling change, staged into three
landable slices, each differential-green.

tokio is already wired (`.scratch/Cargo.toml` pins it with `rt-multi-thread` +
`macros`); `join!`/`select!`/`spawn` are available today, timers need the `"time"`
feature, and dynamic `join_all`/`allSettled` want the `futures` crate — the two
manifest additions this series makes (§ Cargo manifest).

## Coupling — design these together

- **#14 (async methods / async arrows) is a prerequisite.** Today `asyncFns` tracks
  *free* functions only, and `lowerMethod` rejects an `async` method. Combinators
  are only broadly useful once `async` arrows/methods lower — a callback body inside
  `.then` / `Promise.all(arr.map(f))` is exactly an async arrow. This series assumes
  #14 has landed the async-arrow-as-named-fn machinery (per the #9 lambda-lifting
  decision: callback bodies → named pure fns) so a combinator callback is a nameable
  async `fn`. Where #14 has *not* landed, the combinator that needs it stays
  fail-loud (noted per slice).
- **#13 (un-awaited call → spawn) is joined to slice 051c.** Series 014 made a bare
  `asyncFn()` fail-loud (`call to an async function not directly awaited` in
  `lowerCall`, `lower.ts:2174`) — an un-polled future never runs. #13's decision is
  that an un-awaited async call becomes `tokio::spawn(f())` (an eagerly-scheduled
  task), reversing that rejection. That is 051c's core, so #13 and this slice's spawn
  work are one unit.

## Combinator → Rust mapping

| TS | Rust | Slice |
|---|---|---|
| `p.then(cb)` (non-async, single-expr `cb`) | sequential `let __t = p.await; cb(__t)` | 051a |
| `Promise.all([a(), b()])` (fixed arity, heterogeneous) | `tokio::join!(a(), b())` → tuple `(A, B)` | 051a |
| `Promise.all([...])` where any element is fallible | `tokio::try_join!(a(), b())?` → `(A, B)` | 051a |
| `Promise.race([a(), b()])` (fixed arity) | `tokio::select! { r = a() => r, r = b() => r }` | 051a |
| `Promise.all(arr.map(f))` (homogeneous, dynamic) | `futures::future::join_all(arr.into_iter().map(f)).await` → `Vec<T>` | 051b |
| `Promise.allSettled([...])` | `join_all(...).await` → `Vec<Result<T, String>>` | 051b |
| `await sleep(ms)` (awaited-timer idiom) | `tokio::time::sleep(Duration::from_millis(ms)).await` | 051b |
| un-awaited `asyncFn()` / explicit `spawn(f())` | `tokio::spawn(f())` → `JoinHandle<T>` | 051c |
| `await handle` (a spawned-task handle) | `handle.await.unwrap()` | 051c |
| `setTimeout(fn, ms)` (callback timer) | `tokio::spawn(async move { sleep(...).await; fn(); })` | 051c |

### `.then` desugar (051a)

`p.then(cb)` is JS promise chaining; the dialect models the common shape only —
`cb` a **non-async, single-expression arrow** applied to the resolved value:

```ts
fetchRow(id).then(row => row.length)
```
```rust
{ let __then_0 = fetch_row(id).await; __cb_then_0(__then_0) }
```

The callback body lifts to a named pure `fn` (the #9 mechanism, `__cb_then_0`);
`then` becomes a sequential `await` of the receiver followed by application. Chained
`.then(a).then(b)` nests left-to-right. A rejecting-branch `.then(onOk, onErr)` (two
args) and an **async** `cb` stay fail-loud (051c may revisit async `cb` once spawn
exists; the two-arg reject handler is `catch` territory — a different series).

### `Promise.all` — `join!` / `try_join!` (051a)

Fixed-arity `Promise.all([a(), b(), c()])` (an **array literal** of async calls) →
`tokio::join!`, which polls all futures concurrently and yields a **tuple** of their
outputs. The result binding destructures the tuple:

```ts
const [u, p] = await Promise.all([getUser(id), getPosts(id)]);
```
```rust
let (u, p) = tokio::join!(get_user(id), get_posts(id));
```

If **any** element future is fallible, the whole expression is fallible: emit
`tokio::try_join!(...)` (short-circuits on the first `Err`) and `?`-propagate — the
fallibility fixpoint (`analyzeFallible`) already makes the enclosing fn `Result`, so
the `?` is well-typed, exactly as `lowerAwait` does today. `join!` yields
`(A, B)`; `try_join!` yields `Result<(A, B), E>` → `?` → `(A, B)`.

Heterogeneous element types are fine (a tuple is heterogeneous). The array must be a
**literal** of statically-known arity so the tuple shape is known at emit time; a
`Promise.all(dynamicArray)` is the 051b `join_all` path (homogeneous, `Vec`).

### `Promise.race` — `select!` (051a)

Fixed-arity `Promise.race([a(), b()])` → `tokio::select!`, which polls concurrently
and returns the **first** future to complete:

```ts
const winner = await Promise.race([slow(), fast()]);
```
```rust
let winner = tokio::select! { r = slow() => r, r = fast() => r };
```

All arms must have the **same output type** `T` (`select!` arms unify to one type;
JS `race` is likewise untyped-but-single-valued) — a homogeneity requirement `join!`
does not have. A heterogeneous `race` is fail-loud.

> **Documented divergence — `race` drops the losers.** JS leaves the losing promises
> *running* (they settle later, side effects and all); `tokio::select!` **drops** the
> unpolled arms at the end of the block, cancelling them at their next await point.
> For pure computations this is unobservable; for side-effecting losers it diverges.
> This is the dialect's accepted semantics (confirmed by Collin during the #15
> decision) — recorded in the new **Semantic divergences** section of `dialect.md`
> (the section #28 introduces), *not* made fail-loud.

### `join_all` / `allSettled` — dynamic fan-out (051b)

`Promise.all(arr.map(f))` — a **homogeneous, dynamic-arity** fan-out — cannot be a
tuple; it maps to `futures::future::join_all`, which drives a `Vec` of same-typed
futures to a `Vec<T>`:

**Both callback shapes are accepted (Collin, 2026-07-08).** The `.map(f)` fan-out
callback may be either form, both driving to an iterator of futures fed to `join_all`:

1. **Inline non-async closure** — `ids.map(id => fetchRow(id))` (a non-async arrow
   whose body is a call to an async fn, i.e. it *returns* a future). Emits an inline
   `|id| fetch_row(id)` closure; Rust infers the future type — no lift, no typer.

   ```ts
   const rows: Array<Row> = await Promise.all(ids.map(id => fetchRow(id)));
   ```
   ```rust
   let rows: Vec<Row> = futures::future::join_all(ids.into_iter().map(|id| fetch_row(id))).await;
   ```

2. **Lifted async arrow** — `ids.map(async id => await fetchRow(id))` (consumes the
   054c async-lift readiness). Lifts to `async fn __cb_map_<n>(id: T) -> R`, emitting
   `.map(__cb_map_n)`. The body is an `await` of an async call, so its return type `R`
   comes from `asyncCallItemType` (the Promise-inner of the inner call) — **not** the
   numeric-surface typer, which stays unchanged. `join_all(ids.into_iter().map(__cb_map_n))`.

`join_all` on **fallible** element futures yields `Vec<Result<T, E>>` — which is
exactly `allSettled`'s shape, so `Promise.allSettled([...])` → the same `join_all`,
typed `Vec<Result<T, String>>` (each settled outcome is a `Result`; `E` stays
`String`, the project-uniform error type). `Promise.all` over fallible dynamic
futures (which should short-circuit) uses `try_join_all` and `?`-propagates.

### Timers (051b)

The dialect has no real clock; the one modeled timer idiom is an **awaited sleep**:

```ts
await sleep(ms);   // sleep is the dialect's declared delay primitive
```
```rust
tokio::time::sleep(std::time::Duration::from_millis(ms as u64)).await;
```

`sleep` is recognized as a built-in async delay (like `console.log` is a built-in);
`ms` is a `number` → `Duration::from_millis(ms as u64)`. Needs the tokio `"time"`
feature (§ Cargo manifest). A bare `sleep(ms)` un-awaited rides the 051c spawn path
(`setTimeout`). Real `Date`/`performance.now` timing stays out of dialect.

## The spawn / `Arc<Mutex>` ownership extension — the big piece (051c)

This is the substantial new analysis work and the reason #15 is a large series.

**The mapping is small; the ownership consequence is not.**

- An **un-awaited async call** (previously fail-loud in `lowerCall`) → `tokio::spawn(f())`,
  which returns a `JoinHandle<T>`. The `spawn` schedules the task eagerly (matching
  JS's eager-promise semantics), unlike the un-polled bare call 014 rejected.
- `await handle` where `handle` is a `JoinHandle` → `handle.await.unwrap()` (a
  `JoinHandle`'s `.await` yields `Result<T, JoinError>`; `.unwrap()` surfaces a panic
  in the task — a documented "a spawned task that panicked aborts the program"
  divergence, acceptable since the dialect never observes `JoinError`).
- `setTimeout(fn, ms)` → `tokio::spawn(async move { sleep(ms).await; fn_body(); })`
  (a fire-and-forget delayed task); `fn` lifts via #9/#14.

**The tax.** `tokio::spawn` requires its future be `Send + 'static`. That has two
teeth:

1. **`'static`** — the spawned future may outlive the spawning scope, so it cannot
   borrow locals. Anything it uses must be **owned** (moved in) — `async move`.
2. **`Send` + shared mutable state** — if two tasks (or a task and its parent) both
   touch the same state, a plain `move` can only give it to one. Shared *read* state
   must become `Arc<T>` (clone the handle into each task); shared *mutable* state must
   become `Arc<Mutex<T>>` (lock to mutate). This is the tax JS never pays (single
   threaded event loop, shared mutable heap for free).

**New ownership-pass work (the central deliverable of 051c).** The ownership analysis
(the pass that today decides move/`&`/`&mut` per binding) gains a **task-escape
analysis**:

- Identify every binding **captured by a spawned task body** (transitively through
  the lifted callback's free-var/param list — the #9 lambda-lift already computes the
  free-var set; reuse it).
- A binding captured by **one** task and unused after → plain `move` into the task
  (no `Arc`).
- A binding captured by **≥2 tasks**, or by a task **and** still used by the parent →
  wrap in `Arc<T>`; each capture site clones the `Arc` (`let s = Arc::clone(&s);`
  before the `spawn`).
- A binding that is **mutated** inside a task and shared → `Arc<Mutex<T>>`; reads
  become `*s.lock().unwrap()`, writes `*s.lock().unwrap() = …`. Emit the `Arc::new` /
  `Arc::new(Mutex::new(…))` at the binding's declaration and rewrite every downstream
  use (parent and task) to the `Arc`/lock form.

This is a genuinely new pass shape: today ownership is *intra-function* (who consumes
a value within one body); task-escape is *inter-body* (a value crosses into a
concurrently-running body). New HIR is needed to carry the decision to the emitter:

- `HirExpr` `{ kind: "spawn"; expr }` → `tokio::spawn(<expr>)`.
- `HirExpr` `{ kind: "joinHandleAwait"; expr }` → `<expr>.await.unwrap()` (distinct
  from the plain `await` node so the emitter picks `.await.unwrap()` vs `.await`).
- A binding-level wrap marker on `HirLet` (e.g. `share?: "arc" | "arcMutex"`) so
  `emitLet` renders `Arc::new(...)` / `Arc::new(Mutex::new(...))`, plus an
  `{ kind: "arcClone"; name }` capture-prep node and a `{ kind: "lockDeref"; … }` use
  node. (Exact node set is a 051c scaffold detail; the ownership pass populates them.)

### Increment 2 — the inter-procedural task-escape pass (Collin, 2026-07-08)

Increment 1 shipped the single-task, move-capture spawn surface (spawn / `JoinHandle`
await / `setTimeout`, args restricted to Copy/literal). Increment 2 adds the **shared
mutable state** analysis, and Collin chose the **inter-procedural** model: shared state
crosses into a task as a **function argument** of the spawned async call, and the
receiving async fn's **signature + body are rewritten** to the `Arc`/`Arc<Mutex>` form.

**Worked example (CONC22 — a shared, mutated counter):**

```ts
async function incr(c: Counter): Promise<void> { c.n += 1; }
const counter: Counter = { n: 0 };
const h1 = incr(counter);      // spawn #1 captures counter
const h2 = incr(counter);      // spawn #2 captures counter
await h1; await h2;
console.log(counter.n);        // parent reads after
```
```rust
async fn incr(c: std::sync::Arc<std::sync::Mutex<Counter>>) { c.lock().unwrap().n += 1.0; }
let counter = std::sync::Arc::new(std::sync::Mutex::new(Counter { n: 0.0 }));
let h1 = tokio::spawn(incr(std::sync::Arc::clone(&counter)));
let h2 = tokio::spawn(incr(std::sync::Arc::clone(&counter)));
h1.await.unwrap(); h2.await.unwrap();
println!("{}", counter.lock().unwrap().n);
```

**The algorithm.**

1. **Capture graph.** For each `spawn`ed async call `f(…args…)`, record which of its
   args are **bindings** (identifiers). A binding is a *task-escaping capture* if it is
   passed to **≥2** spawned calls, **or** to **1** spawned call **and still used after
   the spawn in the parent scope**. (A binding passed to exactly one spawn and never
   used after is a plain move — increment 1's case, no wrap.)
2. **`Arc` vs `Arc<Mutex>`.** The wrap is `Arc<Mutex<T>>` if the value is **mutated** —
   either the receiving async fn mutates the param (its inferred param ownership is
   `refMut`, the existing ownership signal), or the parent mutates the binding after a
   spawn. Otherwise a shared **read** → plain `Arc<T>`.
3. **Rewrite set.**
   - **Binding declaration** → `Arc::new(<init>)` (read) / `Arc::new(Mutex::new(<init>))`
     (mutated).
   - **Each spawn-arg site** → `Arc::clone(&binding)` (a fresh handle moved into the task).
   - **Parent uses after** → for `Arc<Mutex>`, a read/write goes through
     `binding.lock().unwrap()` (`.n` field access composes: `counter.lock().unwrap().n`);
     for plain `Arc`, reads compose via `Deref` (`binding.field` unchanged).
   - **Receiving async fn** → its param type becomes `Arc<T>` / `Arc<Mutex<T>>`, and its
     body's accesses to that param are rewritten to the lock form (mutated) or left as-is
     (read, `Deref`). This is the inter-procedural part.

**Conflict rule (fail-loud).** An async fn called **both** shared (spawned with a wrapped
arg) **and** unshared (a direct `await f(plainValue)`) has an irreconcilable param type
→ `UnsupportedError` ("async fn used both as a spawned shared-state task and a direct
call — split it"). Increment 2 requires a shared-capture async fn be shared-only.

**Fully-qualified paths.** Emit `std::sync::Arc` / `std::sync::Mutex` fully qualified (no
`use` prelude), matching the emitter's `thiserror::`/`tokio::` convention. No new crate.

**Honest boundary for 051c.** Only shapes the task-escape analysis can prove sound are
emitted. A binding captured mutably by a task **whose lifetime the analysis cannot
bound** (e.g. escaping into a `Vec<JoinHandle>` that is never joined), shared state with
an aliasing pattern the pass can't reduce to `Arc`/`Arc<Mutex>`, or the shared/unshared
conflict above, stays fail-loud (`UnsupportedError`). We never emit a `spawn` that would
not compile.

## Cargo manifest additions

This series reuses the **Cargo-dep injection seam from series 049** (the mechanism
that lets a lowering decision add a crate/feature to the emitted `.scratch/Cargo.toml`
rather than pinning everything unconditionally). Two additions, both gated on the
feature actually being used (present-but-unused costs nothing at check time, matching
the existing tokio/indexmap/serde comment convention in the manifest):

- **tokio `"time"` feature** — enable `time` on the existing tokio dependency
  (`features = ["rt-multi-thread", "macros", "time"]`) when the program lowers a
  `sleep`/`setTimeout`. Timers do not compile without it.
- **`futures` crate** — add `futures = "0.3"` when the program lowers `join_all` /
  `try_join_all` / `allSettled` (the dynamic fan-out path). `join!`/`try_join!`/
  `select!`/`spawn` are tokio macros and need **no** new crate — 051a and 051c add no
  dependency; only 051b touches the manifest for `futures`, and 051b's timers flip the
  tokio `"time"` feature.

## Slices (each lands green) — ordered by cost

1. **051a — `.then` + fixed-arity `join!`/`try_join!`/`select!`.** Zero new deps, zero
   ownership change. Highest value per surface. `.then` desugar (receiver `await` +
   lifted `cb`), `Promise.all([lit])` → `join!`/`try_join!` → tuple, `Promise.race([lit])`
   → `select!`. Requires only fixed-arity array literals of async calls; leans on #14
   for the `.then` callback (else that shape waits). New HIR: `join`, `tryJoin`,
   `select`, and the `.then` desugar (no new node — reuses `await` + `call`).
2. **051b — dynamic `join_all`/`allSettled` + awaited timers.** Adds the `futures`
   crate and the tokio `"time"` feature (the manifest seam). `Promise.all(arr.map(f))`
   → `join_all` → `Vec`, `Promise.allSettled` → `join_all` → `Vec<Result<…>>`,
   `try_join_all` for fallible fan-out, `await sleep(ms)` → `tokio::time::sleep`. New
   HIR: `joinAll` (with a fallible flag), `sleep`.
3. **051c — `tokio::spawn` + `Arc`/`Mutex` + `setTimeout`.** The big slice: the
   task-escape ownership pass, the `Arc`/`Arc<Mutex>` wrapping, `spawn`/`JoinHandle`,
   and callback `setTimeout`. Joined with #13 (un-awaited call → spawn). New HIR:
   `spawn`, `joinHandleAwait`, the `HirLet.share` marker + `arcClone`/`lockDeref`
   nodes. Sequence **last** — everything above is sound without the ownership tax, and
   this slice is where the analysis risk concentrates.

## Fail-loud residuals (documented, not silently handled)

- **`.then` with an async callback, or a two-arg `.then(onOk, onErr)`** — the async
  `cb` may relax in 051c once spawn exists; the reject handler is `catch` territory
  (a different series).
- **Non-literal / dynamic-arity `Promise.all` / `race`** that is *not* the
  `arr.map(f)` fan-out shape — fail-loud (no known tuple arity, no homogeneous `Vec`).
- **Heterogeneous `Promise.race`** — `select!` arms must unify to one `T`.
- **`Promise.any`** — first *fulfillment* (skipping rejections) has no one-liner tokio
  analog; fail-loud until a fixture demands it.
- **Real async I/O / real clocks** (`fetch`, sockets, `Date.now`, `performance.now`) —
  the dialect has no async I/O surface; `sleep` is the only modeled delay.
- **A spawned task captured into an unbounded `Vec<JoinHandle>` never joined**, or
  shared-mutable-across-tasks state the task-escape pass cannot reduce to `Arc`/
  `Arc<Mutex>` — fail-loud (`shared mutable state across tasks not provably safe`).
  We never emit a `spawn` that would fail `Send + 'static`.
- **`JoinError` (a panicked task)** is `.unwrap()`ed, aborting — a documented
  divergence from JS's unhandled-rejection semantics, not a modeled surface.
