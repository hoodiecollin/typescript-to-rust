# 016 — Specs

Unit specs drive the public `emit(...)` entry (parse → lower → emit → Rust
string) and assert the shape of a fallible `async function`: the `async fn … ->
Result<T, String>` signature, the `<call>.await?` propagation, the async fallible
`main`, a non-fallible green control, and the still-fail-loud non-awaited call.
The cargo-backed BEHAVES proof lives in the differential test. IDs are referenced
from the test files.

## Unit — async×errors via `emit` (`tests/async-throw.test.ts`)

Reference program unless noted:
```ts
async function risky(n: number): Promise<number> {
  if (n < 0) { throw new Error("neg"); }
  return n / 2;
}
async function caller(n: number): Promise<number> {
  const x: number = await risky(n);
  return x;
}
```

- **ATHROW1** a fallible `async function` emits `async fn … -> Result<T, String>`
  with `Err`/`Ok`-wrapped bodies.
  emitted Rust contains `async fn risky(n: f64) -> Result<f64, String> {`,
  `return Err("neg".to_string());`, and `return Ok(n / 2.0);`.

- **ATHROW2** `await <fallibleAsyncCall>` propagates with `<call>.await?`.
  emitted Rust contains `risky(n).await?`.

- **ATHROW3** a top-level `await` of a fallible async fn makes the entry a fallible
  tokio runtime `main`.
  program `+ \nconst r: number = await caller(10);\nconsole.log(r);` → emitted
  Rust contains `#[tokio::main]` and `async fn main() -> Result<(), String>`.

- **ATHROW4 (green control)** a non-fallible async fn is unchanged — no `Result`
  wrap, a bare `.await`.
  `async function ping(): Promise<number> { return 1; }\nasync function use1():
  Promise<number> { const v: number = await ping(); return v; }` → contains
  `async fn ping() -> f64 {` and `ping().await` and **not** `Result` nor
  `.await?`.

- **ATHROW5 (fail-loud)** a non-awaited fallible async call is still rejected (an
  un-polled future never runs, `Result` or not).
  `async function w(): Promise<string> { throw new Error("x"); }\nw();` →
  `emit(...)` throws.

## Oracle — differential (`tests/compiler.test.ts`)

- **Tier 2 (BEHAVES):** a throwing async fn, an awaiter, and a top-level `await` on
  the success path
  ```ts
  async function risky(n: number): Promise<number> {
    if (n < 0) { throw new Error("negative"); }
    return n / 2;
  }
  async function caller(n: number): Promise<number> {
    const x: number = await risky(n);
    return x;
  }
  const r: number = await caller(10);
  console.log(r);
  ```
  → Rust stdout equals the TS stdout (`5`). Exercises `async fn … -> Result`,
  `.await?` (the nested fallible await), and `#[tokio::main] async fn main() ->
  Result<(), String>`. Both throwing branches stay untaken, so the two runtimes
  agree on the success path (as in the series-013 differential).
