# 066 — First-class `undefined` / `null` model (absence as `Option<T>`)

> **Status: DESIGN COMPLETE (2026-07-10). Impl pending.** Resolves the design spike
> **issue #42**. Dialect-shape calls made with Collin in the 2026-07-10 session
> (`needs-user-input` cleared). Foundational: gates **#36** (implicit constructors,
> native `blocked-by #42`) and the `Vec`-indexed sub-path of **#34** + the `.get`
> sub-path of **#37**. Background research on the null/undefined story: issue #42
> comment.
>
> Spec-first: this `design.md` → mock → RED `specs.md` → impl → archive. At archive,
> fold the settled rules into `docs/dialect.md`.

## Problem

The dialect has **no first-class model of absence**. JS/TS have *two* absence values
(`null`, `undefined`); Rust has none — absence is a distinct type, `Option<T>`.
Every feature that can produce "no value" (optional fields, failed `Map.get`,
out-of-bounds index, `void` returns, uninitialized fields) needs one consistent
answer, decided once here rather than piecemeal per feature (which guarantees
inconsistency).

The trigger was **#34**: accepting `const [a, b] = arr` over a runtime-length `Vec`
forces a decision about out-of-bounds reads (JS `undefined`, Rust panic), which
exposed the absence of any `undefined` model underneath.

## Core principle

> **Absence is out-of-band — always `Option::None`, never an in-band value of the
> type.** This is the option-type fix for Hoare's null mistake (issue #42 comment):
> a possibly-absent `T` has a *different type* (`Option<T>`) from a `T` that can't be,
> and the compiler forces the `None` case to be handled before use.

**Litmus test** for "is this absence or a present value?": a value is *present* if
you can perform the type's operations on it; *absent* if you can't without first
making a decision. `0 + 1`, `"" + "x"`, `[].push(1)`, iterating an empty map — all
valid → **present**. `undefined + 1` — you can't → **absent**. This makes `0`, `""`,
`[]`, empty `Map`/`Set`, and unit `()` present values, **never** absence.

## Decisions (2026-07-10, with Collin)

### A · Representation

- **`null ≡ undefined` collapse** → a single `Option::None`. Both spellings accepted.
- **Two roles of `undefined`, split by annotation:**
  - *absent value of a `T`* (`T | undefined`, optional field, failed lookup) → `Option<T>`.
  - *no meaningful result* (`void` fn, statement value) → Rust `()` (unit).
  The type annotation disambiguates; `()` and `None` never mix.
- **Emptiness is never absence.** `0` / `""` / `[]` / empty `Map`·`Set` / `()` are
  present, operable values. "Absent vs present-but-empty" is `Option<Vec<T>>`
  (`None` vs `Some(vec![])`) — a distinction JS can't draw and the dialect keeps.

### B · Surface syntax

- `T | undefined`, `T | null`, and `?` optional fields (TS types these `| undefined`)
  **all** denote `Option<T>`. Both union spellings are accepted.
- A literal `undefined`/`null` in such an annotated context → `None`; a value → `Some(v)`.
- **Bare / unannotated absence stays fail-loud** — you must declare nullability. This
  is exactly `strictNullChecks`; no new dialect syntax is introduced.

### C · Collapse & divergence handling

- Both spellings normalize to `None`. The erased JS distinction is **only observable**
  where a value carries *both* — a `T | null | undefined` union, or a program that
  compares a `null`-typed value against an `undefined`-typed one.
- At that *both-present* site, emit a **non-fatal 056 compile-time warning**: the
  print-spelling, `===`, and coercion semantics will not match JS there. Not
  fail-loud, not silent — warned, in the spirit of 062's auto-`Rc` diagnostics. A type
  carrying only one spelling is unambiguous and warns nothing.
- **Canonical `None` print spelling: `undefined`** (TS grain: `?` ⇒ `| undefined`,
  `void` ⇒ undefined). `console.log(x)` of a `Some(v)` unwraps and prints `v`; of a
  `None` prints `undefined`. (A source `null` reaching a print therefore renders as
  `undefined` — precisely what the both-present warning flags.)

### D · `None → T` coercion — required-explicit, never automatic

A concrete `T` is produced from an `Option<T>` **only** at an explicit source
construct. No silent `None → T::default()` — that would re-commit the in-band-sentinel
mistake, and every site below supplies the fallback *explicitly* (so a per-type
`Default` is never compiler-invented).

| TS source | Lowers to | Trigger |
| --- | --- | --- |
| `x ?? d` | `x.unwrap_or(d)` / `unwrap_or_else(\|\| d)` | **absence only** |
| `x \|\| d` | JS-truthiness fallback (see below) | **falsy** (incl. present `0`/`""`) |
| default param `f(x = d)` | body `let x = x.unwrap_or(d);` | absence at call |
| destructuring default `{ x = d }` / `[a = d]` | per-slot `unwrap_or(d)` | absence (rides #34+#42) |
| narrow `if (x !== undefined)` / `match` | `if let Some(x)` / `match` | produces `T` in-branch |
| non-null assertion `x!` | `.unwrap()` | explicit opt-in; panics on `None` |

- **`x \|\| d` takes full JS falsy semantics** (Collin's call): return `x` if *truthy*,
  else `d`, where falsy = `false / 0 / -0 / "" / null / undefined / NaN`. Because it
  triggers on present falsy values too, `||` is **not** `unwrap_or`; it lowers to a
  truthiness fallback macro. It remains explicit-in-source, so it honors the
  required-explicit principle. This pulls in a **JS-truthiness predicate** (E below).
- **`x!` → `.unwrap()`** (Collin's call): explicit escape hatch. JS `x!.foo` on
  undefined throws `TypeError` at the access; Rust `.unwrap()` panics a step earlier —
  both blow up, so it's a faithful-enough mapping.

### E · JS-truthiness predicate (dragged in by `||`)

`is_truthy(v)` per the JS falsy set: `false`, `0`/`-0`, `""`, `null`/`undefined`
(`None`), `NaN` are falsy; everything else (incl. `[]`, `{}`, non-empty strings,
non-zero numbers) is truthy. **Decision: one shared truthiness** powers `||`, `&&`,
`if (x)`, and `!x` (rather than a separate rule per site) — emitted as a codegen
helper/macro (fn-first, per the codegen-helper-boundary rule; truthiness is a runtime
quirk, not a type/ownership fact).

### F · Arithmetic on optionals

- Using an **un-narrowed** optional in arithmetic (`optNum + 1`) is **fail-loud** —
  you must narrow or default first. This matches `strictNullChecks`, so the JS
  `undefined + 1 == NaN` coercion is **unreachable and not emitted**.
- **`NaN` is unrelated to absence.** It is a *present, invalid* `f64` from bad math
  (`0.0/0.0`, `sqrt(-1)`) → `f64::NAN`. It maps straight through and never means `None`.

## Mechanism (impl sketch)

1. **Type lowering** (`lowerType`): a union `T | undefined` / `T | null`, and a `?`
   optional field/param, lower to `Option<lower(T)>`. A union containing **both**
   `null` and `undefined` lowers to `Option<T>` **and** records a 056 warning at that
   site.
2. **Literal lowering**: `undefined` / `null` in an `Option` context → `None`; a value
   → wrapped `Some(..)` at the boundary where a `T` flows into an `Option<T>` slot
   (assignment, arg, return, field init).
3. **Narrowing**: `if (x !== undefined)` / `x != null` / `if (x)` and `switch`/`match`
   over presence lower to `if let Some(x)` / `match`. Reuse the existing scrutinee
   machinery (`fixStringScrutinees` sibling) where applicable.
4. **Coercion sites**: `??`, `||`, default params, destructuring defaults, `x!` lower
   per table D. `||`/`&&`/`if`/`!` consult the shared `is_truthy` helper (E).
5. **Print**: `console.log` of an `Option<T>` emits an unwrap-or-`"undefined"` render;
   `Some(v)` → the `v` render, `None` → the literal `undefined`.
6. **Fail-loud** where the model says so (below), always before emit.

## Fail-loud residuals

- **Bare / unannotated absence** — a `null`/`undefined` not inside a declared optional
  type. (Just `strictNullChecks`.)
- **Un-narrowed optional in a value position** — arithmetic, indexing, a `T`-expecting
  callee — without an explicit coercion (D). Points the user at `??` / narrow / `!`.
- **`x!` panics at runtime** on `None` — accepted (explicit opt-in), not a miscompile.

## Warned (non-fatal, 056 channel), not rejected

- A `T | null | undefined` union (or cross-spelling comparison) whose collapsed
  semantics diverge from JS at print / `===` / coercion.

## Impl sequence

1. `lowerType` → `Option<T>` for the three surface forms; both-present 056 warning.
2. Literal `undefined`/`null` → `None`; `Some(..)` boundary wrapping.
3. Narrowing lowering (`!== undefined` / `!= null` / `if (x)` / `match`) → `if let`/`match`.
4. `is_truthy` helper + `||`/`&&`/`if`/`!` wiring; `??` → `unwrap_or`.
5. Default params + destructuring defaults + `x!` → `.unwrap()`.
6. `console.log`/print render for `Option<T>`.
7. Fail-loud guards (un-narrowed use, bare absence).
8. RED `specs.md` → GREEN (differential; `None` prints `undefined`, non-panic cases
   match JS exactly).

## Specs sketch

- `let x: number | undefined = ...; console.log(x)` → prints `undefined` for `None`,
  the value for `Some`.
- `x ?? 0` → `unwrap_or(0.0)`; differential-matches JS `??`.
- `x || d` with `x = 0` (present, falsy) → returns `d` (JS falsy semantics).
- `function f(x: number = 5)`; `f()` → `5`; `f(2)` → `2`.
- `const n: number = x!` with `x = undefined` → panics (accepted).
- `optNum + 1` un-narrowed → `UnsupportedError` (fail-loud, points at `??`/narrow).
- `let y: number | null | undefined = ...` → compiles with a 056 warning.
- `Option<Vec<T>>`: `None` vs `Some(vec![])` are distinct (empty ≠ absent).
- `0` / `""` / `[]` are present values, never `None`.

## Open sub-details (impl, not dialect forks)

- Exact narrowing forms recognized (`=== null`, `== null` catching both, `typeof x
  === "undefined"`, `in`-guards) — enumerate during impl; unknown forms fail-loud.
- Whether `Some(..)` wrapping is inserted in `lower` or a dedicated refine pass.
- `Default`-based `unwrap_or_default()` is expected to be **unused** (all fallbacks are
  user-written); confirm no site needs it.
- `dialect.md` absorbs A–F at archive.
