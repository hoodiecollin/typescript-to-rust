# 014 — Specs

Unit specs drive the public `emit(...)` entry (parse → lower → emit → Rust
string) and assert the emitted shape of `async`/`await` → `async fn` +
`#[tokio::main]`: the `async fn` keyword, the `Promise<T>` → `T` return unwrap,
`await` → `.await`, the runtime `main`, and the fail-loud rejections. The
cargo-backed COMPILES/BEHAVES proof lives in the fixture and differential test.
IDs are referenced from the test files.

## Unit — async via `emit` (`tests/async.test.ts`)

Reference program unless noted:
```ts
async function doFetch(id: number): Promise<string> {
  return "row";
}
async function fetchData(id: number): Promise<string> {
  const res: string = await doFetch(id);
  return res;
}
```

- **ASYNC1** an `async function` emits `async fn` and its `Promise<T>` return
  unwraps to `T`.
  emitted Rust contains `async fn fetchData(id: f64) -> String {`.

- **ASYNC2** `await <asyncCall>` lowers to `<call>.await`.
  emitted Rust contains `doFetch(id).await`.

- **ASYNC3** a top-level `await` makes the generated entry a tokio runtime `main`.
  program `+ \nconst out: string = await fetchData(1);\nconsole.log(out);` →
  emitted Rust contains `#[tokio::main]` and `async fn main()`.

- **ASYNC4** `Promise<void>` unwraps to `()` (a bare `async fn`, no `-> `).
  `async function ping(): Promise<void> { console.log("hi"); }` → contains
  `async fn ping() {` and **not** `-> `.

- **ASYNC5 (green control)** a program with no `async` and no `await` emits
  unchanged — no `async`, no `.await`, no `#[tokio::main]`. The `await` node,
  `mainAsync`, `asyncFns`, and the `Promise` unwrap do not regress existing
  lowering.
  `function id(n: number): number { return n; }` → contains `fn id(n: f64) ->
  f64 {` and **not** `async`, **not** `.await`, **not** `tokio`.

- **ASYNC6 (fail-loud)** a call to an `async` function that is not `await`ed is
  rejected (an un-polled future never runs — no silent no-op Rust).
  `async function w(): Promise<string> { return "x"; }\nw();` → `emit(...)`
  throws.

- **ASYNC7 (fail-loud)** `await` of a call to a non-`async` function is rejected
  (only `await <asyncFn>(...)` maps).
  `function s(): string { return "x"; }\nasync function g(): Promise<string> {
  return await s(); }` → `emit(...)` throws.

## Oracle — fixture + differential (`tests/compiler.test.ts`)

- **Tier 1 (COMPILES):** `07_async/01_async_await` moves into `SUPPORTED`. The
  fixture is first made self-contained (it currently `await`s an undefined
  `doFetch`): a `doFetch` `async function` is added so the emitted library — two
  `async fn`s, one `.await`ing the other — passes `cargo check --lib` (dead-code
  and `non_snake_case` warnings do not fail `cargo check`).

- **Tier 2 (BEHAVES):** a top-level `await` drives the runtime `main`
  ```ts
  async function doFetch(id: number): Promise<string> { return "row"; }
  async function fetchData(id: number): Promise<string> {
    const res: string = await doFetch(id);
    return res;
  }
  const out: string = await fetchData(1);
  console.log(out);
  ```
  → Rust stdout equals the TS stdout (`row`). Exercises `async fn`, the
  `Promise<string>` → `String` unwrap, `.await` (both the nested call and the
  top-level one), and `#[tokio::main] async fn main()`.
