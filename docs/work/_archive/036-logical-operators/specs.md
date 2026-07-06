# 036 specs — logical operators `&&` / `||`

Transcribed as BDD tests in `packages/compiler/tests/logical.test.ts`
(differential: emitted Rust compiles **and** its stdout matches the Bun-run TS).

1. **`&&` and `||` behave.** `a && b` → `false`, `a || b` → `true` (a=true, b=false).
2. **`&&` binds tighter than `||`** — `a && b || c` (false, false, true) → `true`,
   matching JS `(a&&b)||c`.
3. **Explicit parens override precedence and are preserved** — `(a || b) && c`
   emits `(a || b) && c` and evaluates to `false` (a=false, b=true, c=false).
4. **Composes with comparisons without needless parens** — `x > 0 && x < 5`
   emits `x > 0.0 && x < 5.0` → `true` (x=3).
5. **Short-circuit is preserved in a guard** — `if (a || b) …` takes the branch.
6. **`??` is fail-loud** (`UnsupportedError`) — nullish coalescing needs `Option`.

All 6 green; full suite 351 pass / 1 todo / 0 fail at landing.
