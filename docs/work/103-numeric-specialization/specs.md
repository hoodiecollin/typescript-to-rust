# 103 — Specs: numeric type-specialization

Drives the public `emit(...)` / `compile(...)` entry via the differential harness
(`tests/_support/differential`), which cargo-compiles and runs the emitted Rust so
every shape assertion is also a COMPILES/BEHAVES proof. New spec files:
`tests/numeric-int-modulo.test.ts` (103a) and additions to `tests/numeric.test.ts`
(103b).

## 103a — local integer-domain `%` (RED until the int-modulo emit lands)

- **NIM1** — a modulo on an integer-counter, integer-literal divisor emits in the
  integer domain. `for (let i=0;i<10;i=i+1){ if (i%3===0) … }` → contains
  `(i as i64) % 3` (or a fully-`i64` `i % 3` once 103b lands); does **not** contain
  `i % 3.0`. Behaviour identical to the TS run.
- **NIM2** — modulo feeding an integer comparison stays int-domain with no back-cast:
  `i % 2 === 0` → `… % 2 == 0`, no `as f64` around the remainder.
- **NIM3** (non-eligible) — a modulo on a genuinely-fractional operand is left `f64`:
  `const x: number = 1.5; console.log(x % 1.0);` → contains `x % 1.0` (no `as i64`).
- **NIM4** (loopsum shape) — the corpus loop body emits integer modulo and the
  program prints the same checksum as node/bun (`4166662500000`).

## 103b — integer counter & accumulator specialization

- **NIS1** — a bare counting loop with no index and no accumulator retypes the
  counter to `i64` and promotes to a typed range: `for (let i=0;i<5;i=i+1){ … }`
  → `for i in 0i64..5` (no `while i < 5.0`).
- **NIS2** — the **mutually-integer accumulator loop** retypes both bindings:
  `let acc=0; for(let i=0;i<5;i=i+1){ acc = acc + i; }` → `let mut acc: i64 = 0`,
  counter `i64`, `acc = acc + i` with **no** `as f64` cast. (This is the case 020
  RANGE5 marked non-promotable — see cross-spec note.)
- **NIS3** — a **mixed** loop keeps `f64` where a fractional value flows in:
  `let sum=0; for(let i=0;i<5;i=i+1){ sum = sum + i * 0.5; }` → `sum` stays `f64`;
  the counter may still specialize with an `as f64` cast at the mix site. Value
  identical to TS.
- **NIS4** — return-type specialization: `function f(): number { let a=0;
  for(let i=0;i<3;i=i+1) a=a+i; return a; }` → `fn f() -> i64`; the printed result
  matches the TS run.
- **NIS5** (non-eligible) — a binding assigned a fractional literal is never
  specialized: `let a=0; a = a + 0.5;` → `a: f64`.
- **NIS6** (division guard) — a binding that is an operand of `/` stays `f64`
  (truncation would change the value): `let a=10; console.log(a / 3);` → `a: f64`,
  emits float division.

## Cross-spec updates (live files the impl must touch)

- **`tests/for-range.test.ts` RANGE5** — currently asserts the accumulator loop
  stays a `while` "because `i` is `f64`." Under 103b both bindings become `i64`, so
  it now **promotes** to `for i in 0i64..5`. Update RANGE5 to assert the promoted
  `i64` range (or repoint it at a genuinely-`f64` accumulator, e.g. `total + i*0.5`,
  to keep a non-promotion control).
- **`docs/dialect.md`** — add the accepted-divergence table (2⁵³ / `i64::MAX`) from
  the design doc; this is the first sanctioned divergence from the pure-`f64` model.
- **`benchmarks/README.md`** — move `loopsum` from the "loses" to the "wins"
  discussion in *Reading the numbers* after 103c re-measures.

## Differential (cargo-backed)

- loopsum prints `4166662500000` identically under node/bun/ttr with integer modulo.
- An accumulator loop sums to the same integer value before/after specialization.
- A fractional loop (`sum + i*0.5`) is untouched and prints the identical float.
