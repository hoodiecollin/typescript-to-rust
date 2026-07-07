# 049 — specs

Spec-ID prefix `ERR`. The oracle is a real `cargo` toolchain (tier 1 COMPILES,
tier 2 BEHAVES / differential vs. Bun) — never string-equality on a `.rs` file.
Emitted-substring assertions below read as "the cargo-checked output contains …",
pinning the representation, not as golden files.

## 049a — enum + throw (`packages/compiler/tests/error-enum.test.ts`)

- **ERR1** a program with one `class NotFoundError extends Error {
  constructor(message: string) { super(message); } }` emits a single
  `#[derive(thiserror::Error, Debug)]` `enum AppError` containing a
  `NotFoundError { message: String }` variant and a `Other { message: String }`
  variant, each with `#[error("{message}")]`. **No** hand-written `impl
  std::fmt::Display` / `impl std::error::Error` blocks (thiserror derives them).
- **ERR2** every fallible fn's return type becomes `Result<T, AppError>` and
  `programErrType` is `appError` (not `boxError`, not `String`) once any custom
  error class is declared.
- **ERR3** `throw new NotFoundError("nope")` → `return Err(AppError::NotFoundError
  { message: "nope".to_string() });`.
- **ERR4** in the *same* program, `throw new Error("plain")` and `throw "bare"`
  both → `return Err(AppError::Other { message: … });`.
- **ERR5** the scratch crate declares `thiserror` (the dep seam); the emitted
  module references `thiserror::Error` fully-qualified with **no** `use
  thiserror::…;` prelude line.
- **ERR6** (compat guard) a program with **no** custom error class keeps `E =
  String` — no `AppError`, no `thiserror`, no `enum` (013/021/022-no-custom
  output unchanged).

## 049b — field-carrying errors (`packages/compiler/tests/error-fields.test.ts`)

- **ERR7** `class ValidationError extends Error { field: string; constructor(message:
  string, field: string) { super(message); this.field = field; } }` → a struct
  variant `ValidationError { message: String, field: String }`.
- **ERR8** `throw new ValidationError("bad", "email")` → `return
  Err(AppError::ValidationError { message: "bad".to_string(), field:
  "email".to_string() });` (fields carried, message first).
- **ERR9** (differential) a fn returns on the success path and throws a
  field-carrying error on the failure path; the caught error's `field` is read and
  printed — Rust stdout equals the TypeScript's. Exercises variant construction +
  field-carrying propagation.
- **ERR10** (fail-loud) an error class with an extra **method** (`class E extends
  Error { code(): number { return 1; } … }`) throws `UnsupportedError` (only typed
  data fields + the fixed ctor map).
- **ERR11** (fail-loud) a constructor body beyond `super(message)` + identity
  `this.f = f` (e.g. `this.field = field.toUpperCase()`) throws `UnsupportedError`.

## 049c — `instanceof` → `match` (`packages/compiler/tests/error-discriminate.test.ts`)

- **ERR12** `catch (e) { if (e instanceof NotFoundError) {…} else if (e instanceof
  ValidationError) {…} else {…} }` → `match e { AppError::NotFoundError { .. } =>
  …, AppError::ValidationError { .. } => …, other => … }`; emitted contains **no**
  `downcast_ref`.
- **ERR13** an arm that reads a field binds it owned: the `ValidationError` branch
  using `e.field` → `AppError::ValidationError { field, .. } => { … field … }`.
- **ERR14** (differential — the headline) one `try` calls a fn that throws either a
  `NotFoundError` or a `ValidationError` depending on input; the catch prints a
  distinct string per variant. Run twice (each branch); **Rust stdout equals the
  TypeScript's on both** — the catch discriminates the correct variant.
- **ERR15** an `instanceof` ladder with **no** trailing `else` still compiles: a
  `_ => {}` wildcard is appended (exhaustiveness), and non-matching errors are
  swallowed (JS parity).
- **ERR16** a catch body that is **not** a clean `instanceof` ladder (e.g.
  `if (e.message === "x")`) keeps the opaque bind — `console.log(e)` via Display,
  **no** `match e` emitted.

## 049d — catch-all + `From` glue (`packages/compiler/tests/error-from.test.ts`)

- **ERR17** a program with an `AppError` emits `impl From<String> for AppError` and
  `impl From<&str> for AppError`, both constructing `AppError::Other { message }`.
- **ERR18** `<msg>.into()` (a `String` flowing into an `AppError` slot) type-checks
  to the `Other` variant (tier 1 COMPILES).
- **ERR19** (differential) a program mixing a custom `throw`, a plain `throw new
  Error`, and a caught-and-Displayed error runs end-to-end; Rust stdout equals the
  TypeScript's (the `Other` catch-all + Display compose with 021/022 behavior).
- **ERR20** (fail-loud, #16 boundary) a discriminating catch whose arms `return`
  per branch (value-yielding) throws `UnsupportedError`
  (`return/break/continue inside try/catch …`) — deferred to #16, not silently
  lowered.
</content>
