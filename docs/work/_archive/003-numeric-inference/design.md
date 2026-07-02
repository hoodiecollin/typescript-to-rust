# 003 — Numeric inference (`usize` for indices)

## Problem

Every TS `number` lowers to `f64`. That is correct for arithmetic but wrong for
**array indices**: Rust's `Index` for `Vec<T>` requires `usize`, and `f64` cannot
index. The emitter already special-cases a *literal* integer index (`arr[0]` →
bare `0`, not `0.0`), but a **variable or expression** index does not compile:

```ts
const arr: Array<number> = [1, 2, 3];
const i: number = 0;
const x: number = arr[i];   // i: f64  →  `arr[i]` rejected by rustc
```

This slice makes such indexing compile by refining the numeric type of the values
that reach an index position from `f64` to `usize`.

## Scope (decided 2026-07-02)

**In:** index-driven `usize` inference with **local propagation** and **loud
conflict rejection**.

- A `number` value used as an array index is `usize`.
- `usize`-ness propagates through `let`/`const` initializers, assignment RHSs, and
  the operands of integer arithmetic (`+ - * / %`) — a local fixpoint over a
  single scope body. So `arr[i + 1]` and `let j = i + 1; arr[j]` both work.
- A value forced to be **both** `usize` (index use) **and** float (a fractional
  literal reaches it) → **`UnsupportedError`**. We fail loud rather than lean on
  cargo; the cargo oracle remains the backstop for shapes the local analysis
  cannot see (e.g. a `usize` binding passed to an `f64` parameter — see Limits).

**Deferred — future enhancement (explicit user decision):** `i64` inference for
integer-only *counters* that are never indices. There is little to drive it before
control flow exists (few real counters without loops), and it widens the
per-binding conflict surface (i64 vs f64 vs usize). It gets its **own** series
when control flow lands; do not grow this one. When it does, `NumericType` gains
`"i64"` and `RustType` gains `{ kind: "i64" }`, reusing the same fixpoint.

**Out (this slice):**
- `for`/`while` loop counters — those need control-flow lowering (a separate
  slice). This slice unblocks the *indexing* half; the loop fixtures stay `todo`.
- Negative indices — `-1` is a `UnaryExpression`, which lowering already rejects
  (no unary support), so it never reaches the refiner.

## Design

### The seam

A pure HIR → HIR pass:

```ts
// src/numeric.ts
export function refineNumerics(module: HirModule): HirModule
```

`lower()` calls it as the last step before returning, so the module handed to the
emitter is already numerically refined. Keeping it a standalone, pure function
(not folded into the `lowerExpr` recursion) gives a clean unit-test / mock seam
and keeps the fixpoint — which is inherently whole-body, not per-node — out of the
single-pass lowering walk.

It may throw `UnsupportedError` (the one dialect gate stays conceptually in
lowering; `numeric.ts` is invoked by and part of that gate).

### HIR changes

- `RustType` gains `{ kind: "usize" }`.
- The `number` expression node gains an **optional** numeric tag:
  `{ kind: "number"; value: number; ty?: NumericType }` where
  `type NumericType = "f64" | "usize"`. Absent ⇒ `f64`. Optional so the change is
  backward-compatible: existing HIR construction sites (and the emitter's
  literal-index special-case) keep working untouched, and existing tests stay
  green.

### Emission

- `emitType`: `usize` → `"usize"`.
- `emitExpr` number case: `ty === "usize"` → bare integer (`0`); otherwise the
  existing rule (integer → `0.0`, float → verbatim).
- `emitIndex` keeps its literal-integer special-case as a belt-and-suspenders for
  directly-constructed HIR (emitter unit tests build index nodes with no `ty`);
  after refinement a literal index also carries `ty: "usize"` and renders bare via
  the number case — the two agree.

### The pass (per scope body — each `HirFn.body` and `module.main`)

Bindings are scope-local under the current name-based model, so the fixpoint runs
independently per body; a name used as an index in one function does not force a
same-named binding elsewhere.

1. **Seed.** The `index` sub-expression of every `index` node is *usize-context*.
2. **Fixpoint.** Recompute the usize-context expression set given the current set
   of usize binding names, until stable. An expression is usize-context if it is:
   - the index of an `index` node; or
   - the `init` of a `let` whose name is a usize binding; or
   - the `value` of an `assign` whose target ident is a usize binding; or
   - an operand of a `binary` (arithmetic op) that is itself usize-context.
   Every identifier that lands in usize-context adds its name to the usize set
   (may force more contexts next round).
3. **Apply.**
   - Each usize binding: its `let.ty` (and a `number` param's `ty`) becomes
     `{ kind: "usize" }`.
   - Each `number` node in usize-context: if `Number.isInteger(value) && value >= 0`,
     tag `ty: "usize"`; **else `UnsupportedError`** (a fractional/negative value
     cannot be `usize` — this is the conflict gate).

The conflict `let k = 0; let y = k * 1.5; arr[k]` is caught because `arr[k]` makes
`k` usize, and the pass additionally flags a usize binding that appears as a
`binary` operand whose sibling is a fractional literal — `k * 1.5` — as a
usize/float conflict → `UnsupportedError`.

## Limits (documented, not silently handled)

- A `usize` binding passed to an `f64` parameter (or vice versa) is a value-flow
  conflict the local, name-based analysis does not see; **cargo rejects it** (the
  oracle backstop). Full inter-procedural numeric flow is out of scope until the
  ownership generalization slice.
- Mixed same-binding int/float use beyond the two speced shapes falls to cargo.

## Verification

- **Unit (cargo-free):** `tests/numeric.test.ts` drives `refineNumerics` on HIR
  built via `lower(...)` and asserts the refined types/tags and the conflict
  throws (specs N1–N10 in `specs.md`).
- **Oracle (tier-1 COMPILES):** a new fixture `04_data_structures/03_variable_index.ts`
  exercising variable indexing, added to `SUPPORTED` so `cargo check` proves it
  (spec F1).

## Workflow note

First clean, full application of the spec-first workflow: docs → mock
(`numeric.ts` as an identity passthrough, wired into `lower`) → **RED** specs
against the mock → real `refineNumerics` to GREEN → archive.
