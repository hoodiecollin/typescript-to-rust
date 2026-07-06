# 035 — Sync generators → `impl Iterator` (the deferred 025d slice)

> **Status: FIRST SLICE LANDED.** Implements the sync-generator slice deferred by
> series 025 (which is archived — follow-ups get a new series, so this is 035, not
> a re-open of 025). Pass lives in `lower.ts` (`lowerGenerator`); specs in
> `packages/compiler/tests/generators.test.ts`.

## Scope (first slice): straight-line finite yields

A generator whose body is exactly a sequence of `yield <expr>;` statements:

```ts
function* g(): Generator<number> {   →   fn g() -> impl Iterator<Item = f64> {
  yield 1;                                   return vec![1.0, 2.0, 3.0].into_iter();
  yield 2;                               }
  yield 3;
}
for (const x of g()) { … }            →   for x in g() { … }
```

The insight that keeps this idiomatic and state-machine-free: a **straight-line
finite-yield generator is just a fixed sequence.** `vec![y1, …, yn].into_iter()`
is a faithful, idiomatic `impl Iterator<Item = T>` — no mini-CPS state machine is
needed for the finite case (that was the hard part the 025 plan flagged, and it's
deferred to the shapes that actually require it).

## Mechanism

- **Validator (`validate.ts`)** no longer blanket-rejects the generator flag.
  `YieldExpression` is modeled; a top-level sync `function*` **declaration**
  passes the flag gate (its shape is enforced in lowering). Still `DialectError`:
  **async** generators (`async function*` — need `Stream`, out of std) and
  generator **methods/expressions** (`FunctionExpression` generators).
- **Analysis (`analysis.ts`)** collects `generators: Set<string>` — top-level
  `function*` names — so a `for-of` over such a call can consume it directly.
- **Lowering (`lowerGenerator`)** — the item type comes from the
  `Generator<T>` / `IterableIterator<T>` / `Iterable<T>` return annotation
  (first type arg). The body must be all bare `yield <expr>;`; each yield's
  argument lowers to an element of an `array`, wrapped in `.into_iter()` and
  returned. The fn's `ret` is the new `implIterator` `RustType`.
- **`for-of` consumption (`lowerForOf`)** — a `for (const x of g())` whose right
  side is a call to a known generator drops the usual `.iter()` (the call already
  yields an iterator) and binds `x` by value (`Item = T`). Everything else still
  iterates by reference (`.iter()`, `&T`).
- **Emitter** — `implIterator` → `impl Iterator<Item = T>`; the body reuses the
  existing `array` + `method` + `return` emission (no new expr kind).

## Deferred (fail-loud today — `UnsupportedError`, cargo-loud never silent)

- **State-machine shapes:** a `yield` inside a loop / `if` / `switch`, or any
  non-`yield` statement interleaved with yields. These need the real mini-CPS
  transform. (`yield`-in-a-loop can often become an iterator-adapter chain —
  `(0..n).map(…)` — a good next increment that avoids the full state machine.)
- **`yield*` delegation**, **bare `yield`** (no value), and generators with **no
  `Generator<T>` annotation** (item type can't be inferred soundly).
- **Async generators** (`Stream`) and **generator methods** — still `DialectError`.
- **Non-`for-of` consumption** (spread `[...g()]`, manual `.next()`): the fn
  returns a plain `impl Iterator`, so `.collect()`/adapters work at the Rust
  level, but no TS-side lowering routes them yet.

## Relationship to 025

025 shipped `using`→`Drop`, parameter properties, and `enum`, and explicitly
deferred sync generators as "their own future slice." This is that slice. The
025 archive's specs note ("sync generators deferred") is now satisfied by 035.
