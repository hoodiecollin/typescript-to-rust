# 022 — Specs

Unit specs drive the public `emit(...)` entry and assert the emitted shape of
custom error types: the error `struct` + `Display`/`Debug`/`Error` impls, the
`Box<dyn Error>` program error type, a boxed custom `throw`, a boxed plain
`throw` via `.into()`, and — critically — that a program with **no** custom error
class is unchanged (`E = String`). The cargo COMPILES/BEHAVES proof lives in the
fixture + differential.

## Unit — custom errors via `emit` (`tests/custom-errors.test.ts`)

Reference program unless noted:
```ts
class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
  }
}
function lookup(id: number): number {
  if (id < 0) {
    throw new NotFoundError("no such id");
  }
  if (id === 0) {
    throw new Error("zero reserved");
  }
  return id * 2;
}
```

- **CE1** a custom error class lowers to a `struct` implementing `Error`.
  emitted Rust contains `struct NotFoundError {` and
  `impl std::error::Error for NotFoundError {}`.

- **CE2** it gets an associated `new` and a `Display` impl writing the message.
  emitted Rust contains `fn new(message: String) -> NotFoundError {` and
  `impl std::fmt::Display for NotFoundError` and `write!(f, "{}", self.message)`.

- **CE3** with a custom error class present, a fallible function's error type is
  `Box<dyn Error>`.
  emitted Rust contains
  `fn lookup(id: f64) -> Result<f64, Box<dyn std::error::Error>> {`.

- **CE4** a custom `throw` boxes the constructed error.
  emitted Rust contains
  `return Err(Box::new(NotFoundError::new("no such id".to_string())));`.

- **CE5** a plain `throw new Error(msg)` in the same (boxed) program converts via
  `.into()`.
  emitted Rust contains `return Err("zero reserved".to_string().into());`.

- **CE6 (compat control)** a program with **no** custom error class keeps
  `E = String` — the 013/021 behaviour, unregressed.
  `function half(n: number): number { if (n < 0) { throw new Error("neg"); } return n / 2; }`
  → contains `Result<f64, String>` and **not** `boxError`, **not** `Box<dyn`,
  **not** `.into()`.

## Deferral spec (fail-loud, `UnsupportedError`)

- **CEX1** an error class with extra members is rejected (only the fixed
  `{ message }` shape maps).
  `class E extends Error { code: number; constructor(message: string) { super(message); } }`
  → `emit` throws.

## Oracle — fixture + differential (`tests/compiler.test.ts`)

- **Tier 1 (COMPILES):** `08_errors/03_custom_error` moves into `SUPPORTED`; its
  emitted Rust (the struct, the four impls, the boxed throw, and
  `main -> Result<(), Box<dyn std::error::Error>>`) must pass `cargo check`.
  ```ts
  class NotFoundError extends Error {
    constructor(message: string) {
      super(message);
    }
  }
  function lookup(id: number): number {
    if (id < 0) {
      throw new NotFoundError("no such id");
    }
    return id * 2;
  }
  const x: number = lookup(3);
  console.log(x);
  ```

- **Tier 2 (BEHAVES):** the success path (`lookup(3)` → `6`) → Rust stdout equals
  TS stdout (`6`). The throwing branch (the boxed custom error) stays untaken so
  the runtimes agree; its compilation is proven at tier 1. (Runtime catch +
  message print of a custom error is exercised by series 021's composition note.)
