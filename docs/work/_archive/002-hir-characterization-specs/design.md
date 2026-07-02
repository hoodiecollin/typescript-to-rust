# 002 — HIR characterization specs (backfill)

**Type:** test backfill for pre-rule code. Honestly **GREEN-from-start**, not
RED-first — the impl (`lower.ts`, `emitter.ts`) already exists and works, so a
truly-failing spec is impossible. This closes a coverage gap; it is not the full
spec-first workflow (that begins cleanly with the next feature, numeric
inference).

## Problem

The HIR layer is exercised only transitively through `tests/compiler.test.ts`,
which runs all the way to `cargo` (slow) and asserts *compiles*, not *HIR shape*
or *exact emitted string*. `analysis.ts` has real unit tests; `lower.ts` and
`emitter.ts` have none. A regression in lowering or emission that still happens
to compile would pass unnoticed.

## Change

Add two fast, cargo-free unit test files that pin the two halves of the HIR
pipeline directly:

- `tests/lower.test.ts` — AST → HIR. Parses TS, asserts the resulting HIR
  structure: borrow forms folded into param types, `mut` baked onto `let`,
  call-arg borrows, resolved `RustType`s, node kinds (`println`/`len`/`index`),
  the item/main split, and the `UnsupportedError` gates.
- `tests/emitter.test.ts` — HIR → string. Constructs HIR literals directly
  (the emitter is pure/total, so no parser needed) and asserts exact Rust output:
  integer `.0`, literal index as bare `usize`, `&`/`&mut` type rendering,
  `println!` format string, unit-return elision, `async fn`.

## Verification

Both files GREEN on first run; full suite stays green. See `specs.md` for the
enumerated behaviors each test pins.
