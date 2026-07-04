# 019 — Specs: `switch` → literal-pattern `match`

Drives the public `emit(...)` entry (parse → lower → refine → emit). Unit specs
pin the emitted shape; the cargo-backed COMPILES/BEHAVES proof lives in
`compiler.test.ts`. Spec file: `tests/integer-match.test.ts`.

RED against the existing guarded-wildcard behaviour: until `promoteMatches` lands,
an integer `switch` still emits `_ if x == 1.0 => …`, so the literal-pattern
assertions fail. IMATCH5/6 are green controls.

- **IMATCH1** — an integer `switch` retypes the discriminant param to `i64`.
  `function matchNum(x: number)` with integer cases → `fn matchNum(x: i64)`.

- **IMATCH2** — each integer `case` becomes a bare literal-pattern arm.
  Output contains `1 => {` and `2 => {`; it does **not** contain `_ if x == 1.0`.

- **IMATCH3** — `default` stays the wildcard arm (`_ => {`), emitted last.

- **IMATCH4** — a discriminant used fractionally is **not** promoted (fallback).
  `switch (x)` where the body also computes `x / 2` or compares `x === 1.5`
  keeps the guarded-wildcard `f64` form (`_ if x ==`), and `x` stays `f64`.

- **IMATCH5** (green control) — a `switch` over string-literal cases is untouched
  (still guarded-wildcard, discriminant not retyped to `i64`).

- **IMATCH6** (green control) — a discriminant that is *also* an array index is
  `usize`, and the match still promotes to literal patterns (`1 =>`), proving
  `usize` wins the type but literal patterns still fire.

## Differential (compiler.test.ts, cargo)

- An integer `switch` (`matchNum`, cases 1/2/default) compiles as `match x { 1 =>
  …, 2 => …, _ => … }` and prints `one\ntwo\nother` — identical to the TS run.
