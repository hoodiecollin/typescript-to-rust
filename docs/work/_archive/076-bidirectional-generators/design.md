# 076 — Bidirectional generators (`gen.next(v)` resume-value, stable, extends 052)

> **Status: SHIPPED (2026-07-14).** Graduates the bidirectional `gen.next(v)` deferral,
> issue **#32**. Dialect calls made with Collin 2026-07-10 (`needs-user-input` cleared).
> **Extends 075's `GenStep<Y, R>`** with a send channel — 075 establishes the result
> type, 076 adds the value-in path. **Stable Rust** (no nightly `Coroutine`, no stackful
> crate); rides 052's hand-rolled stackless machine. Specs: `specs.md` →
> `packages/compiler/tests/bidirectional-generators.test.ts` (10 specs, all green; full
> suite 774 pass / 0 fail, typecheck clean).
>
> **Impl notes / deviations:**
> - **Bidirectional detection** is a whole-program pre-scan (`readsYieldResult`, in
>   `collectSteppedGenerators`) → `analysis.bidirectionalGenerators`: a generator whose
>   body has a `const x = yield e` (a VariableDeclaration with a **non-delegate**
>   `YieldExpression` init, not descending into nested functions). `TNext` comes from the
>   3rd `Generator<Y, R, TNext>` arg → `analysis.generatorNextTypes`.
> - **`resume(&mut self, sent: TNext) -> GenStep<Y, R>`** is emitted as an **inherent**
>   method and is the **single driver** for a bidirectional generator: it stashes
>   `self.__sent = Some(sent)` before the shared `loop { match self.state { … } }`, and
>   each resumed arm's head (`genResumeBind` HIR stmt) does `self.<x> =
>   self.__sent.take().unwrap()`. State 0 has no pending yield, so the first-resume value
>   is discarded for free (matching JS). `__sent: Option<TNext>` is a new struct field.
> - The **`const x = yield e`** CFG terminator reuses the `yield` node with a new
>   `resultTarget` (mirroring `yieldStar`'s `resultTarget`); the target is a carried
>   field (written in its resumed arm, read after), typed by `TNext`.
> - **Dual surface (Q3):** when `TNext` lowers to `Option<T>` (the 066 undefined model,
>   default `None`), `impl Steppable::step` and `impl Iterator::next` both route through
>   `self.resume(Default::default())` — faithful to JS's `for-of` sending `undefined`. A
>   **non-defaultable** `TNext` is `resume`-only: no `step`/`Iterator`, and its wrapper fn
>   returns the concrete struct. `for-of` over a non-defaultable bidirectional generator
>   is **fail-loud at lowering** (`lowerForOf`).
> - **Consumer routing:** `gen.next(v)` / `gen.next()` `{ value, done }`-destructured
>   → `genStepTuple` now drives `(&mut recv).resume(<sent>)` (`Default::default()` for a
>   bare `.next()`) rather than `step()`. A **bare** `gen.next(v)` statement (advance +
>   discard) lowers to a `resume(<sent>)` method call. A send `.next(v)` into a
>   **non-bidirectional** generator is fail-loud. A new `raw` HIR expr carries the
>   `Default::default()` snippet (no TS source).
> - **Unannotated `TNext`** with a read yield result → fail-loud in
>   `buildGeneratorStateMachine` (can't type `sent`).

## Problem

065/075 keep `gen.next(v)` — passing a value **into** a suspended generator, making `yield`
an **expression** (`const x = yield emit`) — fail-loud. Rust's `Iterator::next(&mut self)`
takes **no** parameter, so there is nowhere to thread the sent value. This is a **signature**
mismatch, not a capability limit: 052 already hand-rolls the stackless state machine with
liveness across yields; the resumed-in value binds exactly like any other live local.

Nightly `std::ops::Coroutine` (supports resume-with-value) is rejected — it would force every
downstream consumer of the emitted crate onto nightly. Stackful crates (`May`, `corosensei`)
bring a green-thread runtime — disproportionate when 052 is already stackless. Neither is
needed.

## Decisions (2026-07-10, with Collin)

### 1. Result type — reuse 075's `GenStep<Y, R>` (shared)

`resume(v)` returns the **same** tslib enum 075 introduces:
`GenStep<Y, R> { Yield(Y), Return(R) }`. The send channel (value **in**) is orthogonal to
the result shape (value **out**), so 076 adds only the parameter; consumption of the result
(`.value`/`.done`/destructure) is exactly 075's rewrite.

### 2. Dual surface — `impl Iterator` **and** `resume` when `TNext` is defaultable (Q3)

A bidirectional generator struct always gains an inherent
**`resume(&mut self, sent: TNext) -> GenStep<Y, R>`**. It **also** keeps `impl Iterator`
(via `resume(<default>)`) **when `TNext` is defaultable** — i.e. includes `undefined` / has a
066-model default. This is **faithful**: JS `for (const x of g())` sends `undefined` into
each `next()`. So a bidirectional generator still works with `for-of` / spread / `.collect()`
/ `yield*`. When `TNext` is **non-defaultable**, the struct is **`resume`-only** — for-of /
collecting consumers over it → **fail-loud**.

*Rejected:* always emitting `impl Iterator` with a synthesized default even for
non-defaultable `TNext` (Q3-B — risks an unfaithful sent-in value); and a distinct
iterator-less resumable type (Q3-C — needlessly loses for-of/collect where `TNext` defaults).

### 3. `TNext` typing and the first-resume discard

`TNext` comes from TS's third generator type param `Generator<Y, R, TNext>` (the resume-in
type). A generator whose **yield result is read** (`const x = yield e`) but is **unannotated**
in `TNext` → **fail-loud** (can't type `sent`). The **first** `next(v0)` / `resume(v0)`
discards `v0` — there is no pending `yield` yet — matching JS.

## Mechanism

### The `resume` method (rides 052)

The signal for **needing** `resume`: any `yield` whose **result is read** makes the generator
bidirectional (a pure `yield e;` statement stays pull-only → 075's `step`/`impl Iterator`
path, no `resume`). 052 already suspends at each yield with liveness-preserved locals; the
extension binds the incoming `sent` as the value of the resumed yield expression:

```rust
impl G {
    fn resume(&mut self, sent: TNext) -> GenStep<Y, R> {
        loop {
            match self.state {
                // resumed arm: the `const x = yield e` binding gets `x = sent`
                // run until the next `yield` (→ GenStep::Yield(y)) or terminal (→ GenStep::Return(r))
            }
        }
    }
}
```

`yield e` as an **expression** lowers so that: (a) the state transition emits `e` as the
`Yield` payload and suspends; (b) the **resumed** state's first act binds the yield-
expression's result to `sent`. The initial state ignores `sent` (no pending yield) — the
first-resume discard falls out for free.

### Dual surface (`impl Iterator` when `TNext` defaultable)

```rust
impl Iterator for G {
    type Item = Y;
    fn next(&mut self) -> Option<Y> {
        match self.resume(<TNext default>) {  // undefined-model default (066)
            GenStep::Yield(y) => Some(y),
            GenStep::Return(_) => None,
        }
    }
}
```

Emitted **only** when `TNext` is defaultable. `step()` (075) is likewise defined via `resume`
for a bidirectional generator, so `for-of` / spread / `Array.from` / `yield*` all reduce to
`resume(default)`. Non-defaultable `TNext` → omit `impl Iterator` and `step`; the only entry
point is `resume`.

### Consumer side

`gen.next(v)` → `gen.resume(v)` returning `GenStep<Y, R>`; the `.value` / `.done` /
`{value,done}`-destructure reads are 075's rewrite verbatim. `const it = g(); it.next(v)`
(variable-bound) routes the same way (075 already widens `.next()` routing to bound
generators). A bare `gen.next()` (no arg) on a bidirectional generator passes the default
sent value.

### Reuse

052 state machine + cross-yield liveness (the send value is just another live binding); 075
`GenStep` + `step` + `.next()` routing + consumer rewrite; 066 undefined model (the `TNext`
default); 027 tslib.

## Fail-loud residuals

- **Unannotated `TNext`** when a yield result is read — can't type `sent`.
- **Non-defaultable `TNext` generator** consumed by `for-of` / spread / `.collect()` /
  `yield*` — no `impl Iterator`; the consumption site fails loud (the `resume` path still
  works).
- **`gen.throw(e)` / `gen.return(v)`** — the other two generator-protocol methods; unmodeled
  (own concern).
- **Un-guarded `.value`**, **repeated `resume` after terminal with non-`()` `R`** — inherited
  from 075's boundaries.
- Everything 052/065/075 already reject downstream — unchanged.

## Impl sequence

1. **Bidirectional detection** — mark a generator bidirectional when any `yield`'s result is
   read; resolve `TNext` from `Generator<Y,R,TNext>` (unannotated + read → fail-loud).
2. **`resume` emit** — inherent `resume(&mut self, sent: TNext) -> GenStep<Y,R>`; bind `sent`
   as the resumed yield expression's value in the state arm; first-resume discard.
3. **Dual surface** — `impl Iterator` (+ `step`) via `resume(<default>)` **iff** `TNext`
   defaultable (066 default); else `resume`-only, for-of/collect fail-loud.
4. **Consumer routing** — `gen.next(v)` → `gen.resume(v)`; reuse 075's result rewrite.
5. RED `specs.md` → GREEN (differential — send round-trips, first-next discard, for-of over a
   defaultable-`TNext` bidirectional generator).

## Specs sketch

- `function* g(): Generator<number, void, number> { const a = yield 1; const b = yield a*2; return }`
  driven by `g().next()` / `.next(10)` / `.next(20)` — send round-trips; first `next(x)`
  discards `x`; differential-match the `{value,done}` sequence.
- `const x = yield emit` inside a `for-of`-consumed generator with `TNext = undefined` →
  `impl Iterator` present; for-of sends `undefined`; differential-match.
- Non-defaultable `TNext` bidirectional generator in a `for-of` → **fail-loud**.
- Unannotated `TNext` with a read yield result → **fail-loud**.
- Regression: a generator with no read yield result stays on the 075 pull-only path
  (`step`/`impl Iterator`, no `resume`) — **byte-for-byte unchanged**.

## Open sub-details (impl, not dialect forks)

- Whether `step()` and `next()` both route through `resume(default)` for a bidirectional
  generator, or only `next()` (keeping `step` on the direct arms).
- Where "yield result is read" is computed — an `analysis` pass flag vs. inline in the
  generator lowering (coordinate with 052's yield-site walk).
- Emitting the `TNext` default — reuse the 066 undefined value vs. a `Default` bound; behavior
  when `TNext` is a union including `undefined` but not *equal* to it.
- Whether a single struct can cleanly expose `impl Iterator`, `Steppable`, and `resume`
  simultaneously without trait-method-name collision on `next`/`step`.
