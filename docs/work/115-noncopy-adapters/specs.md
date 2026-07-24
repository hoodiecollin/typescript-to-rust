# 115 — Specs: non-Copy element adapter chains

Spec file: `packages/compiler/tests/noncopy-adapters.test.ts`. Cargo-compiled +
differential. Issue #96. Element type `string[]` (non-Copy) throughout. **7/7 green.**

## reduce over non-Copy

- **NC1** count-fold — `parts.reduce((acc, p) => acc + 1, 0)` (f64 acc, borrowed `&String`
  element) → `.fold(0.0, …)`; differential number matches.
- **NC2** String-accumulator — `parts.reduce((acc, p) => acc + p, "")` (owned `String`
  accumulator, borrowed element) → concatenates; needs the `typeCbBody` `+`→`String` fix
  so the lifted fn returns `String`; differential matches.
- **NC3** element-length fold — `parts.reduce((acc, p) => acc + p.length, 0)` (f64) →
  reads the borrowed element's `.length`; pins that a numeric `+` with a non-typeable
  operand (`p.length`) still types `f64`; differential matches.

## forEach over non-Copy

- **NC4** — `parts.forEach(p => { total += p.length })` → `for p in parts.iter()`
  (binds `&String`), **not** `for &p`; differential matches.

## split receiver (the #88 unblock)

- **NC7** split→map — `s.split(",").map(p => p === "bb")` → `Vec<bool>`; the split
  element resolves to `String` so the callback lifts; differential matches.
- **NC7b** split→reduce — `s.split(",").reduce((acc, p) => acc + p.length, 0)`; lifts +
  differential.
- **NC7c** split→forEach — `s.split(",").forEach(p => { total += p.length })`; borrowed
  `for p in …` head; differential.

## Out of this series (recorded in design.md)

- **`X.map(cb).reduce(…)` chain** — blocked by adapter-result element typing (Copy too),
  filed **#100**. Not pinned here.
- **Split adapter/forEach streaming** — the #88 perf tail; the adapters lower + are
  differential-correct (materialized), streaming tracked under **#88**.
- The "no silent clone" guard (`closures.ts`) still fires on an owned-move element use.

## Verification gate

- `noncopy-adapters.test.ts` 7/7 green.
- `split-lazy.test.ts` (107) + `split-consumers.test.ts` (112) still green (shared paths).
- Existing Copy-element adapter specs (057/048/083) still green (Copy fast-path unchanged).
- Full compiler suite no regression.
