# 105 — Specs: module-wide integrality lattice

Drives the public `emit(...)` / `compile(...)` entry via the differential harness
(`tests/_support/differential`), cargo-compiling and running each program so every shape
assertion is also a COMPILES/BEHAVES proof. Spec file:
`packages/compiler/tests/callback-integrality.test.ts`. Per the corpus-coverage rule,
every decided behavior gets a fixture — including the negative (`Real`) rejects that keep
`f64`, which are the soundness-critical cases.

## Positive — integer-domain modulo reaches the callback (RED until 105 lands)

- **CI1** (arraypipe shape) — a `Vec` built from an integer counter, `map`ped
  (`v*2+1`), then `filter`ed on `v % 5`: the filter callback emits integer-domain
  modulo (`(v as i64) % 5` or a fully-`i64` `v % 5`), **not** `v % 5.0`. Prints the
  identical checksum to node/bun.
- **CI2** (element propagation through map) — `xs` integer, `map(v => v * 3)` (integer
  output element), consumed by a callback doing `w % 2`: the element integrality flows
  through the map so `w % 2` is integer-domain.
- **CI3** (free-fn param) — a free function `f(n: number)` called only with integer
  args whose body does `n % 4` specializes the modulo (existing `propagateIntegerParams`
  path, now driving `intDomain` in a non-callback body too).
- **CI4** (reduce accumulator + element) — a `reduce((a, b) => (a + b) % 7, 0)` over an
  integer element emits integer-domain modulo for `%`.

## Negative — stays f64 (each isolates a Real-forcing source; soundness-critical)

- **CI5** (fractional source element) — a `Vec` containing `0.5` (or built from `i * 0.5`)
  feeding `v % 5`: the element slot is `Real`, so the modulo stays `v % 5.0`. Value
  identical to node/bun (proves we don't truncate fractional data).
- **CI6** (division upstream) — `map(v => v / 2)` produces a `Real` element, so a
  downstream `w % 3` stays `f64`. Value identical.
- **CI7** (param Real at one call site) — a free function called with an integer arg at
  one site and a fractional arg (`3.5`) at another keeps its param `f64`; its `%` is not
  specialized. Value identical.
- **CI8** (mixed callback body) — a callback `v % 5 + 0.5` mixes a fractional literal;
  the value is `Real`, modulo stays `f64`. Value identical.

## Cross-spec updates (live files the impl must touch)

- **`benchmarks/README.md`** — after 105 re-measures, move `arraypipe` from the *loses*
  discussion to a **win** (steady-state target ~1.4ms), noting integer-domain modulo now
  reaches callback bodies.
- **`docs/dialect.md`** — if needed, widen the accepted-`i64` divergence note to state it
  applies to proven-integer callback params / iterator elements, not only intra-body
  bindings (no new posture — same ruling, broader reach).
- **`benchmarks/corpus/arraypipe.ts`** — already the positive workload; no new corpus
  file. The `Real`-reject cases are correctness fixtures in the spec file.

## Differential (cargo-backed)

- arraypipe prints its checksum identically under node/bun/ttr before and after 105.
- CI5–CI8 each print the identical value with the modulo left `f64` (proving the lattice
  rejects rather than truncates — the guards are load-bearing).
- Every fixture compiles under cargo (the `as i64` / i64 element threading validated by
  the oracle, not shape alone).
