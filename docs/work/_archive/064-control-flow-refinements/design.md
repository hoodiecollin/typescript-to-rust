# 064 — Control-flow refinements (or-patterns, literal/range arms, ranges, for-of, labels)

> **Status: DESIGN (decided, awaiting impl).** Graduates the deferral in issue #24.
> Refines lowerings already shipped and **correct** in 006–009, 018–020 — these are
> idiomatic-emit / legibility improvements, **not** blockers. Decision made with
> Collin 2026-07-09. Sequenced **after 057** (shares its borrow/clone/consume
> classifier for for-of ownership).

## No dialect fork

Every item below has an obvious idiomatic Rust target and a *correct* fallback
already in place. Nothing new goes fail-loud: where a shape is too general to
canonicalize, it stays a correct `while` loop / duplicated `match` arm. The only
real decision was **scope + canonicalization aggressiveness**, which affects the
`.rs`-legibility goal.

## Decision

**One bundled series, aggressive canonicalization** (Option A). Canonicalize *every*
analyzable C-style `for` into a range iterator; reuse **057's** per-body
borrow/clone/consume classifier for for-of element ownership; anything subtler stays
a correct `while`. Chosen over conservative (option B, leaves more `while` loops +
a divergent second for-of rule) and split-into-3 (option C, docs/archive overhead for
one coherent theme).

## The six refinements

### 1. Or-patterns (`switch` fallthrough)

Consecutive `case` labels that share a body collapse to a Rust or-pattern:
```ts
switch (n) { case 1: case 2: return "low"; default: return "hi"; }
```
```rust
match n { 1 | 2 => "low".to_string(), _ => "hi".to_string() }
```
Reuses 009/019's `switch`→`match` lowering; the new bit is folding consecutive
empty-body labels into one `a | b | c =>` arm.

### 2. String scrutinee + range-literal arms

- `switch (s)` on a `String` → `match s.as_str() { "a" => …, _ => … }` (borrow the
  scrutinee to compare against `&str` literals).
- Numeric range-literal arms → `1..=5 => …` (Rust range patterns). Non-contiguous
  sets stay or-patterns.

### 3. Native `continue` inside a range-`for` (018 residual)

`for (let i = 0; i < n; i++) { if (p) continue; … }` already lowers to `for i in
0..n`; `continue` is legal there — **stop rejecting it**. No structural change, just
drop the guard that forced these to a `while`.

### 4. Downward / non-unit-step / bound-driven `i64` ranges

Extend 020's ascending-unit-step canonicalization:
| TS | Rust |
|---|---|
| `for (let i = n; i > 0; i--)` | `for i in (1..=n).rev()` |
| `for (let i = 0; i <= n; i += 2)` | `for i in (0..=n).step_by(2)` |
| `for (let i = a; i < b; i++)` (`a,b` runtime `i64`) | `for i in a..b` |
Inclusive vs exclusive (`<` vs `<=`) and empty-range behavior are computed from the
comparison operator; a step that isn't a compile-time ±constant / ×constant, or a
non-linear update (`i *= 2`), stays a **`while`** (correct, less idiomatic).

### 5. for-of element ergonomics (owned / `&mut` / destructuring)

`for (const x of xs)` today borrows (`for x in &xs`). Graduate:
- **read-only element** → `for x in &xs` (unchanged).
- **element mutated back into the collection** → `for x in &mut xs`.
- **element consumed** → owned iteration. **Caveat:** JS leaves `xs` usable after the
  loop, so plain `for x in xs` (which *consumes* `xs`) is only valid when `xs` is
  **dead after the loop** (liveness, already available); otherwise iterate
  `xs.iter().cloned()` / `.clone()` per element — the same borrow/clone/consume call
  **057** makes for callback elements. **Reuse 057's classifier**, do not invent a
  second rule.
- **destructuring** → `for Point { x, y } in &pts { … }` (named-struct pattern, same
  "named/statically-shaped only" boundary as 058's destructuring params).

### 6. Labeled / stacked `break` / `continue`

```ts
outer: for (…) { for (…) { if (p) break outer; if (q) continue outer; } }
```
```rust
'outer: for … { for … { if p { break 'outer; } if q { continue 'outer; } } }
```
Direct 1:1: each TS loop label → a Rust lifetime label; `break label`/`continue
label` → `break 'label`/`continue 'label`. Bare `break`/`continue` unchanged.

## Fail-loud residuals

- **None new.** Every un-canonicalizable shape degrades to a correct `while` /
  duplicated arm. The pre-existing loop/switch residuals (non-linear updates staying
  `while`, an unmodeled scrutinee type) are unchanged.
- for-of destructuring of an **anonymous** object element (no named struct to
  pattern) → same boundary as 058 (stays fail-loud there, not here).

## Impl sequence

1. Or-pattern folding for consecutive `switch` labels.
2. String scrutinee (`.as_str()`) + range-literal / or-pattern arms.
3. Drop the range-`for` `continue` rejection (018 residual).
4. Descending / step / bound-driven range canonicalization (extend 020); `while`
   fallback for non-linear updates.
5. for-of ownership via 057's classifier (`&` / `&mut` / owned-if-dead / clone) +
   destructuring patterns.
6. Labeled loops + `break '…`/`continue '…`.
7. RED specs → GREEN (differential; each refinement must match its current correct
   lowering behaviorally, only the emitted form changes).

## Specs sketch

- `case 1: case 2: →` `1 | 2 =>`; string `switch` → `match s.as_str()`.
- `continue` inside `for i in 0..n`.
- Descending loop → `(1..=n).rev()`; step-2 → `.step_by(2)`; runtime-bound `a..b`.
- for-of: read → `&xs`; mutate-into → `&mut xs`; consume with `xs` dead → owned;
  consume with `xs` live-after → `.cloned()`; destructure `for {x,y} of pts`.
- Labeled `break outer` / `continue outer` across nested loops.
- Behavioral parity: each refined form differential-matches the prior `while`/arm form.

## Open sub-details (impl, not dialect forks)

- Exact 057-classifier reuse for the loop variable vs. the callback param (same
  analysis, different binding site — factor the classifier so both call it).
- `.rev()` on an inclusive vs. exclusive range — off-by-one table per comparison op.
- Whether a `switch` with mixed empty and non-empty fallthrough still folds cleanly
  or splits (JS fallthrough into a non-empty case is already its own boundary).
