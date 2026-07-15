# 049 — Errors: whole-program `AppError` enum + `instanceof` catch discrimination

Graduates the two coupled error deferrals in **one** series (`_pending-decisions.md`,
DECISION 2026-07-07): **#18** (error *representation* — a real error enum with
fields) and **#17** (the *consumer* — discriminating a caught error by type). #18
is what #17 matches on, so they land together: the enum in 049a/b, the catch
lowering in 049c, the catch-all/`From` glue in 049d.

The pivot: series 022 fixed `E = Box<dyn std::error::Error>` the moment any custom
error class is declared, which erases variant identity (no exhaustive `match`),
hides fields, and forces `downcast_ref` (borrow-fighting, non-owned) for
discrimination. This series replaces that with **one whole-program `enum AppError`**
so a `catch` becomes a native exhaustive `match` with **owned, field-carrying**
narrowed bindings.

## Type mapping

| TS | Rust |
|---|---|
| `class Foo extends Error { … }` (recognized shape) | a variant `AppError::Foo { message: String, …fields }` |
| `throw new Foo(msg, …)` | `Err(AppError::Foo { message, … })` |
| `throw new Error(msg)` / `throw "lit"` | `Err(AppError::Other { message })` (catch-all variant) |
| program error type `E` (any custom class present) | `AppError` (uniform, program-wide) |
| program error type `E` (no custom class) | `String` (unchanged — 013/022-no-custom) |
| `catch (e) { if (e instanceof Foo) … }` | `match e { AppError::Foo { .. } => …, … }` |

New `RustType`: `{ kind: "appError" }` → `AppError`. It **replaces** `boxError` as
the "custom errors present" program error type; `boxError` and the per-class
`Display`/`Debug`/`Error` hand-impls (022) are retired (fewer moving parts — one
enum, thiserror-derived).

## The enum synthesis (the core of #18)

One program-wide item, synthesized in `lower()` once, from `analysis.errorClasses`
plus a fixed catch-all:

```rust
#[derive(thiserror::Error, Debug)]
enum AppError {
    #[error("{message}")]
    NotFoundError { message: String },
    #[error("{message}")]
    ValidationError { message: String, field: String },
    #[error("{message}")]
    Other { message: String },
}
```

- **Variants = declared custom error classes**, each a **struct variant** carrying
  `message: String` first, then its declared typed fields (049b). A program with
  no custom classes synthesizes **nothing** (stays `E = String`).
- **`Other { message: String }`** — the catch-all for a plain `throw new Error(msg)`
  / `throw "lit"` / any built-in `Error` subclass throw. Always present when the
  enum exists (so a mixed program still handles bare throws).
- **Derive `#[derive(thiserror::Error, Debug)]`** — thiserror generates `Display`
  (from `#[error("…")]`) and `impl std::error::Error`. No hand-written `Display`/
  `Error` blocks (this is the departure 022 explicitly deferred). `Debug` is a
  plain derive (unblocks `console.log(e)` → `{:?}` and satisfies thiserror's
  `Error: Debug` bound).
- **Fully-qualified** — the derive path is `thiserror::Error`, so **no `use
  thiserror::…;`** prelude is emitted (consistent with the fully-qualified-paths
  convention in 022's emitter and `derives.ts`'s `serde::Serialize`).

### Open sub-question — synthesizing `#[error("…")]` with extra fields

thiserror's `#[error("…")]` is the variant's `Display`. When a variant carries
only `message`, `#[error("{message}")]` is exact (matches JS `String(err)` ≈ the
message). When it carries **extra fields**, the options are:

- **(A) `#[error("{message}")]` regardless** — Display shows only the message;
  extra fields stay first-class in `match`, unshown by `Display`. **Recommended**:
  mirrors JS, where `String(err)` / `console.log(err.message)` show the message,
  not custom own-properties; keeps `console.log(e)` (022's Display path) stable
  and slice-049a-compatible.
- **(B) synthesize `#[error("{message} (field={field}, …)")]`** — richer Display,
  but invents a format JS never emits (a silent divergence in printed output).
- **(C) require the user to not rely on Display when fields exist** — needless.

**Design commits to (A)**; note it in `dialect.md`. (B) is a future opt-in if a
fixture demands field-in-message rendering.

## The Cargo-dependency seam (first non-`tslib` crate)

`AppError` is the **first generated-output dependency on an external crate**
(`thiserror`) — every prior dep in `rust-oracle/Cargo.toml` (tokio, indexmap, serde,
bumpalo) is present-but-unused-until-a-feature-routes-to-it; thiserror is the same
*shape* of seam, so the mechanism is established:

- **Harness / oracle:** add `thiserror = "2"` to `packages/compiler/rust-oracle/Cargo.toml`
  (alongside the existing present-but-unused deps — costs nothing at check time
  when no error enum is emitted). This is what makes the 049 differential specs
  compile. Pin it so the offline cache stays warm (same note as tokio).
- **`use`-line seam:** none needed — `thiserror::Error` is referenced
  fully-qualified in the derive, so `emitModule`'s `imports` array is untouched.
  (Contrast indexmap/`Rc`, which do add `use` lines.) The only emitter change is
  the new `emitErrorEnum` item.
- **Real emitted projects (future):** the CLI (`bun run ttr`) emits a bare `.rs`
  string today — there is no generated `Cargo.toml`. A real manifest-emission step
  (a `neededCrates(mod)` scan → generated `[dependencies]`) is **out of scope
  here** but is the natural home for this seam; note that **#15 (async
  combinators) will reuse it for the `futures` crate**. Until then the differential
  oracle relies on the committed scratch manifest, exactly as async/JSON/arena do.

## Field-shape relaxation (widening `lowerErrorClass`)

022 accepted **exactly** `constructor(message: string) { super(message); }` and
**zero** other members. 049b relaxes the recognized shape to **message + declared
typed data fields**:

- **Fields:** any number of `field: T` class properties (each a lowerable data type
  — scalar/`String`/`bool`/struct/`Vec`/`Option`, reusing `lowerType`). Each
  becomes a variant field `field: <RustType>`.
- **Constructor:** first param is `message: string` (→ `super(message)`); remaining
  params map 1:1 to declared fields. Body limited to **`super(message);` followed by
  identity assignments `this.f = f;`** — one per declared field, RHS is the
  bare matching param identifier. **Anything else stays fail-loud**: computed RHS
  (`this.f = f.trim()`), defaults, reordering, extra statements, extra methods,
  getters, `extends` non-`Error`. (A structural relaxation, not a general
  constructor lowering.)
- `analysis.errorClasses` widens from a `Set<string>` to carry each class's ordered
  `{ name, fields: {name, ty}[] }` (so the enum synthesizer and `lowerThrow` know
  the variant shape). `derives.ts`'s `buildStructTable` still **excludes** error
  classes (they are enum variants, not data structs).

## Program-uniform `E` = `AppError` + `From` glue

Kept **program-uniform** (022's invariant): one custom error class widens *every*
fallible fn's `E` to `AppError`, so `?` composes across the whole call graph
(accept the "one class widens everyone" tax — the note in `_pending-decisions.md`).

- **`programErrType(analysis)`** returns `{ kind: "appError" }` when
  `errorClasses` is non-empty, else `ERR_STRING` (drops the `boxError` branch).
- **Own-throw construction is direct** — `throw new Foo(a, b)` lowers straight to
  `Err(AppError::Foo { message: a, field: b })` (a new `enumVariant` HIR expr).
  No `From`/`.into()` needed between our own fns (their `?` already yields
  `AppError`).
- **`From` glue (049d)** for foreign/`String` values flowing into the enum: emit
  `impl From<String> for AppError` and `impl From<&str> for AppError`, both
  constructing `Other { message }`. This keeps `<msg>.into()` (022's `boxIfNeeded`
  path) and any `?` on a `Result<_, String>` composing into `AppError`. `throw new
  Error(msg)` lowers directly to `Err(AppError::Other { message: msg })` (no
  `.into()` round-trip); the `From` impls exist for interop + ergonomics, not the
  common throw path.

## #17 — the catch → `match` lowering

Consume the enum in `lowerTry`'s catch body. Recognize the **`instanceof` ladder**
shape and lower it to a native exhaustive `match` (or `if let` ladder) over the
owned bound error — **no `downcast_ref`**:

```ts
catch (e) {
  if (e instanceof NotFoundError) { … }
  else if (e instanceof ValidationError) { … e.field … }
  else { … }
}
```
```rust
match e {
    AppError::NotFoundError { .. } => { … }
    AppError::ValidationError { field, .. } => { … field … }
    other => { … }
}
```

- **Recognized shape:** the catch body is a single `if`/`else if`/…/`else` chain
  whose every non-final test is `e instanceof <CustomClass>` (the catch param, a
  declared error class). Each branch → a `match` arm binding that variant; a
  branch reading `e.field` binds the field owned (`Foo { field, .. }`), else `{ .. }`.
- **The `else` → the wildcard arm** `other => { … }` (binds the whole error owned).
- **No `else` → append `_ => {}`** for exhaustiveness (Rust requires it); this
  matches JS, where a ladder with no `else` silently completes the catch for
  non-matching errors (swallowed). Note this parity in `dialect.md`.
- **`instanceof` on a *built-in* class** (`e instanceof TypeError`) → fail-loud
  (all built-in throws collapse into `Other`, so there is no variant to match; a
  future refinement could split `Other`).
- **A catch that is *not* a clean ladder** (property tests, `e.message === …`,
  `switch`) keeps the 022/021 opaque bind — `catch (e) { console.log(e) }` still
  lowers to `if let Err(e) = … { … }` with Display; **no `match`**.

New HIR: extend the `tryCatch` node with an optional `discriminant?: HirMatchArm[]`
(the recognized ladder, pre-lowered to arms). When present, the emitter renders
`if let Err(e) = <closure> { match e { …arms } }`; when absent, the existing
`catchBody` path is unchanged.

## Coupling to #16 (value-yielding try/catch)

A discriminating catch whose arms **`return` a value per branch** (`catch (e) { if
(e instanceof Foo) return a; else return b; }`) overlaps #16's deferred surface:
`lowerTry` already rejects `return`/`break`/`continue` escaping the closure
(`escapesClosure`). 049 keeps that boundary — the discriminating `match` lowers
only for **statement-level** catch bodies; a per-branch-returning discriminator
stays **fail-loud** and is #16's job. Noted so #16's design accounts for the
`discriminant` arms yielding values.

## HIR changes

```ts
export type RustType = … | { kind: "appError" };          // AppError (replaces boxError)

/** The one synthesized program error enum. Variants carry ordered typed fields
 *  (message first) and a thiserror `#[error(display)]` string. */
export interface HirErrorEnum {
  kind: "errorEnum";
  variants: { name: string; fields: { name: string; ty: RustType }[]; display: string }[];
}
export type HirItem = … | HirErrorEnum;   // HirErrorClass retired

/** `AppError::Foo { f: v, … }` — a struct-variant construction. */
export type HirExpr = … | { kind: "enumVariant"; enumName: string; variant: string; fields: { name: string; value: HirExpr }[] };

export interface HirTryCatch {   // extends the existing tryCatch node
  …;
  discriminant?: HirMatchArm[];  // the recognized `instanceof` ladder → match arms
}
```

The pure/total emitter's exhaustiveness switch forces `emitType(appError)`,
`emitErrorEnum`, and `emitExpr(enumVariant)` the moment each kind is added.

## Slices (each lands green)

1. **049a — enum + throw.** Synthesize `AppError` (message-only variants + `Other`)
   with `#[derive(thiserror::Error, Debug)]` + `#[error("{message}")]`;
   `programErrType` → `appError`; `lowerThrow` builds `enumVariant` (custom →
   named variant, built-in/string → `Other`); add `thiserror` to the scratch
   manifest (the dep seam); retire `boxError` + the per-class hand-impls. Keeps the
   022-no-custom `String` path (compat guard).
2. **049b — field-carrying errors.** Relax `lowerErrorClass` (→ `errorClasses`
   carrying typed fields) to message + declared fields + `super`/`this.f=f` ctor;
   struct variants carry fields; construct with fields at the throw site; commit
   `#[error("{message}")]` option (A).
3. **049c — `instanceof` → `match`.** Recognize the catch `instanceof` ladder →
   `discriminant` arms with owned field bindings + `other`/`_` exhaustiveness;
   non-ladder catch keeps the opaque bind.
4. **049d — catch-all + `From` glue.** `impl From<String>`/`From<&str> for AppError`
   → `Other`; `.into()` interop; the mixed-throw + non-discriminating-catch
   differential (021/022 Display compat).

## Fail-loud residuals (documented, not silently handled)

- **Error classes with methods / getters / non-data members** — only typed data
  fields + the fixed `super`+`this.f=f` ctor map.
- **Constructor bodies beyond `super(message)` + identity `this.f = f`** — computed
  RHS, defaults, reordered/extra statements.
- **`extends` a non-`Error` class, error hierarchies, `error.cause`, custom
  `name`/`stack`** — out (as in 022).
- **`instanceof` on a built-in error class in a catch** (`e instanceof TypeError`)
  — built-in throws collapse into `Other`; no variant to match.
- **Non-`instanceof` catch discrimination** (`e.message === …`, property tests,
  `switch (e)`) — keeps the opaque Display bind, no `match`.
- **Value-yielding / per-branch-returning discriminating catch** — deferred to
  **#16** (`escapesClosure` still rejects it).
- **Storing an `AppError` as a first-class value, error combinators
  (`.map_err`/`.context`), `anyhow`** — out.

## Impl note — cold-cache thundering herd (2026-07-08)

Adding `thiserror` to the scratch manifest made the **first** `bun run test`
after the change show ~80 transient failures in *unrelated* cargo fixtures — the
new crate compiling once under parallel-cargo lock contention, not a regression.
The **warm re-run is 493/0**. Judge on the re-run. #15 will hit the same when it
adds `futures`. (ERR19 was also adjusted: the plain-throw differential uses
`throw "lit"` rather than `throw new Error(msg)`, since Bun renders an `Error`
object with a full stack trace that can't match our message-only Display.)

## Verification

- **Unit (cargo-free, tier-1 COMPILES):** `emit(…)` asserts the enum shape,
  derives, `#[error]` attrs, variant construction at throws, `programErrType`, the
  `From` impls, the catch `match`, and the compat guard (no custom class ⇒ no
  `AppError`).
- **Oracle (cargo-backed):** add `08_errors/04_error_enum` (COMPILES — enum +
  thiserror derive + boxed-free throws + `main -> Result<(), AppError>` type-check)
  and a tier-2 **differential** where a `try` calls a fn throwing one of two
  variants by input and the catch prints a distinct string per variant — Rust
  stdout equals the TypeScript's on **both** branches (the discrimination is
  correct). Plus a field-carrying differential (read `e.field` in the caught arm).

## Workflow note

Spec-first: docs → scaffold (the `appError` `RustType`, `HirErrorEnum` item +
`emitErrorEnum`, `enumVariant` expr, the `tryCatch.discriminant` field, the widened
`errorClasses`, and `thiserror` in the scratch manifest — with `lowerErrorClass`
relaxation / enum synthesis / catch-discrimination seams throwing `UnsupportedError`
so specs are **RED**) → **RED** → real enum synthesis, field-carrying throws,
`instanceof`→`match`, and the `From` glue to **GREEN** → mirror the new relaxations
+ the `#[error]`-option-(A) commitment + the swallow-on-no-`else` parity in
`dialect.md` → archive. Value-yielding discriminating catch stays #16; a built-in
`instanceof` split and richer `#[error]` rendering are future series.
</content>
