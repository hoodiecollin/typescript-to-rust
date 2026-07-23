# 111 — Specs: `.length` → `f64` coercion

Spec file: `packages/compiler/tests/length-f64.test.ts`. The differential harness
cargo-compiles and runs each program, so every shape assertion is also a COMPILES/BEHAVES
proof (byte-identical to node/bun).

## Positive — `.length` in an f64 context now compiles

- **LF1** binding — `const n: number = arr.length` → `let n: f64 = (arr.len() as f64)`.
- **LF2** return — `return arr.length` → `return (arr.len() as f64)`.
- **LF3** arithmetic — `arr.length / 2 + 1` (the whole expression is f64).
- **LF4** string length — `s.length` in f64 context → `(s.chars().count() as f64)`.
- **LF5** argument — `size(arr.length)` → `size((arr.len() as f64))`.
- **LF6** comparison vs fractional — `arr.length > 2.5` → `(arr.len() as f64) > 2.5`.

## Negative — usize slots stay a bare `usize` (no regression)

The load-bearing half: a `.length` the usize analysis claimed must **not** be cast.

- **LB1** range bound — `for (i < arr.length)` → `for i in 0..arr.len()`, no `as f64`.
- **LB2** both — a length used as a bound (bare) *and* a separate f64 count (cast) in the
  same body; each `len` node classified independently.
- **LB3** index — `arr[arr.length - 1]` → `arr[arr.len() - 1]`, no `as f64`.
- **LB4** (emit-only) un-promoted `while (i < arr.length)` keeps `i < arr.len()` bare.

## Verification gate

- Full compiler suite green — **the regression gate**: every `.length`-bounded workload
  (`sieve`, `sort`, `arraypipe`, `histogram`, …) stays byte-identical (no usize bound
  wrongly cast to f64).
- `dialect.md` updated: the "`.length` does not coerce into f64 arithmetic" restriction is
  lifted.
