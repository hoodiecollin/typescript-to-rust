# 064 — Control-flow refinements — specs

Differential-oracle BDD specs (compile → cargo run → match TS-via-Bun), each also
pinning the refined **emitted shape**. Every refinement is behaviour-preserving over
its prior correct lowering — only the emitted form changes. Test IDs map to
`packages/compiler/tests/control-flow-refinements.test.ts`.

Dialect note: loop updates are written `i = i + 1` (`++`/`--` are out of dialect);
arrays are `Array<T>`; `number` is `f64`.

## Switch or-patterns, string scrutinee, range arms (#1, #2)

- **CF1 — or-pattern.** `case 1: case 2: return "low"` → `1 | 2 => …` (an integer
  fn-parameter discriminant promotes to literal patterns).
- **CF2 — range-literal arm.** A contiguous run `case 1: … case 5:` → `1..=5 => …`.
- **CF3 — string scrutinee.** `switch (s)` on a `string` param → `match s { "r" =>
  …, _ => … }` (the read-only param is `&str`, matched directly — no `.as_str()`,
  no guard).
- **CF4 — string or-pattern.** `case "a": case "e": case "i":` → `"a" | "e" | "i" =>`.

## Native `continue` in a range-`for` (#3)

- **CF5.** `for (let i = 0; i < xs.length; i = i + 1) { if (…) continue; … }` promotes
  to `for i in 0..xs.len() { … continue; … }` — the desugar's inlined counter
  update is stripped (the range advances natively).

## Descending / step ranges (#4)

- **CF6 — descending.** `for (let i = 2; i > 0; i = i - 1)` → `(1..=2).rev()`.
- **CF7 — descending inclusive.** `i >= 0` → `(0..=2).rev()`.
- **CF8 — non-unit step.** `i = i + 2` → `(0..=6).step_by(2)`.

## for-of element ownership + destructuring (#5)

- **CF9 — mutate in place.** `for (const p of pts) { p.x = … }` → `for p in &mut
  pts`, and `pts` is marked `let mut`.
- **CF10 — destructuring.** `for (const { x, y } of pts)` → `for Point { x, y } in
  pts.iter()` (a named-struct pattern; borrow).
- **CF11 — read-only unchanged.** A read-only body still borrows `for p in
  pts.iter()` — no `&mut`, no clone.

## Labeled `break` / `continue` (#6)

- **CF12 — labeled break.** `outer: for … { for … { break outer; } }` → `'outer: …
  break 'outer;`.
- **CF13 — labeled continue.** `continue outer` → `continue 'outer;`, correctly
  advancing the outer loop (the desugar inlines the outer update before it).

## Fail-loud residuals (unchanged — no new fail-loud)

- A non-linear counter update (`i = i * 2`), a non-unit *descending* step, or a
  non-`usize` bound-driven counter stays a correct `while` (not a range).
- A for-of body that **consumes** its element (moves it out) stays the current
  by-reference lowering; the owned / `xs.iter().cloned()` graduation needs liveness
  of `xs` after the loop and is deferred (a follow-up).
- for-of destructuring of an **anonymous** (non-named-struct) element → fail-loud,
  the same boundary as 058's destructuring params.
- JS fall-through into a **non-empty** case (not the empty stacked-case fold) stays
  fail-loud.
