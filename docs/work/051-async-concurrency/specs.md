# 051 — specs

Spec-ID prefix `CONC`. Staged by slice. Differential specs assert Rust stdout equals
the TypeScript's (concurrency behaves — order, results, and awaited task values
match); emitted-Rust substring checks pin the chosen tokio/futures shape. At least
one fail-loud spec per slice.

## 051a — `.then` + fixed-arity `join!`/`try_join!`/`select!` (`packages/compiler/tests/conc-fixed.test.ts`)

- **CONC1** `fetchRow(id).then(row => row.length)` (single-expr non-async `cb`) lowers
  to a sequential `await` of the receiver then the lifted callback; emitted contains
  `.await` and the hoisted `fn __cb_then` (no `.then` in output).
- **CONC2** `const [a, b] = await Promise.all([getA(), getB()])` → emitted contains
  `tokio::join!(get_a(), get_b())` and destructures the tuple `let (a, b) =`.
- **CONC3** (differential) `Promise.all([one(), two()])` returning `[1, 2]` prints the
  same tuple values as the TS (`1 2`) — `join!` yields both results, order preserved.
- **CONC4** a `Promise.all` whose elements are **fallible** async calls → emitted
  contains `tokio::try_join!(` and `?`; the enclosing fn is `Result<…>`.
- **CONC5** (differential) `try_join!` short-circuits: a two-element all where the
  second throws propagates the error — Rust and TS both surface the same rejection.
- **CONC6** `await Promise.race([slow(), fast()])` → emitted contains `tokio::select!`
  with one arm per future, arms unified to one type.
- **CONC7** (differential) `race([slow, fast])` where `fast` resolves first prints
  `fast`'s value in both TS and Rust (the winner wins; loser dropped).
- **CONC8** (fail-loud) a **heterogeneous** `Promise.race([num(), str()])` is
  `UnsupportedError` (`select!` arms must unify to one type).
- **CONC9** (fail-loud) a two-arg `.then(onOk, onErr)` stays `UnsupportedError`
  (reject handler is `catch` territory).

## 051b — dynamic `join_all` / `allSettled` + timers (`packages/compiler/tests/conc-dynamic.test.ts`)

- **CONC10** `await Promise.all(ids.map(id => fetchRow(id)))` → emitted contains
  `futures::future::join_all(` and `.await`, result typed `Vec<`; the manifest gains
  `futures`.
- **CONC11** (differential) the dynamic fan-out over `[1, 2, 3]` prints the same
  `Vec` of results in both TS and Rust, in order.
- **CONC12** `Promise.allSettled([...])` → `join_all` yielding `Vec<Result<T, String>>`;
  emitted result type contains `Vec<Result<`.
- **CONC13** (differential) `allSettled` over a mix of a resolving and a throwing call
  yields the same per-element `Ok`/`Err` outcomes in both (nothing short-circuits).
- **CONC14** `await sleep(50)` → emitted contains
  `tokio::time::sleep(std::time::Duration::from_millis(50` and `.await`; the tokio
  `"time"` feature is enabled in the manifest.
- **CONC15** (differential) a program that awaits `sleep` then prints produces the same
  final output as the TS (timing is unobservable; the value after the delay matches).
- **CONC16** (fail-loud) a **heterogeneous** dynamic `Promise.all` (elements of
  differing type, not an `arr.map(f)` fan-out) is `UnsupportedError` (no homogeneous
  `Vec`).

## 051c — `spawn` + `Arc`/`Mutex` + `setTimeout` (`packages/compiler/tests/conc-spawn.test.ts`)

- **CONC17** an un-awaited async call `const h = doWork()` → emitted contains
  `tokio::spawn(do_work())` and `h` is a `JoinHandle`.
- **CONC18** `await h` on a spawned handle → emitted contains `.await.unwrap()`
  (distinct from the plain `.await`).
- **CONC19** (differential) spawn a task, `await` its handle, print the result — Rust
  and TS print the **same value** (a spawned task's result is correctly awaited).
- **CONC20** state **read** by two spawned tasks → the ownership pass wraps it
  `Arc<…>`; emitted contains `Arc::new(` and `Arc::clone(&` at each capture site.
- **CONC21** state **mutated** by a spawned task and read by the parent → wrapped
  `Arc<Mutex<…>>`; emitted contains `Arc::new(Mutex::new(` and `.lock().unwrap()`.
- **CONC22** (differential) two tasks incrementing a shared `Arc<Mutex<f64>>` counter,
  joined, then printed — Rust's final total equals the TS's (shared mutation behaves).
- **CONC23** `setTimeout(fn, ms)` → emitted contains `tokio::spawn(async move {` and
  `tokio::time::sleep(` before the lifted `fn` body.
- **CONC24** (fail-loud) shared mutable state a task captures whose lifetime the
  task-escape pass cannot bound (e.g. into an unjoined `Vec<JoinHandle>`) stays
  `UnsupportedError` (`shared mutable state across tasks not provably safe`) — no
  `spawn` that would fail `Send + 'static` is ever emitted.
