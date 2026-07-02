# 013 — Errors: `throw` → `Result<T, E>` + `?`

## Problem

TypeScript signals failure by `throw`; any function may throw, and the error
propagates up the call stack implicitly until a `try`/`catch` (or the top). Rust
has no exceptions: a fallible function returns `Result<T, E>`, and propagation is
explicit via the `?` operator. The `08_errors/01_throw.ts` fixture is the smallest
case (still `test.todo`):

```ts
function crash(): void {
  throw new Error("Crash!");
}
```

This is a **return-type rewrite**, not a `panic!`. `panic!` aborts the thread and
would change catch semantics (an uncatchable unwind); `Result` + `?` models the
*value* semantics of a thrown-then-propagated error, which is what a later
`try`/`catch` slice will consume. The error payload is the `Error` **message**, so
`E` is uniformly `String` this slice — `throw new Error(msg)` → `Err(msg)`.

The target compiles and runs (verified with `rustc`):

```rust
fn crash() -> Result<(), String> {
    return Err("Crash!".to_string());
}
```

and, end-to-end with propagation:

```rust
fn half(n: f64) -> Result<f64, String> {
    if n < 0.0 {
        return Err("negative".to_string());
    }
    return Ok(n / 2.0);
}

fn main() -> Result<(), String> {
    let x = half(10.0)?;
    println!("{}", x);
    return Ok(());
}
```

## Scope (decided 2026-07-02)

**In:** the *propagation* side — a **free function** (or the generated `main`)
that throws or calls something that throws.

- **Fallibility (a fixpoint).** A function is *fallible* iff its body `throw`s, or
  it (transitively) calls a fallible function. Computed over the top-level call
  graph in `analysis.ts` (`analysis.fallible`, including the `SCRIPT_SCOPE`
  sentinel for `main`). This is the pivot every other decision reads.
- **Return type.** A fallible function's return type wraps: `T` → `Result<T,
  String>` (`void` → `Result<(), String>`). A new `RustType` `{ kind: "result";
  ok; err }`.
- **`throw`.** `throw new Error(<msg>)` → a new `HirStmt` `{ kind: "throw"; value
  }` that emits `return Err(<msg>);`. `msg` lowers as an expression (a string
  literal → `"…".to_string()`), so `Err` carries a `String`. Only
  `throw new Error(<single arg>)` is accepted; any other `throw` (a bare value, a
  re-throw, a subclass, no/for-more args) is fail-loud.
- **Normal returns.** Inside a fallible function every `return v` → `return
  Ok(v)`, and `return;` → `return Ok(());` — a `makeFallible` HIR transform that
  recurses through `if`/`while`/`block`/`for`/`match` bodies. A new `HirExpr`
  `{ kind: "ok"; value: HirExpr | null }` (`null` ⇒ `Ok(())`).
- **Fall-through.** A fallible `void` function whose body does not end in a
  diverging statement (a `return`/`throw`) gets a trailing `return Ok(());`
  appended (the non-throwing path must still yield `Ok`). `main` is the common
  case.
- **`?` propagation.** A call to a fallible function → `<call>?` (a new `HirExpr`
  `{ kind: "try"; expr }` → `<expr>?`). The fixpoint guarantees the enclosing
  function is itself fallible, so its return type is already `Result` and `?` is
  well-typed.
- **`main`.** When the top-level script calls a fallible function (or throws),
  the generated entry becomes `fn main() -> Result<(), String>` with wrapped
  returns and a trailing `Ok(())`. `HirModule` gains an optional `mainRet`
  (absent ⇒ `()`, the existing behaviour).

**Deferred — own later series (documented, not silently handled):**

- **`try` / `catch` / `finally`** — the *recovery* side. This slice only
  propagates; catching a `Result` (into a `match`/`if let`/`unwrap_or`) is the
  next errors series.
- **Custom error types / `Error` subclasses / an error enum / `Box<dyn Error>`** —
  `E` is uniformly `String` (the message). A richer error type is a follow-up.
- **`throw` of a non-`new Error(...)` value** — `throw "msg"`, `throw someVar`,
  `throw new Error()` (no message) or with `> 1` arg, re-throw — all rejected.
- **Throwing / propagation inside a class method, constructor, or `async`
  function** — rejected fail-loud (a method/ctor body containing a `throw`/`?`, or
  an `async` fallible function, throws `UnsupportedError`). Fallibility is analysed
  for free functions + the script only; methods and `async` are their own series.
- **Ignoring an error** (`.unwrap()`, `void`-ing a `Result`, storing a `Result`
  as a first-class value) — a fallible call is always `?`-propagated in the
  dialect; there is no other total mapping without `try`/`catch`.

**Out:** unwinding/`panic!` semantics; `Result` combinators (`map`/`and_then`).

## Design

### AST (`ast.ts`)

Add `ThrowStatement { argument: Expression }` (verified against real parser
output — the argument of the fixture is a `NewExpression` calling `Error`). Add it
to the `Statement` union. `NewExpression` already exists (series 012).

### HIR (`hir.ts`)

```ts
export type RustType = … | { kind: "result"; ok: RustType; err: RustType };
export type HirExpr  = … | { kind: "ok"; value: HirExpr | null }   // Ok(x) / Ok(())
                         | { kind: "try"; expr: HirExpr };          // expr?
export type HirStmt  = … | { kind: "throw"; value: HirExpr };       // return Err(value)
export interface HirModule { …; mainRet?: RustType; }               // absent ⇒ ()
```

### Emitter (`emitter.ts`) — the shape (lands in the scaffold)

- `emitType`: `result` → `Result<ok, err>`.
- `emitExpr`: `ok` → `Ok(<value>)` / `Ok(())`; `try` → `<expr>?`.
- `emitStmt`: `throw` → `return Err(<value>);`.
- `emitModule`: `main`'s signature reads `mod.mainRet` (`fn main() -> Result<…>`);
  the trailing `Ok(())` is already in `mod.main` (added by `makeFallible`).

The pure/total emitter's exhaustiveness guard forces each of these the moment the
HIR kind is added (a `switch` returning `string` with no `default`).

### Lowering (`lower.ts`) — the gate

- `analysis.fallible` drives everything. `lowerFunction`: if the function is
  fallible, wrap its `ret` in `result(ret, String)` and run `makeFallible(body,
  ret)`; reject a fallible `async` function (deferred).
- `lowerStatement` gains a `ThrowStatement` case → `lowerThrow`, which requires
  `new Error(<one arg>)` and yields `{ kind: "throw", value }`.
- `lowerCall`: a call whose callee name ∈ `analysis.fallible` is wrapped
  `{ kind: "try", expr: call }`.
- `makeFallible(stmts, okTy)`: recurse the statement tree; `return v` →
  `return Ok(v)`, `return;` → `return Ok(())`; append a trailing `return Ok(())`
  when `okTy` is `()` and the body does not already diverge.
- `lower()`: after lowering the script, if `SCRIPT_SCOPE` is fallible, run
  `makeFallible(main, ())` and set `mainRet = result((), String)`.
- `lowerClass`: after building the ctor/methods, reject if any body contains a
  `throw`/`try` HIR node (throwing inside a class is deferred, fail-loud).

### Numeric / string passes

`refineNumerics` descends into the new nodes: `eachStmtExpr` visits a `throw`'s
value; `eachExpr` recurses `ok` (its value, if any) and `try` (its inner expr).
`refineStrings` is unaffected (no new params).

## Limits (documented, not silently handled)

- **`E = String`** (the `Error` message) for every fallible function.
- **Free functions + script only** — `throw`/`?` inside a method/ctor/`async` is
  rejected.
- **Every fallible call is `?`-propagated** — no catching, ignoring, or storing a
  `Result` yet.

## Verification

- **Unit (cargo-free):** `tests/errors.test.ts` drives `emit(…)` — the return-type
  wrap `fn half(n: f64) -> Result<f64, String>` (ERR1), `throw` → `return
  Err("negative".to_string());` (ERR2), a normal `return` → `return Ok(n / 2.0);`
  (ERR3), `?` propagation + `fn main() -> Result<(), String>` (ERR4), and a
  non-throwing green control with no `Result`/`?` (ERR5).
- **Oracle (cargo-backed):** flip `08_errors/01_throw` to `SUPPORTED` (tier 1:
  COMPILES, as a library — `fn crash() -> Result<(), String>`), and add a tier-2
  differential: a `half` (throws on negative, returns on success) and a `void`
  `announce` (throws on negative, else prints), both called from the script on
  their success paths — asserting Rust stdout equals the TypeScript's (`7\n5`).
  This exercises the return-type wrap, `Err`/`Ok` wrapping, the trailing `Ok(())`
  (void `announce` + `main`), and `?` propagation through `main`.

## Workflow note

Full spec-first: docs → scaffold (the HIR `result`/`ok`/`try`/`throw` nodes and
`mainRet`, the emitter cases, and a `ThrowStatement` seam in `lower.ts` that
throws `UnsupportedError` "throw → Result lowering pending"; the fallibility
fixpoint and `?`/wrap are stubbed so specs are **RED**) → **RED** → real
`analysis.fallible`, `lowerThrow`, `makeFallible`, `?`-wrap, and `main` handling to
**GREEN** → archive. `try`/`catch`, custom error types, and throwing in
methods/`async` each get a **new** series.
