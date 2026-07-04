# 019 — Integer counters, part 1: `switch` → literal-pattern `match`

## Problem

A `switch (x)` over a `number` lowers (series 009) to a **guarded-wildcard**
`match`:

```rust
match x {
    _ if x == 1.0 => { return "one".to_string(); }
    _ if x == 2.0 => { return "two".to_string(); }
    _ => { return "other".to_string(); }
}
```

This is a deliberate workaround: `x` is `f64` (every `number` defaults to `f64`),
and Rust forbids `f64` literal patterns (`1.0 => …` is a hard error), so the case
value is compared inside a guard on a wildcard arm. The output compiles and
behaves, but it is not idiomatic — a `switch` on integers is exactly what Rust's
literal-pattern `match` is *for*:

```rust
match x {
    1 => { return "one".to_string(); }
    2 => { return "two".to_string(); }
    _ => { return "other".to_string(); }
}
```

The blocker is purely the discriminant's type. Rust *does* allow integer literal
patterns, so if `x` were an integer type the idiomatic form compiles. This slice
is the first half of the deferred **integer-counter** work: introduce a signed
integer type (`i64`) and infer it for a `switch` discriminant, unlocking
literal-pattern arms. (Part 2, series 020, uses integer counters for `for i in
a..b` ranges.)

## Approach (verified with `cargo`)

`fn match_num(x: i64) -> String { match x { 1 => …, 2 => …, _ => … } }` compiles
and behaves (probed: `one\ntwo\nother`). So the plan is to retype the
discriminant to `i64` and rewrite the arms.

`i64` is the faithful mapping for a signed integer (TypeScript's `number` is
signed; a discriminant may later be compared to or derived from negative values),
in contrast to `usize`, which numeric inference reserves for array-index/length
contexts. Where both would apply to one binding (a discriminant that is *also* an
array index), `usize` — the *forced* requirement — wins; literal patterns work on
`usize` too, so the promotion still fires.

### Preferring, not forcing

Crucially, unlike `usize` inference (indexing **requires** `usize`, so a conflict
is a hard `UnsupportedError`), integer-`match` promotion is a **preference with a
valid fallback**: the existing guarded-wildcard `f64` `match` is always correct.
So the pass never fails loud here — it promotes only when it is confident, and
otherwise leaves the series-009 form untouched. A discriminant used fractionally
(an operand of a fractional literal, or of `/` — where `i64` division would
silently truncate and change behaviour) is **not** promoted.

### Where it runs

A new **`promoteMatches`** step in `numeric.ts`, run *after* the `usize` fixpoint
and `applyTypes` (so `usize`-forced discriminants are already known). For each
lowered `switch` (a `match` whose non-wildcard arms are all `disc == <literal>`
guards):

1. the discriminant must be a bare identifier `D`;
2. every non-wildcard arm's guard must be `D == <integer literal>`;
3. `D` must be *integer-safe* in this scope — never an operand alongside a
   fractional literal, never an operand of `/`, never assigned a fractional
   value. (`usize.has(D)` already implies integer-safe.)

When eligible: retype `D`'s `let`/param to `i64` (unless it is already `usize`),
and rewrite each guarded arm to a **literal-pattern** arm (`pat = <literal>`,
tagged `i64`/`usize` so it emits bare), clearing the guard. The wildcard/default
arm is unchanged.

## HIR / emitter changes

- `RustType` gains `{ kind: "i64" }`; `NumericType` gains `"i64"`.
- The emitter renders `i64`, and an `i64`-tagged number literal bare (like
  `usize`) — no `.0` suffix.
- `HirMatchArm` gains an optional `pat?: HirExpr`. When present the emitter
  renders `<pat> => { … }` (a literal pattern); otherwise the existing
  guarded/wildcard arm (`_ if <guard>` / `_`).

Lowering is unchanged — `lowerSwitch` still produces guarded-wildcard arms; the
promotion is a post-lowering HIR→HIR refinement, mirroring the other numeric
work. The emitter stays pure and total (a new arm shape, an exhaustive match).

## Deferred (each its own future series)

- **Negative / non-literal case values** (`case -1:`, `case K:`) — negatives need
  unary minus (not yet in the dialect); non-literal cases can't be patterns.
- **Or-patterns** (`case 1: case 2:` fall-through → `1 | 2 => …`) — stacked cases
  are still rejected (series 009's no-fall-through rule).
- **String literal patterns** (`switch (s)` → `match s.as_str() { "a" => … }`) —
  a discriminant-as-`&str` refinement, orthogonal to integers.
- **Range patterns / binding patterns** (`1..=5 =>`, `n @ …`).
