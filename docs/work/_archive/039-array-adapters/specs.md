# 039 — specs

Differential specs (COMPILES + BEHAVES) in
`packages/compiler/tests/array-adapters.test.ts`.

- **ADP1** `some` → `.iter().any(|&x| …)`; `[1,2,3].some(x => x > 2)` prints `true`.
- **ADP2** `some` false case; `[1,2,3].some(x => x > 5)` prints `false`.
- **ADP3** `every` → `.iter().all(|&x| …)`; `[1,2,3].every(x => x > 0)` prints `true`.
- **ADP4** `every` false case; `[1,2,3].every(x => x > 1)` prints `false`.
- **ADP5** `reduce` sum → `.iter().fold(0, |acc, &x| acc + x)`; prints `6`.
- **ADP6** `reduce` with a non-zero init and product; prints the folded value.
- **ADP7** (routing) the emitted Rust contains `.any(`, `.all(`, `.fold(` — native,
  not `tslib`.
- **ADP8** (fail-loud) `reduce` with **no** init arg throws `UnsupportedError`.
- **ADP9** (guard) a user class method named `reduce` is a native call, not hijacked.
