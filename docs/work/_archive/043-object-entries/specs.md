# 043 — specs

Differential specs in `packages/compiler/tests/object-entries.test.ts`.

## 043a — for-of destructuring
- **ENT1** `for (const [k, v] of Object.entries(m))` prints each pair in insertion
  order; emitted iterates `m.iter()` with a `(k, v)` pattern.
- **ENT2** the loop body can use `k` and `v` (concatenation / arithmetic).
- **ENT3** a stored entries binding drives the same destructuring
  (`const es = Object.entries(m); for (const [k, v] of es) …`).

## 043b — stored + indexed
- **ENT4** `const es = Object.entries(m)` → `Vec<(String, V)>`; `es[0][0]`/`es[0][1]`
  → tuple `.0`/`.1`; `es.length` → `.len()`.
- **ENT5** the emitted entries value is the `.iter().map(...).collect()` chain.

## Fail-loud
- **ENT6** a plain array-destructuring binding `const [a, b] = xs` is fail-loud.
- **ENT7** a pair index other than `[0]`/`[1]` (`es[0][2]`) does not become a
  tuple field (falls through to normal indexing / cargo-loud).
