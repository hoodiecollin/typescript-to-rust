# 018 — Control flow: unblock `continue` in a C-style `for`

## Problem

A C-style `for (init; test; update) body` lowers to a scope-containing `while`
(`lowerFor`, series 006/009): `{ init; while (test) { …body; update; } }`. A
`continue` in the body would jump to the `while` condition and **skip** the
appended `update` — a semantic change from the `for`, which always runs `update`
before re-testing. Series 009 therefore rejected an *own* `continue` fail-loud
(`"continue inside a C-style for (unsound while-desugar — deferred)"`). This slice
lifts that restriction — one of the last fail-loud gaps in otherwise-complete
control flow.

The obvious fix (a labeled block `'step: { … }` with `continue` → `break 'step`)
does **not** work cleanly: an unlabeled `break` that diverges through a labeled
block is a hard error (E0695), so a for-`break` in the body would also need a
label, dragging labels into the HIR and emitter. There is a simpler, label-free,
sound desugar.

## Approach (verified with `cargo`)

Rewrite each **own** `continue` in the body into `{ update; continue; }` — the
`update` runs *before* the `continue`, so the loop variable still advances:

```rust
// for (let i = 0; i < 6; i = i + 1) { if (i === 3) break; if (i === 1) continue; sum += i; }
{
    let mut i: f64 = 0.0;
    while i < 6.0 {
        if i == 3.0 { break; }                 // for-break: bare break exits the while ✓
        if i == 1.0 { i = i + 1.0; continue; } // for-continue: update inlined, THEN continue ✓
        sum = sum + i;
        i = i + 1.0;                           // update at the loop bottom (normal path)
    }
}
```

`break` is unchanged — a bare `break` exits the `while`, exactly as the `for`
would. Each iteration runs `update` exactly once (either via a `continue` path or
the bottom). Verified: this behaves identically to the TS (`sum = 2`), including a
mixed `break`+`continue` and a nested inner loop whose own `continue` is left
alone.

## Scope (decided 2026-07-03)

**In:** `continue` inside a C-style `for`.

- **Own `continue` → `{ update; continue; }`.** When the `for` body contains a
  `continue` that targets *this* loop (not one inside a nested loop — the existing
  `hasOwnContinue` barrier) and the `for` has an `update`, each such `continue` is
  rewritten in the lowered body to a `block` `[update, continue]`. The `update`
  node is lowered once and shared across every rewrite site.
- **A `for` with no `update`** — `continue` is already sound (nothing to skip), so
  it is simply allowed (no rewrite). This also widens the old rejection, which
  fired even when there was no `update`.
- **`break` unchanged** — a bare `break` exits the `while` (correct for-semantics);
  no rewrite, no labels.
- **Barrier** — only own `continue`s are rewritten; a nested `while`/`for`/`for…of`
  owns its own `continue` and is not descended into (matches `hasOwnContinue` and
  the numeric pass's loop handling).

**Deferred — own later series (documented, still fail-loud or unchanged):**

- **Idiomatic `for i in a..b` ranges** — entangled with **integer-counter numeric
  inference**: a Rust range counter is a `usize`/integer (it must impl `Step`),
  but our counters default to `f64`, and a `usize` counter cannot mix with the
  `f64` body arithmetic that the common counting loop performs (`total = total +
  i` → `f64 + usize`, verified to not compile). The range form needs the deferred
  `i64`/`usize` counter work first; until then the sound `while`-desugar stands.
- **Downward / non-unit-step loops** (`i--`, `i += 2`) — ranges need `.rev()` /
  `.step_by()`; the `while`-desugar already handles them, unaffected by this slice.
- **Labeled `break`/`continue`** — still unsupported (`lowerStatement` rejects a
  labeled jump); the label-free desugar here sidesteps labels entirely.

## Design

No AST, HIR, or emitter **shape** change — this is a `lower.ts` refinement in
`lowerFor` plus one helper:

- `lowerFor` lowers the `update` once into an optional `updateStmt`. When
  `hasOwnContinue(stmt.body)` **and** an `updateStmt` exists, it rewrites the
  lowered body with `inlineUpdateBeforeContinue(body, updateStmt)` instead of
  throwing. The `updateStmt` is still appended at the loop bottom for the normal
  path.
- `inlineUpdateBeforeContinue(stmts, update)` maps the HIR statements, replacing
  each own `continue` with `{ kind: "block", body: [update, { kind: "continue" }] }`.
  It descends through `if`/`block`/`match` (transparent to `continue`) but stops
  at a nested `while`/`forIn` (a barrier — that loop owns its `continue`). A nested
  C-style `for` is itself a `block` containing a `while`, so its inner `continue`s
  sit under the barrier and are untouched.

## Limits (documented, not silently handled)

- **The `update` is duplicated at each `continue` site.** Sound (each iteration
  runs it once) and a small code-size cost; the shared HIR node is never mutated.
- **Only the `while`-desugar shape** — this does not make the output an idiomatic
  Rust range; that awaits integer-counter inference (above).

## Verification

- **Unit (cargo-free):** `tests/for-continue.test.ts` drives `emit(…)` — an own
  `continue` emits the `update` before it, so `i = i + 1;` appears at both the
  continue site and the bottom (FORCONT1), a `break` stays a bare `break`
  (FORCONT2), a `for` without a `continue` is unchanged — one `update` (FORCONT3,
  green control), and a `for` with no `update` but a `continue` no longer throws
  (FORCONT4).
- **Oracle (cargo-backed):** two tier-2 differentials in `compiler.test.ts` — a
  mixed `break`+`continue` counting loop (→ `2`), and a nested `for`/`for` where
  both loops have their own `continue` (→ `26`, validating the barrier through the
  real compiler) — assert Rust stdout equals the TypeScript's.

## Workflow note

No scaffold commit: no HIR/emitter/AST shape is added, and `lowerFor`'s existing
own-`continue` rejection already *is* the fail-loud seam the specs are RED against.
Flow: docs → **RED** → **GREEN** (`inlineUpdateBeforeContinue`) → archive.
Idiomatic ranges (with integer-counter inference), downward/step loops, and
labeled jumps each remain their own series.
