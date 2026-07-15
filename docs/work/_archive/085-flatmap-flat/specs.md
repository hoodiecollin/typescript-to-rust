# 085 — specs

Differential-oracle BDD (compile → `cargo run` → compare vs Bun-run TS), plus
compile-time reject specs for the fail-loud residuals (→ #59). IDs map to
`packages/compiler/tests/flatmap-flat.test.ts`.

## Tractable — GREEN (behaves + emits the expected shape)

- **FM1** `xs.flatMap(x => [x, x * 10])` over `number[]` →
  `iter().flat_map(...).collect::<Vec<_>>()`; result is the flattened `Vec<f64>`
  (one level), differential-matches. Emits `.flat_map(`.
- **FM2** `flatMap` with a captured free var (`const k = 2; xs.flatMap(x => [x,
  x * k])`) — the free var forwards through the lifted `__cb`, differential-
  matches.
- **FM3** `flatMap` returning a **single-element** array (`x => [x]`) — degenerate
  one-to-one, still one-level `flat_map`, matches (identity flatten).
- **FLATK1** `flat(2)` on `number[][][]` → two chained `tslib::array::flat`,
  fully flattened, differential-matches. Emits `tslib::array::flat` (twice).
- **FLATK2** `flat(1)` on `number[][]` — the literal-1 form equals the depth-1
  `flat()`, matches.
- **FLATK3** `flat(3)` on `number[][][][]` — three chained flattens, matches.

## Fail-loud residuals — REJECT (→ #59)

- **FM-FL1** `flatMap` with a `U | U[]` **union** callback
  (`x => x % 2 === 0 ? [x, x] : x`) — heterogeneous return → compile-time
  `UnsupportedError` (the array-branch typer rejects the non-array branch).
- **FLATK-FL1** dynamic-depth `flat(n)` where `n` is a **variable** — not claimed
  → generic fallthrough → cargo rejects (`Vec` has no `.flat`).
- **FLATK-FL2** `flat(Infinity)` — non-integer-literal arg → not claimed →
  cargo-loud.
- **FLATK-FL3** `flat(2)` on a receiver **not nested 2 deep** (`number[][]`,
  jagged-shallow) — the k-level walk hits a non-`vec` level → compile-time
  `UnsupportedError` (receiver isn't nested that deep). Stands in for the jagged
  residual: a shape the static walk can't prove flattens uniformly.

## Regression carve-out

Existing `library-methods-array.test.ts` ARR-FL1 (flatMap) and ARR-FL2
(`flat(2)`) asserted these were fail-loud. They now ship. Those two specs are
**updated** to assert the *new* fail-loud boundary (union callback / dynamic n),
keeping the file green. FLAT2a (depth-1 `flat()`) and all other array specs stay
byte-for-byte green.
</content>
