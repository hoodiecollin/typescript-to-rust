# 105 — Module-wide integrality lattice: integer specialization into callbacks & elements

Issue **#90** (under perf epic **#86**) — the **#87 graduation** that series 103 deferred:
integer-domain arithmetic *inside lifted `__cb_*` callback bodies* and over *iterator
element types*, not just intra-body counters/accumulators.

## Problem

`arraypipe`'s steady-state loss (0.4× Bun, unchanged by #89's fusion) is entirely the
libm `frem` from the `f64` modulo in the filter callback:

```rust
fn __cb_filter_2(v: f64) -> bool { return v % 5.0 != 0.0; }   // frem ×500k
```

Measured: `f64 %` 9.6ms vs `i64 %` 1.4ms (7×); `build+fold` alone 0.86ms — so the whole
loss is this one modulo. It is the *same* root cause as `loopsum` (#87), but series-103's
`computeIntegerNames` seeds integrality only from `let`-bound names — **never params** —
so `v` is never proven integer and the modulo stays `f64`. The emit half already exists
(103a's `intDomain` flag → `(v as i64) % 5`); the missing piece is *proving* `v` integer.

**Soundness crux.** We cannot blindly integer-domain a callback `param % intLit`: the
`as i64` cast truncates, so `3.5 % 5` would wrongly yield `3` instead of `3.5`. That is a
wrong answer for ordinary fractional data — *not* the sanctioned past-2⁵³ divergence. The
param's integrality must be **proven**, which is inherently inter-procedural (the value
flows from the iterator source through the upstream stages into the callback).

## Ruling (Collin, 2026-07-21)

**Build a general module-wide integrality lattice** — a single property over all value
slots (bindings, params, function returns, and *iterator/`Vec` element types*), not a
chain-local special case. Reuse the accepted-`i64` posture already ruled for #87/series-103
(divergence only past 2⁵³ / on overflow, documented, no panic). Proven-integer values get
integer-domain arithmetic (starting with modulo, the measured win); everything unproven
stays `f64` — the always-safe fall-back.

## Core analysis: the integrality lattice

A two-point lattice per **slot**: `Int` (⊥, provably integer-valued) or `Real` (⊤,
possibly fractional). Slots:

- every **binding** (`let`) and **param** (free fn, method, ctor);
- every **function/method return**;
- every **element slot** — the element type of a `Vec<f64>` local/param and of each
  iterator-adapter output (`map`/`filter`/`flatMap`/…); and
- every **callback element param** (a lifted `__cb_*`'s element arg).

**Greatest fixpoint (optimistic).** Start every slot `Int`; demote to `Real` on contact
with a fractional quantity, to a fixpoint. Demotion sources (⊤-forcing):

- a fractional literal (`0.5`), a `/` result, `Math` reals (`sqrt`, …);
- a slot flowing into a `Real` slot (assignment, arg→param, return→caller, element→param);
- a param that is `Real` at **any** call site; a return that is `Real` on **any** path;
- a `Vec` element that is `Real` at **any** producer (init element, `push` arg, or the
  output of a `Real`-producing map).

**Transfer (Int-preserving).** `+ - * %` of `Int`s → `Int`; `len`/`.length` → `Int`;
an already-`i64`/`usize` value → `Int`; a `map` callback returning `Int` over an `Int`
element → `Int` output element; a `filter` preserves its input element's integrality;
`into_iter`/`iter` preserve the source element's integrality.

**Inter-procedural seeding.** This unifies and extends the three existing passes:

- `computeIntegerNames` (intra-body bindings) — becomes the binding-slot rule.
- `propagateIntegerParams` (a param is integer iff integer at all call sites) — becomes
  the param-slot rule, **extended to callback element params**: a `__cb_*` element param
  is `Int` iff its adapter's receiver **element slot** is `Int` (the adapter *is* the call
  site; the element *is* the argument).
- `specializeReturnTypes` (i64 returns) — becomes the return-slot rule.

All-or-nothing per connected component, exactly as 103b-1 does for intra-body components,
now spanning params/returns/elements across the module.

## Emit

Reuse 103a's `intDomain` on any `%` whose operands are `Int` (now including callback
bodies): `(v as i64) % 5`. Where a callback element param / `Vec` element slot is `Int`
*and* only used integer-preservingly, optionally retype it `i64` (103b-style) to drop the
per-use cast — **scope v1 to the modulo `intDomain` tag** (the measured win) and leave
element/param i64 retyping to a follow-up increment if the cast shows up in profiles.

## Relationship to series 103

103 is the intra-body special case of this lattice (bindings only, seeded from `let`s).
105 lifts the same machinery to a module-wide fixpoint with **element slots** and
**callback-param seeding** as the genuinely new pieces; the emit and the accepted-`i64`
posture are inherited unchanged.

## Soundness & divergence

- Integer-domain arithmetic is applied **only** to slots proven `Int` by the fixpoint;
  any doubt → `Real` → `f64` (no truncation, no divergence).
- Proven-`Int` values past 2⁵³ / on `i64` overflow take the **already-ruled accepted-`i64`
  divergence** (documented in `docs/dialect.md`) — no new dialect decision.

## Pipeline placement

Extends `refineNumerics` (`numeric.ts`) — the lattice replaces the current
per-body `computeIntegerNames` seed with a module-level fixpoint computed once, consulted
by `tagIntegerModulo` (and, later, the i64 retypers) across all bodies including `__cb_*`.

## Impl plan (spec-first BDD slices)

1. **Mock + RED specs** — `packages/compiler/tests/callback-integrality.test.ts`,
   differential (cargo-backed).
2. **Element-slot model** — represent `Vec`/iterator element integrality; seed from
   integer-built sources and adapter transfer.
3. **Callback-param seeding** — map each `__cb_*` element param to its adapter's receiver
   element slot; fold into the fixpoint.
4. **Module fixpoint** — unify `computeIntegerNames` + `propagateIntegerParams` +
   `specializeReturnTypes` into one greatest-fixpoint over all slots.
5. **Emit** — `intDomain` tags inside callback bodies (reuse 103a).
6. **Re-bench + docs** — `bun bench`; `arraypipe` steady-state target ~1.4ms (a Bun win);
   corpus/coverage per the fixtures rule; update `docs/dialect.md` if the divergence note
   needs the element/callback wording.
7. **Archive.**

## Deferred (future increments)

- i64 **retyping** of callback element params / `Vec` element types (drop the per-use
  `as i64` cast) — v1 tags modulo only.
- Non-modulo integer ops in callbacks where a measurable win exists (e.g. integer
  division semantics — but `/` is `Real`-forcing by definition, so this is narrow).
- Integrality through `Map`/`Set` element/value types.
