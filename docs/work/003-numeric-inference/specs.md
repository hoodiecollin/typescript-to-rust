# 003 — Specs

Natural-language specs for numeric inference, transcribed into
`tests/numeric.test.ts` (unit, cargo-free) plus one oracle fixture. IDs are
referenced from the test file.

The unit specs drive `refineNumerics(module: HirModule): HirModule`, building
input HIR through `lower(parseSync(...).program)` (real lowering, so the input is
realistic) and asserting the refined output. They are **RED against the identity
mock** (`numeric.ts` returns the module unchanged) and go GREEN when the real pass
lands.

## Refinement — `usize` typing

- **N1** — a binding used as a *variable* array index is refined to `usize`.
  `const arr: Array<number> = [1]; const i: number = 0; const x: number = arr[i];`
  → the `let i` has `ty === { kind: "usize" }`. (Mock leaves it `f64` → RED.)

- **N2** — the integer-literal initializer of a `usize` binding is tagged
  `ty: "usize"` (so it emits bare, not `.0`). Same input as N1 → `let i`'s `init`
  number node has `ty === "usize"`.

- **N3** — `usize`-ness propagates through a `let` chain.
  `... const i: number = 0; const j: number = i + 1; const x: number = arr[j];`
  → both `i` and `j` are `usize`; the literals `0` and `1` are `usize`-tagged.

- **N4** — `usize`-ness propagates within an index expression.
  `... const i: number = 0; const x: number = arr[i + 1];`
  → `i` is `usize` and the literal `1` inside the index is `usize`-tagged.

- **N5** — a `number` not used as an index stays `f64`.
  `const a: number = 1; const b: number = 2.5;` → neither binding is `usize`; the
  literal `1` is left untagged/`f64` (emits `1.0`), `2.5` stays verbatim.

- **N6** — refinement is scope-local. `i` used as an index inside `f` does not
  force a same-named `i` in `main`/another function to `usize`.

## Conflict — fail loud

- **N7** — a fractional literal index throws.
  `const arr: Array<number> = [1]; const x: number = arr[1.5];` →
  `UnsupportedError`.

- **N8** — a `usize` binding initialized with a fractional literal throws.
  `... const i: number = 1.5; const x: number = arr[i];` → `UnsupportedError`.

- **N9** — a binding used both as an index and as an operand with a fractional
  literal throws.
  `... const k: number = 0; const y: number = k * 1.5; const x: number = arr[k];`
  → `UnsupportedError`.

## Emission integration (cargo-free string)

- **N10** — end-to-end through `lower` + `emitModule`:
  `const arr: Array<number> = [1,2,3]; const i: number = 0; const x: number = arr[i];`
  emits `let i: usize = 0;` and `arr[i]` (never `arr[i as usize]`, never `0.0`
  for `i`'s init), with `x` still `f64`.

## Oracle — tier 1 (COMPILES)

- **F1** — a new fixture `04_data_structures/03_variable_index.ts` exercising
  variable indexing compiles (`cargo check` accepts the emitted Rust); added to
  `SUPPORTED` in `tests/compiler.test.ts`.
