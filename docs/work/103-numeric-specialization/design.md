# 103 — Numeric type-specialization: integer counters & accumulators under the `f64` default

Epic **#87** (under perf epic **#86**). Motivated by `benchmarks/corpus/loopsum.ts`
— the worst result in the suite (steady-state **95.3ms vs Bun 4.5ms, 0.0×**).

## Problem

`number` defaults to `f64` end to end. Today `numeric.ts` refines `f64` → an
integer type only when something *forces* it:

- **array indexing → `usize`** (forcing; fail-loud on a fractional-in-index conflict), and
- **`switch` over integer literals → `i64`** (preferring; whole-program for params).

A pure arithmetic loop has neither an index nor a switch, so it stays `f64`:

```rust
// loopsum: for (let i=0; i<5000000; i=i+1) { if (i%3===0) acc+=i; else acc-=1; }
let mut acc: f64 = 0.0;
{
    let mut i: f64 = 0.0;
    while i < 5000000.0 {
        if i % 3.0 == 0.0 { acc = acc + i; } else { acc = acc - 1.0; }
        i = i + 1.0;
    }
}
```

`i % 3.0` is an `f64` remainder → an LLVM `frem` / libm call, executed 5,000,000
times. Bun's JIT, seeing integer-valued doubles, uses hardware integer modulo.

This is the exact gap **020-for-range** deferred as *"`i64`/bound-driven ranges …
deferred with the broader integer-counter inference"* and *"the accumulator loop
(`total = total + i`, `i` is `f64`) genuinely can't be a range and stays a
`while`."* 103 is that broader inference.

## Ruling (Collin, 2026-07-20 — the `needs-user-input` decision)

1. **Soundness posture: accept `i64` semantics.** Divergence from JS past 2⁵³
   (where `i64` stays exact and `f64` drifts) **and** `i64` overflow/wrap are
   accepted as *documented* divergence — **not** a runtime panic and **not**
   gated behind a numeric-range proof. Consequence: the soundness bar drops from
   "prove values stay in [−2⁵³, 2⁵³]" to **"prove the value is integer-valued"**
   (integral; no fractional; no truncating `/`). This is the **first sanctioned
   divergence from the pure-`f64` number model** and must be recorded in
   `docs/dialect.md`.
2. **Sequencing: D first, then A.** Ship the surgical local integer-domain
   lowering as a zero-ripple first increment, then the general type-specialization
   pass.
3. **Scope: counters *and* accumulators**, not counters-only.

### Resolving the Q1↔Q3 tension

Q3's option named a "range/bounds analysis." Given the Q1 ruling, a *numeric*
range proof is **no longer a soundness gate** — `i64` overflow is accepted. So
accumulator specialization rests on the same **integrality** proof as counters;
range analysis is demoted to an **optional refinement** (choosing `u64`/`usize`
vs `i64`, or overflow-avoidance) and is **out of scope for 103**. The real gate
everywhere is: *is this value provably integer-valued?*

## Core analysis (shared by both increments): integrality

A `number` value/binding is **integer-eligible** when, within its body scope:

- it is seeded by an integer literal or an integer-valued expression;
- it is only ever assigned integer-valued expressions;
- it is never mixed with a **fractional literal** in arithmetic;
- it is never an operand of `/` (Rust `i64 /` truncates; JS `/` is float — value
  would change), nor `Math.*`-float-producing ops;
- (printing / returning is fine — an integral `i64` and `f64` print identically).

This generalizes the existing `isIntegerSafe` (which already bans `/`, fractional
mixing, and boundary-crossing). The fixpoint machinery (`computeUsizeNames`,
`markContext`, `flattenStmts`, `eachStmtExpr`) is reused; only the *seed* changes
from "array-index position" to "integer-literal-seeded binding," and the *forcing*
(fail-loud) becomes *preferring* (bail to `f64`, never throw) — matching the 019
`switch` and 020 range promotions.

## Increment 103a — Local integer-domain lowering (D, surgical)

Keep every binding `f64`; **do not** change any signature. Where an operator is
expensive on `f64` but both operands are provably integral, evaluate it in the
integer domain via the existing `cast` HIR node:

```rust
// i % 3.0 == 0.0   →   (i as i64) % 3 == 0
```

- **Targets `%` only** in 103a. (`/` is excluded — it truncates, changing the
  value; bitwise is already integer-domain via `bitwise.ts`.) JS `%` and Rust
  `i64 %` agree in sign (both follow the dividend) and value for integral in-range
  operands, so this is behaviour-preserving within `i64` range and takes accepted
  `i64` semantics beyond it (ruling 1).
- Emitted comparison stays in the integer domain (`… == 0`, no back-cast) when the
  `%` feeds an integer comparison; otherwise cast the result back (`(… as f64)`).
- **Why first:** it reuses the integrality analysis but *skips* the binding-retype
  ripple, return-type change, and range promotion — a small, low-risk emitter/HIR
  change that fixes loopsum's hot op immediately and de-risks the analysis before A
  builds on it.

## Increment 103b — Integer counter & accumulator specialization (A, general)

A new **preferring** promotion in `numeric.ts`, run after the usize pass (so
index-forcing still wins `usize`):

1. **Compute the maximal mutually-integer set.** Retype the *largest* set of
   integer-eligible bindings that are only ever combined with each other or with
   integer literals — so loopsum's `i` **and** `acc` both become `i64` and
   `acc = acc + i` needs no cast. A binding that mixes with a genuinely-`f64`
   binding is either cast at the mix site (`acc_f64 + (i as f64)`) or, if that
   would be pervasive, left `f64`.
2. **Type choice:** `usize` when index-forced (existing), else `i64` (signed —
   a general counter/accumulator may go negative).
3. **`i64` for-range promotion.** Generalize `promoteRanges` / `tryRange` /
   `isIntegerBound` to accept an `i64` counter with an integer/`i64` bound (020
   restricted this to `usize`). Emit a typed range so Rust doesn't default the
   literal to `i32`: `for i in 0i64..5000000` (or annotate the counter).
4. **Return-type specialization.** `run(): number` returning an integer-eligible
   `acc` becomes `fn run() -> i64`. Integer values print identically, so the
   benchmark correctness gate (byte-identical stdout across node/bun/ttr) stays
   green. Cross-boundary arg reconciliation reuses `propagateIntegerParams`.

loopsum after 103b:

```rust
fn run() -> i64 {
    let mut acc: i64 = 0;
    for i in 0i64..5000000 {
        if i % 3 == 0 { acc = acc + i; } else { acc = acc - 1; }
    }
    return acc;
}
```

### Relationship between 103a and 103b

103b **subsumes** 103a for loopsum (once `i` is `i64`, `i % 3` is already integer
modulo). 103a's lasting value is the case where a binding **cannot** be fully
retyped (it genuinely mixes with `f64`) yet a specific `%` is still on integral
operands — there, the local cast is the only win available. Shipping 103a first is
still worthwhile: it lands the perf win under a much smaller, signature-stable diff
while 103b's ripple/return-type/range work is designed and tested.

## Soundness & divergence summary (for `docs/dialect.md`)

| range | behaviour |
|---|---|
| within [−2⁵³, 2⁵³] | bit-identical to JS `f64` (integers exact in both) |
| beyond 2⁵³ | **accepted divergence** — `i64` exact where JS drifts (ruling 1) |
| beyond `i64::MAX` | **accepted `i64` semantics** — release wrap; JS → ±Infinity (ruling 1) |

No runtime panics: release builds wrap; we never emit checked arithmetic for this.

## Pipeline placement

`numeric.ts`, in `refineNumerics`, after `applyTypes` (usize) and alongside the
existing preferring promotions (`promoteIntegerMatches`, `promoteRanges`). 103a is
an integrality-tag + emit rule (the `cast` node already exists, emitter.ts:1859);
103b adds the counter/accumulator retype and extends the range promotion. The
emitter stays pure/total — all specialization is a post-lowering HIR→HIR refinement.

## Impl plan (spec-first BDD slices)

- **103a** — integrality analysis (seed = integer-literal-seeded binding; preferring
  fixpoint) + int-domain `%` emit. Specs: `numeric-int-modulo.test.ts`. Verify:
  loopsum emits `(i as i64) % 3`, correctness gate green.
- **103b-1** — maximal mutually-integer set retype (`let`/param) + mixed-site
  `as f64` casts. Specs extend `numeric.test.ts`.
- **103b-2** — `i64` for-range promotion + return-type specialization + arg
  reconciliation. Specs for typed ranges + `-> i64` return.
- **103c** — re-run `bun bench`; record the divergence table in `docs/dialect.md`;
  update `benchmarks/README.md` "Reading the numbers" (loopsum moves to the win
  column).

## Deferred (future series)

- **Range/bounds proof** for tighter type choice (`u64`/`usize` for provably-non-
  negative; overflow-avoidance) — demoted from 103 per the ruling.
- **`Math.trunc`/`| 0` integer idioms** feeding integer contexts.
- **Inter-procedural integer inference** of non-literal args (still the
  `propagateIntegerParams` fail-loud boundary).
