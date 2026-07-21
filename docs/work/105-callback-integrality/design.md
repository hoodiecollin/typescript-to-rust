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

### v2 increment — split-don't-demote monomorphization (LOCKED, Collin 2026-07-21)

Today (and in v1) the lattice is **all-or-nothing per param slot**: a shared free
fn / method whose param is `Real` at *any* call site demotes the param to `f64`
everywhere, so the provably-integer call sites eat the `frem` too (see spec **CI7**).

v2 **supersedes that demotion with monomorphization**: emit two variants and route
each call site to the one matching its proven integrality —

```rust
fn f_i64(n: i64) -> …   // integer call sites
fn f_f64(n: f64) -> …   // fractional / unproven call sites
```

This is the *static* dual of a runtime numeric tower: whole-module visibility lets us
resolve "dispatch on numeric kind" at **compile time**, with zero runtime tag. It is
soundness-clean (standard monomorphization) subject to:

- **The integer-division trap (soundness-critical).** Inside `f_i64`, `n` enters as
  `i64` but `n / 2` in i64 domain **truncates** (`5/2 = 2`, not `2.5`) — a *silent
  wrong answer*, not the sanctioned past-2⁵³ divergence, because JS division is always
  float. The i64 variant is therefore **not** "n is i64 everywhere"; it is "n enters
  i64 and is cast back to `f64` at every `Real`-forcing use (`/`, fractional literal,
  `Math.sqrt`, …)." The lattice already marks `/` `Real`-forcing, so the machinery
  exists — but a variant that naively keeps the param i64 through a `/` is unsound.
- **Recursion crosses variants.** A recursive `f` whose self-call passes a `Real`
  argument (`n/2`) must route `f_i64` → `f_f64`; routing is **per-call-site**, not
  per-fn, so the call graph may span both variants. Sound as long as each call site
  routes to the variant matching its proven integrality.
- **Variant bound.** k independently-int-or-real numeric params ⇒ up to 2^k variants;
  bound the explosion (scope, not soundness) — cap arity and fall back to the demoted
  single `f64` fn above the cap.

**Moot for v1.** The measured arraypipe win is a lifted `__cb_filter_2` with exactly
one call site (the adapter); callbacks are single-use by construction, so there is
nothing to split. Monomorphization only pays off for **shared** free fns / methods in
mixed contexts (CI7). Hence v1 = callback/element modulo tag; v2 = split-don't-demote
for shared numeric fns.

## Rejected alternative — pervasive runtime `Numeric { F64(f64), I64(i64) }` enum

Considered (Collin, 2026-07-21) and **rejected as a pervasive number representation**.
It is *soundable* — every JS numeric op can be defined on the enum to match `f64`
semantics — and that is precisely the problem: the sound form reintroduces the runtime
numeric-tower cost that AOT static specialization exists to erase.

1. **The tag check defeats the win.** #90's point is to prove integrality *statically*
   so the hot loop emits a bare `i64 %` with **zero branching**. A runtime enum makes
   every arithmetic op a `match` on both operands' tags → dispatch → maybe-widen, plus
   a layout tax (16 bytes: tag + payload, vs 8 for bare `f64`) on *every* numeric op.
   That is V8's SMI/heap-number tower — which a JIT pays because it *cannot* prove types
   ahead of time; we can, so paying it voluntarily is moving backward. The static
   lattice gets the same speed with **no runtime tag**.
2. **Overflow lane is lose-lose against the accepted-i64 ruling.** To match JS exactly,
   `I64(a)+I64(b)` needs a `checked_add` + widen-to-`f64` branch per op. But series 103
   already ruled accepted-i64 divergence past 2⁵³. So the enum must pick a lane:
   (a) match JS exactly → *more* branching, and now the dialect is inconsistent (enum
   values more correct past 2⁵³ than statically-specialized ones); or (b) keep
   accepted-i64 → **zero** soundness gain over static i64, only cost. Dominated either
   way.
3. **`===` / Map-key unification is a latent soundness bug.** JS: `1 === 1.0`, and `1`
   and `1.0` are the *same* Map key (also `-0 === 0`, `NaN !== NaN`). Two constructors
   make `I64(1)` and `F64(1.0)` structurally distinct, so `PartialEq`/`Hash` must be
   hand-written to unify them — and any leaked derive silently makes `1` and `1.0`
   different keys, an invisible divergence. The static approach never has this: a value
   has exactly one type, so `f64`/`ordered-float` keying stays uniform.
4. **It rips through the whole `f64`-typed runtime.** `Vec<f64>`, tslib signatures,
   `ordered-float` total-order for sort/keys — all become `Numeric`, each needing a
   hand-written JS-faithful `Ord`/`Hash`/`Display`. Every one is a new correctness
   surface where there is none today.

## Sanctioned hybrid — boundary-boxed `Numeric`, monomorphic inside (dynamic residual ONLY)

The one place a numeric tag *is* the right tool is a value whose kind is **genuinely
dynamic and statically unprovable** — `JSON.parse` output, a `number` off polymorphic
external data, a real union-typed number. There, the sound shape is **"box at the
boundary, unbox once, run monomorphic inside"**, leaning entirely on idea 1's variants:

```rust
fn f(x: Numeric) -> Numeric {
    match x {
        Numeric::I64(n) => Numeric::I64(f_i64(n)),   // arm result kind is STATIC
        Numeric::F64(n) => Numeric::F64(f_f64(n)),
    }
}
```

This is **not a new mechanism** — `f_i64`/`f_f64` are the same variants idea 1 already
produces; the enum only *selects* one. It differs from the rejected pervasive enum in
that the tag is checked **once** at the boundary, then the arm runs straight-line
i64/f64 with **no per-op tagging**, and the *return* constructor is statically known
per arm (an `I64` arm may legitimately return `F64` if its body hit a `/`) — so no
runtime kind-detection on the result, and accepted-i64 is inherited with no per-op
overflow branch.

**Out of #90 scope.** #90's targets (loopsum, arraypipe) are *all* statically
provable, so no `Numeric` tag is ever introduced on any targeted path — the hybrid
buys nothing here. It is a **dynamic-number-typing feature**, broad-scoped (impact
across the entire generation surface — every container, tslib signature, and numeric
op that could carry a dynamic value), and is tracked as its **own future issue**
(**#91**, under perf epic #86 — see it for the tag-introduction / **tag-death**
discipline the "infectious tag" coloring problem requires). Recorded here so that when
that feature is built, the sound shape is already decided and pervasive per-op
`Numeric` is not re-litigated.
