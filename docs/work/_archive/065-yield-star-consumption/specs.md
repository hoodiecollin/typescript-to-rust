# 065 — specs (`yield*` delegation & collecting consumption)

> **Status: SHIPPED.** Differential BDD specs live in
> `packages/compiler/tests/generator-yield-star.test.ts` (compile → cargo run →
> TS-via-Bun). IDs map 1:1 to the test names.

## Specs

- **YS1** `yield* inner()` delegates to another generator — a delegating state in
  the 052 machine seeds `Some(Box::new(inner().into_iter()))` and pumps it to
  exhaustion (`Box<dyn Iterator<Item = f64>>` field).
- **YS2** `yield* [20, 30]` delegates to a non-generator iterable (`.into_iter()`
  on the array).
- **YS3** chained `yield*` compose (`c` delegates `b` delegates `a`).
- **CON1** `[...g()]` collects a generator into a `Vec` (`g().collect::<Vec<_>>()`).
- **CON2** `Array.from(g())` collects a generator into a `Vec`.
- **FL1** (fail-loud) manual generator `.next()` is rejected — `impl Iterator` is
  pull-only (`Option<T>`, no `{value, done}`, no resumed-in value).

## Fail-loud residuals

- **Manual `.next()`** — the `{value, done}` read-loop and bidirectional `next(v)`
  both. A direct `g().next()` gets a clean `UnsupportedError`; `it.next()` on a
  generator-bound variable is cargo-loud (the `{value, done}` fields don't exist on
  `Option`).
- **Array-destructuring of a generator** (`const [a, b] = g()`) — not implemented
  (deferred; the collecting consumers cover the common forms).
- **Collecting consumers are gated to a direct generator call** (`[...g()]`,
  `Array.from(g())`). A generator held in a variable, an iterator chain
  (`g().map(...)`), or a plain array (`[...a]`) stays fail-loud (the latter is
  series 044's residual, not 065's scope).
- **`yield*` `Item`-type mismatch** — the `Box<dyn Iterator<Item = T>>` field type
  makes a mismatched delegate cargo-loud (not a pre-emptive `DialectError`).
- **Bidirectional `gen.next(v)`** (`yield` as an expression) — its own future
  series (stable-feasible via an inherent `resume` method; not blocked on nightly).
- **Generator `return`-value** (the `value` on the final `{done: true}`) — not
  modeled by `Iterator`.
