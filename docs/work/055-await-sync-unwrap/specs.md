# 055 — specs

Spec-ID prefix `AWAIT`. Differential specs run the TS (via Bun) and the emitted
Rust and compare stdout — dropping the `await` on a non-future must not change the
observed value. File: `packages/compiler/tests/await-sync.test.ts`.

## Drop-await on a sync call

- **AWAIT1** (differential) `await syncFn()` on a declared non-async free fn
  yields the call's value:
  ```ts
  function compute(): number { return 7; }
  async function run(): Promise<void> { const v: number = await compute(); console.log(v); }
  await run();   // 7
  ```
  Emitted Rust calls `compute()` with **no** `.await` on it (the async `run`
  still awaits nothing here).
- **AWAIT2** (differential) `await` of a **fallible** sync fn threads `?`:
  ```ts
  function parse(x: number): number { if (x < 0) { throw new Error("neg"); } return x * 2; }
  async function run(): Promise<void> { const n: number = await parse(3); console.log(n); }
  await run();   // 6
  ```
  The fallible sync call lowers to `parse(3.0)?` (the `?` comes from `lowerCall`,
  not a real `.await`).

## Drop-await on a non-call operand

- **AWAIT3** (differential) `await x` on a plain binding yields the value:
  ```ts
  async function run(): Promise<void> { const x: number = 41; const y: number = await x; console.log(y); }
  await run();   // 41
  ```
  Emitted Rust has no `.await` on `x` (a plain `let y = x`).
- **AWAIT4** (differential) `await obj.field` yields the field:
  ```ts
  interface Box { v: number; }
  async function run(): Promise<void> { const b: Box = { v: 5 }; const r: number = await b.v; console.log(r); }
  await run();   // 5
  ```

## Drop-await on a non-async method

- **AWAIT5** (differential) `await obj.m()` where `m` is a **non-async** method
  yields the method's value:
  ```ts
  class Adder {
    base: number;
    constructor(base: number) { this.base = base; }
    add(a: number, b: number): number { return this.base + a + b; }
  }
  async function run(): Promise<void> { const s: number = await new Adder(0).add(2, 3); console.log(s); }
  await run();   // 5
  ```
  The sync method call has no `.await`.

## Regression guard

- **AWAIT6** (differential) a genuine `await asyncFn()` still emits a real
  `.await` (drop-await did not swallow the modeled-future path):
  ```ts
  async function fetchN(): Promise<number> { return 9; }
  async function run(): Promise<void> { const n: number = await fetchN(); console.log(n); }
  await run();   // 9
  ```
  Emitted Rust contains `fetchN().await`.
