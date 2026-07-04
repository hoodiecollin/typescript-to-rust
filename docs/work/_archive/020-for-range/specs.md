# 020 — Specs: idiomatic `for i in a..b` ranges

Drives the public `emit(...)` entry. Unit specs pin the emitted shape; the
cargo-backed COMPILES/BEHAVES proof lives in `compiler.test.ts`. Spec file:
`tests/for-range.test.ts`.

RED against the while-desugar: until `promoteRanges` lands, an index-driven
counting loop still emits `let mut i: usize = 0; while i < arr.len()`, so the
`for i in` assertions fail. RANGE5/6 are green controls / non-promotion.

- **RANGE1** — an index-driven loop with a `.length` bound promotes to a range.
  `for (let i = 0; i < arr.length; i = i + 1) { console.log(arr[i]); }` →
  contains `for i in 0..arr.len()`; does **not** contain `while i <`.

- **RANGE2** — a literal bound emits a bare integer range.
  `for (let i = 0; i < 3; i = i + 1) { … arr[i] … }` → contains `for i in 0..3`
  (no `0.0..3.0`, no `while`).

- **RANGE3** — a `<=` test emits an inclusive range.
  `for (let i = 0; i <= 2; i = i + 1) { … arr[i] … }` → contains `for i in 0..=2`.

- **RANGE4** — a `break` in the body is preserved and stays native (the loop is
  still a range). Body with `if (…) { break; }` → contains `for i in 0..` and
  `break;`, no `while`.

- **RANGE5** (non-promotion) — the accumulator loop stays a `while`.
  `for (let i = 0; i < 5; i = i + 1) { total = total + i; }` (`i` is `f64`, flows
  into `total`) → contains `while i < 5.0`, no `for i in`.

- **RANGE6** (non-promotion) — a loop whose body has an own `continue` keeps the
  018 while-desugar. Index-driven body with `if (…) { continue; }` → contains
  `while i <` and the inlined `{ i = i + 1; continue; }`, no `for i in`.

## Differential (compiler.test.ts, cargo)

- An index-sum loop (`for i in 0..arr.len()`) sums an array to the same value as
  the TS run (`10`).
- A literal-bound loop (`for i in 0..3`) over a longer array sums the first three
  elements identically (`60`).
