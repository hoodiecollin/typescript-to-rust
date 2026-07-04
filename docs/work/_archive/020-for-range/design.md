# 020 — Integer counters, part 2: idiomatic `for i in a..b` ranges

## Problem

A C-style counting `for` lowers (series 006/018) to a scope-containing `while`:

```rust
// for (let i = 0; i < arr.length; i = i + 1) { console.log(arr[i]); }
{
    let mut i: usize = 0;
    while i < arr.len() {
        println!("{}", arr[i]);
        i = i + 1;
    }
}
```

When the counter drives an index (`arr[i]`), numeric inference already types it
`usize`. The while-desugar is correct but not idiomatic — the canonical Rust form
is a range:

```rust
for i in 0..arr.len() {
    println!("{}", arr[i]);
}
```

The earlier deferral note ("a `usize` range counter can't mix with `f64` body
arithmetic") is about the *accumulator* loop (`total = total + i`, where `i`
would have to be `f64`). That case genuinely can't be a range and stays a
`while`. But the **index-driven** counting loop — where the counter is already
`usize` because it indexes — promotes cleanly, and needs **no** new type
inference: the counter is `usize` either way. The promotion is purely
*structural*.

## Approach (verified with `cargo`)

Probed and behaving: `for i in 0..arr.len()` (usize), `for i in 0..5` with a
`break` in the body, and `for i in 0..=5` (inclusive). A **`promoteRanges`** pass
in `numeric.ts`, run after `applyTypes` (so the counter's `usize`-ness is known),
recursively rewrites the desugared shape into a new `forRange` HIR node.

### Eligibility (the canonical counting loop)

A `block` statement whose body is exactly `[let, while]` where:

1. the `let` is `let mut <i> = <start>` (single counter binding);
2. the `while` condition is `<i> < <end>` or `<i> <= <end>` (counter on the left);
3. the `while` body's **last** statement is the appended update `<i> = <i> + 1`,
   and no other statement assigns `<i>`;
4. the body contains **no own `continue`** (a `continue` targeting this loop);
5. the counter `<i>` is `usize` (`usize.has(i)` — i.e. it is index-driven);
6. `<end>` is integer-compatible: a `.length`/`.len()`, an integer literal, or a
   `usize` binding.

is rewritten to `forRange { counter: i, start, end, inclusive, body }` where
`body` is the while body **without** the trailing update, and `inclusive` is set
for `<=` (`..=`). The `let` and the update are folded into the range. Any
integer-literal `start`/`end` is tagged `usize` so it emits bare (`0..3`, not
`0.0..3.0`).

### Why no own-`continue`

In a native `for` range the counter advances automatically, so a body `continue`
is already correct — but series 018's while-desugar rewrote each own `continue`
into `{ update; continue; }`. Reversing that rewrite to recover a clean body is
fragile, so this slice **only promotes loops with no own `continue`** (`break` is
fine — it exits the range exactly as it exits the `while`). A counting loop with a
`continue` keeps the correct 018 while-desugar. Native `continue`-in-range is a
documented follow-up.

### Why it stays sound

The counter type is unchanged (`usize` before and after) — the rewrite touches
only *structure*, never types, so it cannot introduce a numeric conflict. The
fallback for every non-eligible loop is the existing, correct while-desugar. The
accumulator loop (`total = total + i`, `i` is `f64`) fails eligibility at step 5
and stays a `while`.

## HIR / emitter changes

- `HirStmt` gains `{ kind: "forRange"; counter; start; end; inclusive; body }`.
- The emitter renders `for <counter> in <start>..<end> { … }` (or `..=` when
  `inclusive`). `break`/`continue` inside render natively.

Lowering (`lowerFor`) is unchanged — it still produces the `block`+`while`
desugar (including the 018 continue-inlining for non-promoted loops); the range
is recovered as a post-lowering refinement, so the emitter stays pure and total.

## Deferred (each its own future series)

- **Own `continue` in a range** — reverse the 018 inlining and use native
  `continue` (auto-advance).
- **`i64`/bound-driven ranges** — `for (let i = 0; i < n; i++)` where the counter
  is *not* index-driven needs an `i64` counter and an `i64` bound `n`; retyping
  the `n` param crosses a call boundary (deferred with the broader integer-counter
  inference).
- **Non-unit / downward steps** (`i += 2`, `i = i - 1`) → `.step_by(…)` /
  `.rev()`.
- **`for…of` over a range**, ranges as first-class values.
