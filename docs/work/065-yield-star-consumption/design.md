# 065 — Generators: `yield*` delegation & non-`for-of` consumption

> **Status: DESIGN (decided, awaiting impl).** Graduates the fail-loud deferral in
> issue #20. Rides the **052** generator state machine (`fn -> impl Iterator<Item=T>`)
> and its pre-designed `yield*` hook; composes with 035's `for-of` consumption.
> Dialect decisions made with Collin 2026-07-09.

## The problem

A generator lowers to `fn g(…) -> impl Iterator<Item = T>` via 052's state machine.
Two things stay fail-loud:

1. **`yield* inner()`** — delegate: yield everything another iterable produces, then
   resume. 052 pre-designed the mechanism (delegate iterator as a state field, pump
   `self.inner.next()` until exhausted) and reserved it for #20.
2. **Non-`for-of` consumption** — spread `[...g()]`, `Array.from(g())`,
   array-destructuring `[a, b] = g()`, and **manual `.next()`**.

The only real difficulty is manual `.next()`: JS's protocol returns `{ value, done }`
and `gen.next(v)` can pass a value **back into** the generator (bidirectional
coroutine). Rust's `Iterator::next()` is pull-only, returns `Option<T>`, and cannot
accept a resumed-in value — so bidirectional `next(v)` has **no** `impl Iterator`
mapping. The *collecting* consumers, by contrast, map trivially to `.collect()`.

> **Toolchain note.** The transpiler emits **stable** Rust (no toolchain pin, no
> `#![feature]`); 052 hand-rolls the stackless generator machine precisely to avoid
> nightly. So nightly `std::ops::Coroutine` (which *does* support resume-with-value)
> is off the table — it would force every downstream consumer of the generated crate
> onto nightly. Stackful crates (`May`, `corosensei`) are stable but bring a
> green-thread runtime with real per-coroutine stacks — disproportionate when 052
> already produces stackless machines. Neither is needed (see below).

## Decisions

- **Fork 1 — `yield*` delegates to any iterable.** Any `IntoIterator` whose `Item`
  unifies with the outer generator's `Item`: another generator, array, `Set`, `Map`,
  string. Matches JS; nearly free given the uniform `impl Iterator` shape. **Fail-loud
  on `Item` mismatch.**
- **Fork 2 — collecting consumers only.** Support spread, `Array.from`, and
  array-destructuring via `.collect()`/`.take()`. **All manual `.next()` stays
  fail-loud** (both the `{value,done}` read-loop and bidirectional `next(v)`).
  Cleanest + most legible; covers the common consumers. (Options B/C — idiom-rewrite
  or a synthesized `{value,done}` struct — deferred; may graduate later.)
- **Bidirectional `gen.next(v)`** (passing a value *into* a suspended generator, so
  `yield` is an expression) — fail-loud **here**, but **not** permanent and **not**
  blocked on nightly. Deferred to its **own future series**, feasible on **stable**
  (see "Bidirectional generators" below).

## Mechanism

### `yield*` delegation (rides 052)

A `yield* <expr>` inside a generator body becomes a **delegating state** in the 052
state machine:

- Add a field for the delegate iterator: `__delegate: <IntoIterator::IntoIter>`,
  seeded from `<expr>.into_iter()` on first entry to the state.
- The state's `next()` arm pumps `self.__delegate.next()`: `Some(v)` → return
  `Some(v)` (stay in this state); `None` → advance to the next state (delegate
  exhausted), fall through to the code after the `yield*`.
- The delegate's `Item` must unify with the generator's declared `Item = T`
  (from the `Generator<T>` / `IterableIterator<T>` annotation). **Mismatch →
  `DialectError`.**
- A `yield*` over a **non-generator** iterable (`yield* [1,2,3]`, `yield* someSet`)
  works identically — the field just holds that iterable's `IntoIter`. Nested/chained
  `yield*` compose (each is its own delegating state).

```ts
function* inner(): Generator<number> { yield 1; yield 2; }
function* outer(): Generator<number> { yield 0; yield* inner(); yield 3; }
```
The `outer` state machine gains a state whose arm drives `inner()`'s iterator to
exhaustion before yielding `3`.

### Collecting consumers (compose with `impl Iterator`)

| TS | Rust |
|---|---|
| `[...g()]` (array spread of a generator) | `g().collect::<Vec<_>>()` |
| `Array.from(g())` | `g().collect::<Vec<_>>()` |
| `const [a, b] = g()` (array destructuring) | pull `a`/`b` via `.next()` then bind, or `.collect()` + index (impl call) |
| `g().map(..)` / `.filter(..)` already ride `impl Iterator` | unchanged from 035 |

Array-spread and `Array.from` reuse the existing array-construction path with the
generator's `impl Iterator` as the source; `.collect::<Vec<T>>()` yields the `Vec` JS
would materialize. Destructuring binds a fixed prefix (`.next().unwrap()` per binding,
or collect-then-index) — the fixed-arity shape is statically known.

### Manual `.next()` — fail-loud

- `it.next()` used for its `{value, done}` object, and any `it.next(v)` passing a
  value in → `DialectError`, pointing at the call and explaining that `impl Iterator`
  is pull-only (`Option<T>`, no resume-in value). The message notes spread /
  `Array.from` / `for-of` as the supported consumption forms.

### Bidirectional generators — deferred, stable-feasible (own series)

`gen.next(v)` making `yield` an **expression** (`const x = yield emit`) is fail-loud
in 065 but is a *scope* boundary, not a capability one. It does **not** need nightly
`Coroutine` or a stackful crate:

- **052 already builds the machine.** It hand-rolls the stackless CFG→state-machine
  with liveness across yields. The extension is a **`resume(&mut self, sent: V) ->
  GenStep<Y, R>`** method that binds `sent` as the value of the `yield` expression in
  the resumed state arm — pure stable Rust, same technique 052 uses for `next()`.
- **The send entry point can't be `Iterator::next` — a signature mismatch, not a
  deeper limit.** `Iterator::next(&mut self)` takes **no parameter**, so there is
  nowhere to thread the sent value. The send value therefore needs a *separate
  inherent method* `resume(&mut self, sent: V) -> GenStep<Y>`. That mismatch — **not**
  the state machine, which is identical to 052 — is the whole reason bidirectional
  isn't "just `Iterator`."
- **It can still ALSO `impl Iterator`.** When the sent type `TNext` is defaultable
  (notably: includes `undefined`), the same struct additionally implements
  `Iterator` with `fn next(&mut self) { self.resume(<default>) }`. This is **faithful**
  — JS `for (const x of gen())` also passes `undefined` into each `next()`. So a
  bidirectional generator can expose **both** surfaces on one struct: `impl Iterator`
  (for `for-of` / `.collect()` / `yield*`) **and** `resume(v)` (for the send path) —
  it is *not* necessarily a distinct, iterator-less type. Whether to always emit both,
  or only `impl Iterator` when `TNext` is defaultable, is the open design question in
  the follow-on. The per-generator signal for *needing* `resume` is clean: any
  `yield` whose **result is read** makes the generator bidirectional.
- **Types** come from TS's third generator type param `Generator<Y, R, TNext>`
  (`TNext` = resume-in type); unannotated → fail-loud. The first `next()`'s argument
  is discarded (no pending `yield` yet), matching JS.

This is a meaningful feature (new emitted shape + consumption surface), so it graduates
in its **own series**, not 065.

## Fail-loud residuals

- **Manual `.next()`** — read-loop and bidirectional both (Fork 2 = A). Read-loop may
  graduate later (idiom-rewrite or synthesized struct); bidirectional needs coroutines.
- **`yield*` Item-type mismatch** — the delegate yields a type that doesn't unify with
  the generator's `Item`.
- **`return`-value of a generator** (`function* g(){ return x }` — the `value` on the
  final `{done:true}`) — not modeled by `Iterator`; stays fail-loud (its own concern).
- **Infinite generator into a collecting consumer** (`[...naturals()]`) — would hang;
  same footgun as JS, not specially rejected (the user asked to collect an infinite
  stream). `.take(n)` is the escape.

## Impl sequence

1. `yield*` delegating state in the 052 state machine: `__delegate` field seeded via
   `.into_iter()`; pump-until-`None`; `Item` unification check.
2. Collecting consumers: spread + `Array.from` → `.collect::<Vec<_>>()`; hook into the
   existing array-construction path.
3. Array-destructuring of a generator (fixed-arity bind).
4. Manual `.next()` → `DialectError` with the supported-forms hint.
5. RED specs → GREEN (differential; delegated sequences and collected `Vec`s match JS).

## Specs sketch

- `yield* inner()` → outer yields the concatenated sequence; differential-match.
- `yield* [1,2,3]` and `yield* aSet` (non-generator iterables).
- `yield*` Item mismatch → `DialectError`.
- `[...g()]` and `Array.from(g())` → `Vec`; `const [a,b] = pair()` destructure.
- Fail-loud: `const r = it.next(); r.done` (manual protocol); `it.next(v)` (bidirectional).

## Open sub-details (impl, not dialect forks)

- Array-destructuring via per-binding `.next().unwrap()` vs. `.collect()`-then-index —
  pick by arity / whether the tail is captured (`[a, ...rest]` rides the deferred rest
  decision from 058).
- Whether `Array.from(g(), mapFn)` (the mapping overload) rides 057's callback
  machinery or stays fail-loud initially.
- The delegate field's concrete `IntoIter` type naming in the state struct (reuse
  052's local-field typing).
