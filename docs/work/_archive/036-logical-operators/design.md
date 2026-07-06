# 036 — Logical operators `&&` / `||` (`LogicalExpression`)

> **Status: LANDED.** Closes a common fail-loud gap surfaced while re-checking the
> 026 rewrite trigger (task #22): `&&`/`||`/`??` were entirely unimplemented
> (`LogicalExpression` was an unmodeled node → `UnsupportedError`). Specs:
> `packages/compiler/tests/logical.test.ts`.

## Scope

- **`&&` / `||`** → Rust's short-circuit `&&` / `||`. In ESTree these are a
  `LogicalExpression` (distinct from `BinaryExpression`), but they lower to the
  same `binary` HIR node, so the emitter renders and parenthesizes them through
  the existing path.
- **`??`** (nullish coalescing) → **fail-loud** (`UnsupportedError`). It needs
  `Option` semantics the dialect doesn't model (a bare `null` is already
  fail-loud), so guessing a target would be unsound. Left for a future
  Option/nullable series.

## Mechanism

- **Validator** — `LogicalExpression` added to `MODELED` (it was default-denied).
- **Lowering (`lowerExpr`)** — a `LogicalExpression` with `&&`/`||` becomes
  `{ kind: "binary", op }`; `??` (or any other logical op) throws
  `UnsupportedError`.
- **Emitter precedence** — two new `BINARY_PREC` rows: `&&` = 1, `||` = 0, placing
  them below comparison/equality (`==`/`!=` = 2) and with `&&` above `||`, exactly
  as Rust binds them. `||` at 0 coincides with the atomic fallback, which is
  harmless — every emitted binary op is in the table. The existing `emitOperand`
  left/right-associativity logic then handles all nesting:
  - `a && b || c` → `a && b || c` (no parens; `&&` binds tighter)
  - `(a || b) && c` → `(a || b) && c` (source parens preserved via precedence)
  - `x > 0 && x < 5` → `x > 0.0 && x < 5.0` (comparisons bind tighter — no parens)

No new HIR node or emitter expr kind — it rides entirely on `binary` + the 026
precedence table.

## Why this over the 026-full rewrite

Task #22 (the speculative rust-ast + printer rewrite) had **no triggering
defect** — the string emitter renders every supported precedence case correctly.
This slice is the higher-value use of the same effort: a real, common
dialect-surface gap, closed with a differential-verified change touching only
`validate`/`lower`/`emitter`. The 026 rewrite stays deferred by design.

## Deferred

- `??` nullish coalescing (needs `Option`/nullable modeling).
- Bitwise `&`/`|`/`^` (a `BinaryExpression`, orthogonal; not requested).
