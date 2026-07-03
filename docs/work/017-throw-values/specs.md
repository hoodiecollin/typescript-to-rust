# 017 — Specs

Unit specs drive the public `emit(...)` entry (parse → lower → emit → Rust
string) and assert that `throw` accepts the built-in Error subclasses and a
string literal, each → `return Err(<String>);`, and stays fail-loud on the
deferred shapes. The cargo-backed BEHAVES proof lives in the differential test.
IDs are referenced from the test files.

## Unit — throw values via `emit` (`tests/throw-values.test.ts`)

- **THROWV1** `throw new TypeError(msg)` lowers to `Err(msg)` in a `Result` fn.
  `function f(n: number): number { if (n < 0) { throw new TypeError("bad"); }
  return n; }` → emitted Rust contains `-> Result<f64, String>` and
  `return Err("bad".to_string());`.

- **THROWV2** a second subclass `throw new RangeError(msg)` lowers to `Err(msg)`.
  `function f(n: number): number { if (n < 0) { throw new RangeError("oor"); }
  return n; }` → contains `return Err("oor".to_string());`.

- **THROWV3** a string-literal `throw "boom"` lowers to `Err("boom".to_string())`.
  `function f(n: number): number { if (n < 0) { throw "boom"; } return n; }` →
  contains `return Err("boom".to_string());`.

- **THROWV4 (green control)** a plain `throw new Error(msg)` is unchanged.
  `function f(n: number): number { if (n < 0) { throw new Error("x"); } return n;
  }` → contains `return Err("x".to_string());`.

- **THROWV5 (fail-loud)** a non-built-in error class is rejected (custom error
  types are a later series).
  `function f(n: number): number { if (n < 0) { throw new Foo("x"); } return n; }`
  → `emit(...)` throws.

- **THROWV6 (fail-loud)** a bare variable throw is rejected (needs type tracking
  to confirm `String`).
  `function f(s: string): void { throw s; }` → `emit(...)` throws.

- **THROWV7 (fail-loud)** a two-argument `Error` (a `cause`) is rejected.
  `function f(n: number): void { if (n < 0) { throw new Error("x", {}); } }` →
  `emit(...)` throws.

## Oracle — differential (`tests/compiler.test.ts`)

- **Tier 2 (BEHAVES):** a function whose two untaken branches throw a `RangeError`
  and a bare string, returning on the success path
  ```ts
  function classify(n: number): string {
    if (n < 0) { throw new RangeError("negative"); }
    if (n === 0) { throw "zero not allowed"; }
    return "positive";
  }
  console.log(classify(5));
  ```
  → Rust stdout equals the TS stdout (`positive`). Exercises the subclass throw and
  the string-literal throw in one compiling `Result` program (both throw branches
  untaken, so the runtimes agree on the success path).
