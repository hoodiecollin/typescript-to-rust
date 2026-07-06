# 022 — Errors: custom error types (`Box<dyn Error>`)

## Problem

Series 013 fixed the error payload as a **`String`** (the `Error` message), so
every fallible function is `Result<T, String>` and every `throw` carries a bare
message. Real programs define their own error *types* to distinguish failures:

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
```

Rust's idiomatic "any error type" is a **trait object**: `Box<dyn
std::error::Error>`. A user error type is a `struct` implementing `Display` +
`Debug` + `Error`; `?` auto-converts any such error into the boxed type via the
blanket `From` impls, and `Box<dyn Error>` also has `From<String>`/`From<&str>`,
so a plain `throw new Error(msg)` still composes. Verified with `rustc`:

```rust
struct NotFoundError { message: String }
impl NotFoundError {
    fn new(message: String) -> NotFoundError { NotFoundError { message } }
}
impl std::fmt::Display for NotFoundError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::fmt::Debug for NotFoundError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for NotFoundError {}

fn lookup(id: f64) -> Result<f64, Box<dyn std::error::Error>> {
    if id < 0.0 {
        return Err(Box::new(NotFoundError::new("no such id".to_string())));
    }
    return Ok(id * 2.0);
}
```

## Scope (decided 2026-07-06)

**In:** declaring custom error classes and throwing/propagating them, with the
program error type conditionally upgraded to `Box<dyn Error>`.

- **The recognized shape.** A `class <Name> extends Error { constructor(message:
  string) { super(message); } }` — an `Error` subclass with **exactly** a
  single-`message`-param constructor whose body is `super(message);` and **no**
  other members. This one shape → a Rust error type. Any deviation (extra fields,
  extra methods, a different constructor, `extends` something other than `Error`)
  stays fail-loud (richer custom errors are a later series).
- **Emission.** Each recognized class → a `struct <Name> { message: String }`, an
  associated `fn new(message: String) -> <Name>`, and `impl`s for
  `std::fmt::Display`, `std::fmt::Debug`, and `std::error::Error` (all
  fully-qualified — no `use` prelude needed). `Display`/`Debug` both `write!` the
  message.
- **The program error type (the pivot).** Compute one module-wide error type: if
  the program declares **any** custom error class, `E = Box<dyn
  std::error::Error>` for *every* fallible function/`main`; otherwise `E = String`
  (unchanged — series 013/021 behaviour). A single uniform `E` is what lets `?`
  compose across all fallible functions.
- **Throws under a boxed `E`.**
  - `throw new <CustomError>(msg)` → `return Err(Box::new(<CustomError>::new(msg)));`
    (modelled as a `call` to `Box::new` wrapping a `call` to `<CustomError>::new`
    — no new HIR node).
  - `throw new Error(msg)` / `throw "msg"` → `return Err(<msg>.into());` (the
    boxed `From<String>` conversion — modelled as a `method` call `.into()`).
  - When `E = String` (no custom classes) these stay exactly as today
    (`Err(<msg>)`), so series 013/021 output is unchanged.
- **`RustType`.** Add `{ kind: "boxError" }` → `Box<dyn std::error::Error>`.
  `resultType(ok)` reads the module error type instead of hard-coding `String`.

**Deferred — own later series (documented, not silently handled):**

- **Discriminating a caught error by type** — `catch (e) { if (e instanceof
  NotFoundError) … }`. Catching (series 021) binds the whole `Box<dyn Error>`;
  reading its message via `Display` (`console.log(e)` → `println!("{}", e)`)
  composes, but downcasting to a specific type (`e.downcast_ref::<T>()`) is its
  own series.
- **Error types with extra fields or methods** (`class E extends Error { code:
  number; … }`) — only the fixed `{ message }` shape maps; anything else is
  fail-loud.
- **A hand-rolled error `enum`** (a closed set with `match`) — `Box<dyn Error>`
  is the open-world choice this slice; a synthesized program error enum (enabling
  exhaustive `match` on variants) is an alternative future design.
- **`extends` of a non-`Error` class**, deep error hierarchies, `error.cause`,
  custom `name`/`stack` — out.

**Out:** `thiserror`/`anyhow`-style derives; `?`-with-context (`.context(...)`).

## Design

### AST (`ast.ts`)

No new nodes — `ClassDeclaration` (with `superClass`) already parses. `super(...)`
inside the constructor is a `CallExpression` with a `Super` callee; the recognized
shape is validated structurally in lowering.

### Analysis (`analysis.ts`)

`ModuleAnalysis` gains `errorClasses: Set<string>` — the names of declared custom
error classes (a `ClassDeclaration` whose `superClass` is the identifier `Error`).
These names are **not** added to `structs` (they are not general nominal data
types); `lowerThrow` consults the set, and the module error type is `Box<dyn
Error>` iff the set is non-empty.

### HIR (`hir.ts`)

```ts
export type RustType = … | { kind: "boxError" };   // Box<dyn std::error::Error>

/** A custom error class: struct { message: String } + new + Display/Debug/Error impls. */
export interface HirErrorClass { kind: "errorClass"; name: string; }
export type HirItem = HirFn | HirStruct | HirClass | HirErrorClass;
```

### Emitter (`emitter.ts`)

- `emitType`: `boxError` → `Box<dyn std::error::Error>`.
- `emitItem`: an `errorClass` → the fixed struct + `impl new` + `Display` +
  `Debug` + `Error` blocks (a string template parameterised by `name`).

### Lowering (`lower.ts`) — the gate

- A module-level `ERR_PROGRAM: RustType` computed in `lower()`:
  `analysis.errorClasses.size > 0 ? { kind: "boxError" } : ERR_STRING`. Threaded
  into `resultType` (which now takes the err type) so every fallible signature —
  free fns, `main`, and the 021 `tryCatch` closure — uses it.
- `lowerClass` recognises `extends Error`: when `decl.superClass` is the
  identifier `Error`, dispatch to `lowerErrorClass`, which validates the exact
  `{ constructor(message: string) { super(message); } }` shape and returns a
  `HirErrorClass` (any deviation → `UnsupportedError`).
- `lowerThrow(stmt, analysis, errProgram)`:
  - `new <X>(msg)` where `X ∈ errorClasses` → value =
    `Box::new(<X>::new(<msg>))` (nested `call`s).
  - `new <Builtin>(msg)` / `"literal"` → value = `<msg>` when `errProgram` is
    `String` (today), or `<msg>.into()` (a `.into()` `method`) when `errProgram`
    is `boxError`.

### Numeric / string passes

Unaffected (no new params or numeric contexts); the `errorClass` item has no
lowerable bodies, and the `boxError` type never carries a numeric.

## Limits (documented, not silently handled)

- **One fixed error shape** — `{ message: String }` only.
- **Boxed, not enum** — `Box<dyn Error>`, so no exhaustive `match` on error
  variants; discrimination in `catch` is deferred (downcast).
- **Program-uniform `E`** — a single custom error class makes *all* fallible
  functions `Box<dyn Error>` (so `?` composes), even ones that only throw plain
  `Error`.

## Verification

- **Unit (cargo-free):** `tests/custom-errors.test.ts` drives `emit(…)` and
  asserts: the struct + `impl std::error::Error for <Name> {}` (CE1); the
  `fn new(message: String) -> <Name>` and `Display` `write!` (CE2); a fallible
  fn's return type becomes `Result<f64, Box<dyn std::error::Error>>` (CE3); a
  custom `throw` → `Err(Box::new(NotFoundError::new("…".to_string())))` (CE4); a
  plain `throw new Error("…")` in the *same* program boxes via `.into()` (CE5);
  and a green control with **no** custom error class keeps `E = String` — no
  `boxError`, no `Box<dyn` (CE6, the 013/021-compat guard).
- **Oracle (cargo-backed):** add `08_errors/03_custom_error` and flip it to
  `SUPPORTED` (COMPILES — the struct, impls, boxed throw, and `main -> Result<(),
  Box<dyn …>>` all type-check), plus a tier-2 differential on the **success**
  path (`lookup(3)` → `6`) so both runtimes agree while the throwing branch (the
  boxed custom error) is proven to compile at tier 1. (Catching + printing a
  custom error at runtime composes with series 021 — noted, exercised there.)

## Workflow note

Spec-first: docs → scaffold (the `boxError` `RustType`, the `HirErrorClass` item +
emitter block, the `errorClasses` analysis field, and `lowerErrorClass` /
`ERR_PROGRAM` seams throwing `UnsupportedError` "custom error types pending" so
specs are **RED**) → **RED** → real `lowerErrorClass`, the program-error-type
threading, and the boxed-throw lowering to **GREEN** → archive. Downcast-based
`catch` discrimination, error enums, and richer error shapes each get a **new**
series.
