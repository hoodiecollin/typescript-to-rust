# 004 — `&str` for read-only string parameters

## Problem

Every TS `string` lowers to Rust `String`. For a parameter that the ownership
pass proves **read-only**, that yields `&String`:

```ts
function greet(name: string): void {
  console.log(name);          // name is only read
}
```

lowers today to

```rust
fn greet(name: &String) {     // non-idiomatic; clippy::ptr_arg
    println!("{}", name);
}
```

`&String` compiles, but the idiomatic Rust signature is `&str` — the borrowed
string slice. `&str` is the API-surface convention for a read-only string
argument: it accepts both an owned `String` (via deref coercion) and a string
literal without forcing the caller's hand. This slice refines a read-only
`string` parameter's type from `&String` to `&str`.

## Scope (decided 2026-07-02)

This is the third bullet of plan.md's "generalize ownership" item. That item
bundles three things; only one is ready, so — mirroring series 003 (ship `usize`,
defer `i64`) — this slice ships the ready piece and defers the rest to their own
series, with rationale.

**In:** a function parameter of TS type `string` that the ownership pass
classifies **read-only** (`ref`) lowers to Rust `&str` instead of `&String`.

- Represented by a new `RustType` variant `{ kind: "str" }` — the unsized string
  slice, only ever valid behind a reference. `&str` is therefore
  `{ kind: "ref"; mut: false; inner: { kind: "str" } }`.
- Performed by a post-lowering **HIR → HIR** refinement pass `refineStrings`
  (`src/strings.ts`), invoked as the final gate step *after* `refineNumerics`.
  This mirrors the numeric pass: a standalone, pure, idempotent pass keeps the
  ownership-type refinement out of the single-pass lowering walk and gives a
  clean unit-test / mock seam.
- **Call sites are unchanged.** A read-only string argument is already passed as
  `&x` (borrow `ref`); `&String` coerces to `&str` by deref coercion, so existing
  call-site lowering keeps compiling against the refined signature. No call-site
  edit is in scope.

**Deferred — own series (documented, not silently handled):**

- **Bare string-literal arguments to a `&str` param** — `greet("x")` currently
  emits `greet(&"x".to_string())`, which *coerces to `&str` and compiles*, but
  needlessly allocates. Emitting a bare `"x"` needs a `&str`-literal
  representation in the emitter (a new expr shape/flag). Cosmetic, compiles today
  → its own follow-up, not this slice.
- **`&str` in return position / struct fields** — introduces lifetime elision and
  annotation concerns (`fn f<'a>(...) -> &'a str`, `struct S<'a>{ x: &'a str }`).
  Out until structs and a lifetime story exist.
- **Inter-procedural moves** (use-after-move → `.clone()`, move-through-store) —
  single moves already lower correctly; a *use after move* fails loud via cargo,
  which the dialect accepts as the oracle backstop. Fixing it needs real def-use /
  liveness analysis and has no failing driver today. Its own series.
- **Nested-scope symbol table** (shadowing across block scopes) — **cannot arise
  yet**: no control-flow lowering means there are no block scopes to shadow. Its
  own series *when control flow lands* (the same blocked-on-control-flow reason
  that deferred `i64` counters in 003).

**Out (this slice):**

- `&mut str` — not a real target; a mutated string parameter stays `&mut String`
  (you cannot grow a `str`). `&mut String` is correct and idiomatic.
- Any borrow that is not a parameter.

## Design

### The seam

A pure HIR → HIR pass:

```ts
// src/strings.ts
export function refineStrings(module: HirModule): HirModule
```

`lower()` calls it last, after `refineNumerics`:

```ts
return refineStrings(refineNumerics({ items, main }));
```

The two refinement passes are independent (numerics touch `f64`/`usize`; strings
touch `&String`); order does not matter. The pass is idempotent and mutates in
place, matching `refineNumerics`.

### HIR change

`RustType` gains `{ kind: "str" }`. It is only produced *inside* a `ref` (there is
no owned bare `str`), so the union stays sound: an owned string is `String`, a
read-only borrow is `ref → str` (`&str`), a mutable borrow is `ref(mut) → String`
(`&mut String`).

### Emission

`emitType` gains `case "str": return "str";`. `&str` and `&mut String` then fall
out of the existing `ref` recursion with no special-casing.

### The pass

For each parameter of each `HirFn` item (top-level `main` has no params, so it is
skipped): if the parameter type is a **non-mutable ref to `String`** —
`ty.kind === "ref" && !ty.mut && ty.inner.kind === "String"` — rewrite the inner
type to `{ kind: "str" }`. That is the whole pass: a read-only `&String` param
becomes `&str`.

Why this is sufficient and sound:

- The ownership pass already decided `ref` (vs `refMut`/`move`) from *how the
  callee uses the parameter*; a `ref` string is read-only by construction, so
  `&str` is always valid for it.
- `&mut String` params (mutating use) have `ty.mut === true` and are skipped —
  correct, since `&mut str` cannot grow a string.
- Owned `String` params (moved) are `{ kind: "String" }`, not a `ref`, and are
  skipped — correct, they keep ownership.

## Limits (documented, not silently handled)

- Only *parameters* are refined. Locals, returns, and fields keep `String`.
- The deferred bare-literal call-site optimization means `greet("x")` still emits
  an allocating `&"x".to_string()`; it compiles (coercion), just isn't optimal.

## Verification

- **Unit (cargo-free):** `tests/strings.test.ts` drives `refineStrings` on HIR
  built via `lower(...)` and asserts: a read-only string param is `&str`; a
  mutated string param stays `&mut String`; a moved (owned) string param stays
  `String`; a non-string ref param is untouched; the pass is scope-correct across
  items (specs S1–S6).
- **Oracle (tier-1 COMPILES + tier-2 BEHAVES):** a new fixture
  `10_ownership/04_str_borrow.ts` — a fn with a read-only string param, called
  from a top-level script with a `String` variable, printing it — added to
  `SUPPORTED`, plus a differential-stdout test (spec F1).

## Workflow note

Full spec-first workflow, third clean application: docs → mock (`strings.ts` as an
identity passthrough, wired into `lower` after `refineNumerics`; `RustType` gains
`str` and `emitType` handles it) → **RED** specs against the mock → real
`refineStrings` to GREEN → archive.
