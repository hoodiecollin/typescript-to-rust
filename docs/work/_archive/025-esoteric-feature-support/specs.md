# 025 — Esoteric feature support (specs)

Status: **025a/b/c landed**; sync generators deferred to a future slice.
Behavioral specs live in `packages/compiler/tests/esoteric.test.ts` (each asserts
the emitted Rust compiles AND its stdout matches the TS run — the oracle).

## 025a — parameter properties → field + assign

- `constructor(public x: T)` contributes a struct field `x` (appended after the
  explicitly-declared fields, in ctor-param order) and initializes it from the
  moved-in argument. Pure lowering desugar (`lowerClass` collects the field,
  `lowerConstructor` seeds the field-init and unwraps the binding); no new HIR.
- Specs: a two-param-property `Point.sum()` reads both back (`7`); param
  properties mixing with an explicit computed field (`Box.area`, `15`).

## 025b — `enum` → Rust `enum`

- `enum E { A, B = 1 }` → `#[derive(Clone, Copy, PartialEq)] enum E { A, B = 1 }`
  (new `HirEnum` item). C-like only: members must be identifiers; an initializer
  must be an integer literal (string enums / `const enum` fail loud).
- A member access `E.Variant` → the Rust path `E::Variant` (new `path` HIR expr),
  distinguished from a struct field read by `analysis.enums`.
- Enums are `Copy`: `isCopyType` now recognizes an enum type, so an enum param
  passes **by value** (param + call site consistently) — this is what lets a
  `switch` guard compare it (`_ if c == E::Variant`, needs `PartialEq` + no borrow).
- Type resolution: enum names are unioned into the nominal set `lowerType`
  consults (the emitter renders a struct and an enum type identically — the bare
  name), while staying in `analysis.enums` for the member-access path.
- Spec: `switch` over a `Color` returns each variant's code (`1`), composing with
  the 019 guarded-`match` lowering.

## 025c — `using` → `Drop`

- A `[Symbol.dispose]() { … }` method (a computed `Symbol.dispose` key) lowers its
  body into `impl Drop for Name { fn drop(&mut self) { … } }` (`HirClass.dispose`).
- A `using x = e` declaration lowers to a plain owned `let` — Rust runs `drop` at
  scope exit, in reverse declaration order, matching JS dispose order.
- `await using` stays forbidden (`DialectError`): stable Rust has no async `Drop`.
- Spec: two `using` guards + a body line print `body`, then dispose in reverse
  (`body\nb\na`).

## Deferred (unchanged, fail-loud)

- **Sync generators → `Iterator`**: the state-machine / iterator-adapter transform
  is a mini-CPS pass; still rejected (the `function*` flag). Its own future slice.
- **`await using` / async iteration / decorators**: rejected (decorators
  permanently — 024/025 design).
- **String `+` of two owned `String`s**: surfaced by the 025c dispose body
  (`"x" + self.field`); the RHS needs `&`. Orthogonal string-behavior gap (027).
