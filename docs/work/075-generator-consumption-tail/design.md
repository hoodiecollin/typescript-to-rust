# 075 — Generator consumption tail (`Array.from(_,fn)`, manual `{value,done}`, `yield*` return-value, destructuring)

> **Status: DESIGN COMPLETE (2026-07-10). Impl pending.** Graduates the four 065
> deferred consumption residuals, issue **#39**. Dialect calls made with Collin
> 2026-07-10 (`needs-user-input` cleared). Introduces the **`GenStep<Y, R>`** result
> type **shared with #32** (series 076) — #39 establishes it, #32 adds the send channel.
> Blocked-by **#34** (067 binding-destructuring, design-complete, **not yet shipped**) —
> only the generator-destructuring *impl slice* waits on it; the rest ships independently.
>
> Spec-first: this `design.md` → mock → RED `specs.md` → impl → archive.

## Problem

Series 065 shipped `yield*` delegation and the *collecting* consumers (`[...g()]`,
`Array.from(g())`) over 052's generator state machine (`fn g() -> impl Iterator<Item=T>`),
but deferred four consumption residuals:

1. **`Array.from(iter, fn)` mapping overload** — hard-rejected at `lower.ts:5583`
   (`"Array.from with a mapping function"`). Only the no-mapping `Array.from(g())` form is
   modeled. The 057 callback-lift machinery it would reuse (`liftCallback`, `lower.ts:6079`)
   exists but is unwired here.
2. **Manual `{value, done}` protocol read** — `const r = it.next(); r.done / r.value`.
   Rejected at `lower.ts:5595` (`"manual generator .next()"`). **No `{value, done}`
   representation exists anywhere** in the compiler. This is the surface **shared with #32**.
3. **`yield*` expression return-value** — `const r = yield* inner()`, the completion value
   of a delegated generator. 065 boxes delegates as `Option<Box<dyn Iterator<Item=T>>>`
   (`emitter.ts:253`) which **drops** the return value; and generator `return <value>` is
   itself fully fail-loud (`lower.ts:1082`, `"generator return <value>"`).
4. **Generator array-destructuring** — `const [a, b] = g()`. A special case of general
   binding-destructuring (#34 / series 067), which is **design-complete but not shipped**.

## Decisions (2026-07-10, with Collin)

### 1. Result representation — enum `GenStep<Y, R>` (Q1, the shared load-bearing call)

A manual `it.next()` (and #32's `gen.next(v)`) result — JS's `{value, done}` — is
represented as a **generic tslib enum**, a faithful tagged union of `IteratorResult`:

```rust
// tslib (crate 027) — fully generic, no per-fn discriminant → a single shared type.
pub enum GenStep<Y, R> {
    Yield(Y),   // { value: Y, done: false }
    Return(R),  // { value: R, done: true }
}
```

Chosen over a `{ value: Option<Y>, done: bool }` struct and over a pure loop-idiom rewrite
because the enum is the only shape with **a home for the return type `R`** — so it
**graduates generator `return <value>` and the `yield*` completion value** in the same
stroke, and is exactly what #32's `resume(v)` returns. The **accepted cost** (Collin's
call): a consumer's `r.value` / `r.done` field reads do **not** map to fields and must be
**rewritten to `match` / `matches!`** (below). `GenStep` lives in tslib because — unlike
073's per-construct `Ctrl` — it is fully generic with no per-fn discriminant.

### 2. `Array.from(iter, fn)` — any array/iterable source (Q2)

Graduate the `lower.ts:5583` throw. `Array.from(src, fn)` lowers to
`src_iter.map(__cb).collect::<Vec<_>>()`, reusing 057 `liftCallback` (top-level `__cb_*` +
forwarding shim) and the `(x, i)` index overload via `.enumerate()`. **Source is widened
beyond generators** to any array/iterable — `Array.from(arr, fn)` and `Array.from(g(), fn)`
both accepted (broader than the no-mapping form's generator-only gate, which stays as-is).

### 3. Generator array-destructuring — designed here, impl gated on 067 (Q4)

`const [a, b] = g()` is designed in this series as a **fixed-arity prefix pull** off the
generator's `impl Iterator` (per-binding `.next()`), but its **impl slice is ordered after
067 lands** (it extends 067's ArrayPattern-over-tuple path — `lower.ts:4098` in
`lowerVarDecl`). The design is complete here; the code waits on the blocker.

### 4. Manual `.next()` routing (falls out of decision 1)

Both `g().next()` (direct call) and `it.next()` (a generator bound to a local) route to a
new inherent **`step(&mut self) -> GenStep<Y, R>`** method on the generator struct (added
alongside the existing `impl Iterator` and `::new`, `emitter.ts:246–299`). `.next(v)` with
an argument is **#32's** send path — fail-loud in #39 alone.

## Mechanism

### `GenStep` + the inherent `step()` method

052 emits `impl Iterator for G { fn next(&mut self) -> Option<Y> }` (`emitter.ts:287`),
which **drops** the return value (`None` at terminal). #39 adds a second inherent method
driving the **same** state arms but wrapping the outcome:

```rust
impl G {
    fn step(&mut self) -> GenStep<Y, R> {
        loop { match self.state { /* yields → return GenStep::Yield(v) */ } }
        // terminal → GenStep::Return(self.__ret.take()… )   // R = () for bare return / fall-off
    }
}
```

`impl Iterator::next` stays the primary surface (for-of / `.collect()` / `yield*`); it
delegates to `step` (`Yield(y) => Some(y)`, `Return(_) => None`) or keeps 052's direct
`Option` arms — pick the non-duplicating one at impl.

### Generator `return <value>` → `Return(R)` payload

Graduate `lower.ts:1082`: the `ReturnStatement` argument is lowered and carried to the
terminal state as the `GenStep::Return(r)` payload. `R` comes from the `Generator<Y, R>`
2nd type arg, else inferred from the `return` expr; **bare `return` / fall-off → `R = ()`**
(the 066 undefined model). The value is stashed in a `__ret` field on the transition to
terminal so `step` can `take()` it.

### `yield*` completion value

`const r = yield* inner()` reads the delegate's `Return` payload. 065's delegate field
(`Option<Box<dyn Iterator<Item=T>>>`) drops it, so completion-value reads require the
delegate to expose `step()`. Introduce a **`Steppable<Y, R>` trait** (`fn step(&mut self)
-> GenStep<Y, R>`) that every generator struct impls; when a `yield*`'s **result is read**,
box the delegate as `Box<dyn Steppable<Y, R>>` and, on the delegating state's exhaustion
(`Return(rv)`), bind `rv` to `r` before advancing. When the result is **not** read (the
common case), keep 065's `dyn Iterator` box **byte-for-byte**. `yield*` over a non-generator
iterable (array/Set/string) has no meaningful completion value → `R = ()`.

### Consuming a `GenStep` (the accepted rewrite)

The consumer's reads are rewritten against the enum:

| TS | Rust |
|---|---|
| `const { value, done } = it.next()` | `match it.step() { GenStep::Yield(value) => …, GenStep::Return(value) => … }` |
| `const r = it.next(); if (r.done) …` | bind `let r = it.step();` then `r.done` → `matches!(r, GenStep::Return(_))` |
| `r.value` **inside a `!r.done` branch** | the narrowed `GenStep::Yield(v)` binding `v` |

Supported reads: object-destructure `{value, done}`, and a `.done`-guarded `.value`. An
**un-guarded `.value`** (read without a `done` discriminator in scope — where `Y` vs `R`
can't be resolved) stays **fail-loud**. `.next(v)` with an argument → #32.

### `Array.from(iter, fn)` (reuse 057)

At the `Array.from` site (`lower.ts:5571`): with two args, lift arg 2 via `liftCallback`
(arity 1, `indexAllowed: true`), lower arg 1 to its iterator, emit
`iter.map(__cb).collect::<Vec<_>>()` (with `.enumerate()` when the callback reads the index).
Generator source uses its `impl Iterator`; array source uses the existing array→iterator path.

### Generator array-destructuring (rides 067)

`const [a, b] = g()` extends 067's ArrayPattern branch (`lowerVarDecl`, `lower.ts:4098`):
a **fixed-arity** pattern pulls a prefix from the generator's `impl Iterator`
(`let mut __it = g(); let a = __it.next().unwrap(); let b = __it.next().unwrap();`). A rest
element `[a, ...rest]` rides 058's deferred rest decision → fail-loud for now.

### Reuse

052 state machine + liveness; 065 `yield*` delegating state + collecting consumers; 057
`liftCallback` / `.enumerate()`; 027 tslib (new `GenStep` + `Steppable`); 066 undefined
model (`R = ()`); 067 ArrayPattern-over-tuple (destructuring slice).

## Fail-loud residuals

- **Un-guarded `.value`** on a `GenStep` (no `done` discriminator in scope to pick `Y`/`R`).
- **`.next(v)` with a send argument** — #32 (series 076).
- **`yield*` completion value over a delegate typed as a bare `dyn Iterator`** where the
  concrete `Steppable` can't be recovered (e.g. a delegate that isn't a known generator) —
  the completion value is unreadable → fail-loud on the read.
- **Rest-element generator destructuring** `const [a, ...rest] = g()` — rides 058's deferred
  rest decision.
- **Repeated `step()` after terminal** with a non-`()` `R` — JS yields `{value:undefined,
  done:true}` forever; the `__ret.take()` leaves nothing to re-return → fail-loud past the
  first done (rare; documented). `R = ()` re-returns `Return(())` freely.
- **`Array.from` over a non-array, non-generator iterable in the *no-mapping* form** —
  unchanged 065 generator-only gate (the widening is mapping-form-only).
- **Generator-destructuring impl** is **blocked on 067 shipping** (design complete here).

## Impl sequence

1. **tslib** — add `GenStep<Y, R>` enum + `Steppable<Y, R>` trait (`fn step`).
2. **`return <value>`** — graduate `lower.ts:1082`; carry the value to terminal via a
   `__ret` field; `R` from `Generator<Y,R>` / inference / `()`.
3. **`step()` emit** — inherent method on every generator struct (`emitter.ts` generator
   path); `impl Steppable`; keep `impl Iterator` as the delegating/primary surface.
4. **Manual `.next()`** — route `g().next()` **and** variable-bound `it.next()` to `step()`;
   rewrite `{value,done}` destructure + `.done`-guarded reads; un-guarded `.value` fail-loud.
5. **`Array.from(iter, fn)`** — graduate `lower.ts:5583`; `liftCallback` + `.map().collect()`
   + `.enumerate()`; any array/iterable source.
6. **`yield*` completion value** — `Steppable`-boxed delegate when the result is read; bind
   the `Return` payload; result-unread path unchanged (065).
7. **Generator destructuring** *(after 067)* — extend the ArrayPattern branch; fixed-arity
   prefix pull.
8. RED `specs.md` → GREEN (differential — every consumption path matches JS).

## Specs sketch

- `Array.from(g(), x => x * 2)` and `Array.from([1,2,3], (x,i) => x + i)` → `.map().collect()`
  / `.enumerate()`; differential-match.
- `function* g(){ yield 1; return 9 }` + `const it = g(); const {value,done}=it.next()` →
  `Yield(1)`; drive to `Return(9)`; differential-match the `{value,done}` sequence.
- `const r = yield* inner()` where `inner` returns a value → `r` bound to the completion
  value; differential-match. `yield* [1,2,3]` → completion `undefined` (`()`).
- `const [a, b] = pair()` (after 067) → fixed-arity prefix pull; differential-match.
- Fail-loud: un-guarded `r.value`; `it.next(v)` (→ #32); `const [a, ...rest] = g()`.
- Regression: `[...g()]`, `Array.from(g())` (no mapping), `yield*` with the result **unread**
  — **byte-for-byte unchanged** from 065.

## Open sub-details (impl, not dialect forks)

- Whether `impl Iterator::next` delegates to `step()` or keeps 052's direct `Option` arms
  (avoid duplicating the state match).
- `__ret` field vs. threading the return value through the terminal transition; the
  "step after done" boundary for non-`()` `R`.
- `Steppable` object-safety with two type params (`Y`, `R`) for the boxed-delegate path;
  whether the `dyn Steppable` delegate needs `Item`/`Return` associated types instead.
- Narrowing analysis for the `.done`-guarded `.value` read (how much flow-sensitivity to
  implement before falling to fail-loud).
- Variable-bound generator detection (`const it = g()`) — track the binding's generator-
  instance type so `it.next()` / `it` in for-of / `[...it]` resolve (065 gated collecting
  consumers to a *direct* call; this widens to a bound identifier).
