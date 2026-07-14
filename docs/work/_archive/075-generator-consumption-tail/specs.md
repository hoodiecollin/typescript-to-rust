# 075 — Generator consumption tail: specs

Differential-oracle BDD (compile → `cargo run` → compare stdout vs Bun-run TS).
IDs map to `packages/compiler/tests/generator-consumption-tail.test.ts`. Graduates
the four 065 deferred consumption residuals (issue #39) over the `GenStep<Y, R>`
tslib enum + `Steppable` trait + inherent `step()`.

## `Array.from(src, fn)` — the mapping overload (decision 2)

- **AF1** `Array.from(g(), x => x * 2)` over a generator source → `g().map(__cb)
  .collect::<Vec<_>>()`; differential-match.
- **AF2** `Array.from([1,2,3], (x, i) => x + i)` over an array source with the index
  overload → `.iter().enumerate().map(…)`; differential-match.
- **AF3** `Array.from(g(), (x, i) => x + i)` — generator source, index overload →
  `.enumerate()`; differential-match.
- **AF4** regression: `Array.from(g())` (no mapping) still collects to a `Vec`
  (065 path, unchanged).

## Manual `{ value, done }` read (decision 1 + 4)

- **MN1** `const it = g(); const { value, done } = it.next()` over
  `function* g(): Generator<number, number> { yield 1; yield 2; return 9 }` →
  a `(value, done)` tuple driven off `step()`; differential-match the first step.
- **MN2** driving to completion: a second `{ value, done }` read yields the
  `return 9` completion (`done: true`); differential-match.
- **MN3** a direct `g().next()` destructure (no intermediate binding) works.
- **MN4** fail-loud: `const s = it.next()` binding the whole result (the
  `let r = it.step()` residual — not the `{ value, done }` shorthand).
- **MN5** fail-loud: `it.next(v)` with a send argument (→ #32).

## Generator `return <value>` → `GenStep::Return(R)` (decision 1)

- **RV1** `function* g(): Generator<number, number> { yield 1; return 9 }` compiles
  (a `__ret: Option<f64>` field + `GenStep::Return`); a for-of over it still yields
  just `1` (JS for-of drops the completion value); differential-match.
- **RV2** an inferred `R` (`return 9`, no 2nd type arg) also compiles.

## `yield*` completion value (decision 3)

- **YR1** `const r = yield* inner()` where `inner` returns a value → `r` bound to the
  completion; the delegate is boxed as `dyn Steppable`; differential-match.
- **YR2** regression: `yield*` with the result **unread** keeps 065's `dyn Iterator`
  box + `.next()` (byte-for-byte).
- **YR3** fail-loud: a read `yield*` over a non-generator iterable (`const r = yield*
  [1,2,3]`) — no completion value exists.

## Generator array-destructuring (decision, rides 067)

- **GD1** `const [a, b] = pair()` → a fixed-arity prefix pull off the generator's
  `impl Iterator`; differential-match.
- **GD2** fail-loud: `const [a, ...rest] = g()` (rest element rides 058).

## Regression (065, byte-for-byte)

- **REG1** `[...g()]` still collects to a `Vec`.
- **REG2** `Array.from(g())` (no mapping) still collects to a `Vec`.
- **REG3** plain for-of over a state-machine generator is unchanged.
