# 076 — Bidirectional generators (`gen.next(v)` resume-value): specs

Differential-oracle BDD (compile → `cargo run` → compare stdout vs Bun-run TS).
IDs map to `packages/compiler/tests/bidirectional-generators.test.ts`. Graduates
the bidirectional `gen.next(v)` deferral (issue #32) over 052's state machine +
075's `GenStep<Y, R>` — adding a `resume(&mut self, sent: TNext) -> GenStep<Y, R>`
inherent method (the value-**in** path).

## `resume` — send-value round-trips (decision 1 + 2 + 3)

- **SR1** `function* g(): Generator<number, void, number> { const a = yield 1;
  const b = yield a * 2; }` driven by `g().next()` / `.next(10)` / `.next(20)`
  through a `{ value, done }` read → the send value threads into the resumed
  `yield` expression; first `next(x)` discards `x`; differential-match the
  `{ value, done }` sequence.
- **SR2** the send value is used inside the generator (a `yield` result read then
  used in a later computation / logged) → the resumed binding carries the sent
  value; differential-match.
- **SR3** a bare `gen.next()` (no arg) on a bidirectional generator sends the
  `TNext` default (`undefined` model); differential-match.
- **SR4** the emitted Rust carries a `fn resume(&mut self, sent:` inherent method
  and threads `sent` into the resumed arm.

## Dual surface — `impl Iterator` when `TNext` is defaultable (decision 2)

- **DS1** a bidirectional generator whose `TNext` includes `undefined`
  (`Generator<number, void, number | undefined>`) still supports `for-of` — the
  loop sends the default into each `resume`; differential-match.
- **DS2** the `step()`/`next()` surface of a defaultable-`TNext` bidirectional
  generator routes through `resume(<default>)` (the emitted `next` calls `resume`).

## Fail-loud residuals

- **FL1** a non-defaultable `TNext` bidirectional generator consumed by `for-of`
  → fail-loud (no `impl Iterator`; only `resume`).
- **FL2** an **unannotated** `TNext` with a read yield result (`const x = yield e`
  where the generator declares no 3rd type arg) → fail-loud (can't type `sent`).

## Regression (075/052, byte-for-byte)

- **REG1** a generator with **no** read yield result (`yield e;` statement only)
  stays on the 075 pull-only path — no `resume`, `step()` is the direct driver.
- **REG2** plain for-of over a non-bidirectional state-machine generator is
  unchanged.
