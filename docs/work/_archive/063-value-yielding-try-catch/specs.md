# 063 — specs (value-yielding `try`/`catch` + control-flow escape)

> **Status: SHIPPED.** Differential BDD specs live in
> `packages/compiler/tests/value-yielding-try.test.ts` (compile → cargo run →
> TS-via-Bun). IDs map 1:1 to the test names.

## Specs

- **VY1** `try { return f() } catch { return d }` yields the fn value via native
  `return` — lowered to `'try_0: { … }` with `break 'try_0 Err(…)` for `?`/`throw`.
- **VY2** the catch value flows through a native `return` (value-yield on both the
  ok and thrown inputs).
- **ESC1** `break` inside `try` escapes the enclosing loop (native, not swallowed).
- **ESC2** `continue` inside `try` advances the enclosing loop.
- **FIN1** `try`/`finally` with no `catch` runs `finally` on both paths, then
  propagates the error.
- **RETHROW** re-`throw` in `catch` (no `finally`) propagates as `Err`.
- **FL1** (fail-loud) `finally` combined with an escaping `return` is rejected (the
  carrier-enum follow-on).

Plus **ERR20** (in `error-from.test.ts`): a discriminating `instanceof`-ladder
catch with per-branch `return`s now lowers to a labeled block + native `match` over
the owned `AppError` (the #16 boundary, graduated).

## Mechanism

- The escaping / value-yielding `try`/`catch` (and `try`/`finally`-no-catch) → a
  Rust **labeled block** `'try_N: { … Ok(()) }` binding `Result<(), E>`; `?` →
  `match … Err => break 'try_N`, `throw` → `break 'try_N Err(…)`. Native
  `return`/`break`/`continue` in the arms escape the enclosing fn/loop.
- The `catch` is a `match` on the block result; when the `try` body always diverges
  (value-yield), the `Ok(_)` arm is `unreachable!()` so the `match` unifies to `!`
  and a value-yielding fn's tail type-checks.

## Fail-loud residuals

- **`finally` + an escaping `return`/`break`/`continue`** — the one temporarily
  deferred combination, committed to the carrier-enum follow-on series.
- **`try`/`finally`-no-catch in a non-fallible scope** (nothing to recover) and an
  escaping `try`/`catch` whose `try` cannot throw (non-fallible scope) — edge
  shapes, fail-loud.

## Impl notes

- The 021 IIFE-closure path is **kept** for the pure statement-level *no-escape*
  `try`/`catch` (not migrated — the labeled block is used only where an arm escapes
  or the fn value is yielded).
- Nested `try`s get distinct labels (`'try_0`, `'try_1`, …) via a counter.
