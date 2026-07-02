# The Input Dialect

The translator accepts a **strict subset** of TypeScript. This document is the
specification; a validator pass (planned — see plan.md) will enforce it and
reject anything outside it with a clear error. "Reject loudly" beats "mistranslate
silently."

The subset exists so we can skip a full type-inference engine (à la `tsc`) and
rely on explicit annotations during a single AST pass — and so that every
construct has a *sound* Rust lowering under the Option A memory model.

## Required

- **Explicit type annotations** on every variable, function parameter, and
  function return type. Exception: a binding with a trivial literal initializer
  whose type is unambiguous in one pass (e.g. `const n = 5`).
- **Statically-known, closed object shapes** via `interface` or `type`. Object
  literals must conform to a declared shape.

## Forbidden (rejected by the validator)

- `any` and `unknown` (they defeat static lowering; `TsAny` is an internal
  escape hatch, not an input feature).
- Untyped bindings/parameters/returns (outside the trivial-literal exception).
- **Dynamic object manipulation** — adding/deleting properties at runtime,
  monkey-patching. Shapes are fixed at declaration.
- **Shared mutable aliasing that escapes** what the ownership pass can prove
  sound. Two live mutable references to the same object generally cannot be
  expressed in idiomatic Rust; such code is rejected (or, case-by-case, lowered
  via an explicit `Rc<RefCell<T>>` fallback). This is the Option A tax.
- Class **inheritance** (`extends` on classes) — no clean `struct` mapping.
  Composition and `interface` are fine.

## Deliberately deferred (not yet implemented; tracked in fixtures)

These are *in* the intended dialect but not yet supported by the emitter:
control flow, arrays/records, `interface`/`class`, `throw`/`try`, `async`/`await`,
and ownership-sensitive function parameters. See `tests/fixtures/**` and the
"Next" list in plan.md.

## Why these restrictions are the right call

TypeScript is intentionally unsound (bivariant parameters, `any` escape hatches)
and garbage-collected. A *total* TS→Rust translation does not exist. Constraining
the input is what makes the problem decidable and the output idiomatic. The
restriction must be **specified and enforced** — an unspecified "we handle most
TS" is how a translator silently emits wrong code.
