# 063 — Value-yielding `try`/`catch` + control-flow escape (labeled-block lowering)

> **Status: DESIGN (decided, awaiting impl).** Graduates the fail-loud deferral in
> issue #16. Rebuilds on 013 (throw→`Err`, fallible `Result<T,String>`, `?`) and
> **021** (statement-level recovery via an IIFE closure). Dialect decision made with
> Collin 2026-07-09.

## The problem

021 lowers `try { B } catch (e) { H } finally { F }` to an **immediately-invoked
closure** returning `Result`: `B`'s fallible calls `?`-propagate *to the closure*,
`catch` → `if let Err(e) = closure() { H }`, `finally` → statements after it. That
closure is a **function boundary**, so 021 rejects (fail-loud):

- `return` / `break` / `continue` inside `try`/`catch` — they'd escape the *closure*,
  not the enclosing fn/loop.
- `try`/`finally` with **no** `catch` — the error must propagate but `finally` must
  still run first.
- re-`throw` in `catch` **with** a `finally` — the rethrow would skip the trailing
  `finally`.

The headline deferral — a `try`/`catch` that **computes the function's return
value** — is the same problem: the natural way to yield that value is `return X`
*inside the arms*, which the closure swallows. Value-yield and control-flow-escape
out of `try` are one problem, not two.

## Decision

**Lower `try` to a Rust labeled block (drop the closure); defer only the
`finally`-combined-with-an-escape combination.**

- `try { B }` → a labeled block `'try: { … }` (a **value-producing block**, *not* a
  function boundary). Only `throw` / fallible-`?` is rewritten to `break 'try
  Err(e)`; the block yields `Ok(v)`. `catch` → a `match` on the block's `Result`,
  **both arms yielding the value**, so `let r = <try/catch>` and a value-yielding
  `return` both work.
- **Native `return` / `break 'outer` / `continue`** inside `try`/`catch` now Just
  Work — a labeled block is not a function boundary, so they escape to the enclosing
  fn/loop with correct semantics. The common `try { return f() } catch { return
  g() }` shape compiles.
- Idiomatic + human-legible emit (labeled block + `match`), no synthetic
  closure/enum — serves the readability goal.

> Collin chose **"B now, A-style finally later"**: ship the labeled-block lowering
> now with `finally`+escape fail-loud; then build the carrier-enum (Option A) as a
> **committed follow-on** — not "if it comes up." Collin uses `try { return X }
> finally { F }` (and the `break`/`continue` variants) directly, so the finally+escape
> combination **will** be handled. The one hard constraint: the verbose carrier-enum
> is **reserved strictly for the finally+escape case(s)** — the labeled-block lowering
> stays the path for *everything else* (value-yield, escapes without `finally`,
> `finally` without an escape). We do **not** widen the whole try/catch surface to the
> synthetic enum; it is opt-in for exactly the shape that provably needs it, so the
> common cases keep their idiomatic, legible emit.

### Sequencing: the two increments

1. **This series (063):** labeled-block lowering. Handles value-yield, native
   `return`/`break`/`continue` escape, `try`/`finally`-no-handler, rethrow-without-
   `finally`, and `finally` *without* an escape. `finally` + an escaping jump →
   `DialectError` (a **temporary** residual, not permanent).
2. **Committed follow-on (its own series):** the carrier-enum, scoped to *only* the
   `finally` + `return`/`break`/`continue` combination. A `try`/`catch`/`finally`
   whose `try` or `catch` contains an escaping jump lowers that one construct to the
   `Normal|Return(V)|Break(lbl)|Continue(lbl)|Err(E)` closure + dispatch-site replay,
   running `F` before replaying the escape. Everything else still goes through 063's
   labeled block. This graduates 063's sole residual to zero.

## Mechanism

### `try` → labeled block

```ts
function classify(n: number): string {
  try { return risky(n); }        // fallible
  catch (e) { return "recovered"; }
}
```
```rust
fn classify(n: f64) -> Result<String, String> {
    let __try: Result<String, String> = 'try: {
        let v = match risky(n) { Ok(v) => v, Err(e) => break 'try Err(e) };
        return Ok(v);              // native return — escapes the fn, not the block
    };
    match __try {
        Ok(v) => Ok(v),
        Err(e) => { return Ok("recovered".to_string()); }
    }
}
```

- Each fallible operation in `B` that used `?` (to the closure) becomes an explicit
  `match … { Err(e) => break 'try Err(e) }`. `throw` inside `try` → `break 'try
  Err(<constructed>)`.
- `return`/`break`/`continue` inside `B` or `H` **stay native** — emitted verbatim,
  escaping the enclosing fn/loop. This is the whole win over the closure.
- The block's fall-through / final expression yields `Ok(v)`.

### `catch (e) { H }`

`match __try { Ok(v) => <yield v>, Err(e) => { H' } }`. Both arms produce the same
value type when the try/catch is value-yielding; when it is statement-level (021's
shape), both arms are `()`. `e` binds the `String` payload (013's error model),
unchanged from 021.

### `finally { F }`

- **Without an escaping jump in `try`/`catch`** (021's shape, plus value-yield with
  no `return`/`break`/`continue`): `F'` statements are emitted after the `match`,
  running exactly once on both the normal and caught paths. Works.
- **`try`/`finally` with no `catch`** (graduated here): the labeled block yields
  `Result`; emit `F'` then re-propagate on the error path — `match __try { Ok(v) =>
  { F'; v }, Err(e) => { F'; return Err(e) } }` — so `finally` runs on *both* the
  normal and propagating paths before the error leaves. (`F'` is duplicated across
  arms, or hoisted to a local closure/block if large — an impl-detail.)
- **re-`throw` in `catch` without `finally`** — the catch's `throw` → `return
  Err(…)` (013), already fine; graduated as a supported combination.
- **`finally` COMBINED WITH a `return`/`break`/`continue` that escapes `try`/`catch`**
  — **fail-loud** (`DialectError`). A native escape skips the trailing `F'`
  statements, but JS runs `finally` on that path. Making it correct needs Option A's
  carrier-enum replay (run `F` at the dispatch site before replaying the escape);
  deferred to a follow-on series for this one combination.

## Fail-loud residuals

- **`finally` + an escaping `return`/`break`/`continue` out of `try`/`catch`** — the
  one **temporarily** deferred combination. **Committed** to the carrier-enum
  follow-on series (Collin uses this shape directly); *not* a permanent rejection.
  The carrier-enum is reserved to this combination only — it never widens the
  general try/catch lowering.
- **`break`/`continue` targeting a label that itself sits inside the `try`** — degenerate;
  same boundary.
- Everything 013/021 already reject downstream stays as-is (non-`Error` throw values,
  etc.).

## Impl sequence

1. Recognize value-yielding / escaping `try`/`catch` (a `return`/`break`/`continue`
   in either arm, or a bound/returned try/catch value) → route to labeled-block
   lowering instead of the 021 IIFE. (Keep the IIFE for the pure statement-level
   no-escape shape, or migrate it too for uniformity — impl call.)
2. Emit `'try:` labeled block; rewrite fallible ops + `throw` in `try` to `break 'try
   Err(…)`; leave `return`/`break`/`continue` native.
3. `catch` → `match` with both arms yielding; `e` binds `String`.
4. `finally`: after-`match` emission for the non-escape shape; no-handler
   run-then-propagate; rethrow-without-finally.
5. Guard: `finally` + escaping jump → `DialectError`.
6. RED specs → GREEN (differential — value, exception, and finally-ordering paths).

## Specs sketch

- `try { return f(n) } catch { return "x" }` → labeled block; both arms yield;
  differential-match on both the ok and throwing input.
- `let r = (() => { try { … } catch { … } })()`-style value binding.
- `try`/`finally` no handler: `finally` runs then the error propagates.
- `break`/`continue` inside `try` escaping an enclosing loop.
- Rethrow in `catch` (no `finally`) → `Err` propagates.
- Fail-loud: `try { return X } finally { F }` (escape + finally) → `DialectError`.

## Open sub-details (impl, not dialect forks)

- Whether to **migrate** the shipped 021 statement-level lowering to the labeled
  block too (uniformity, one code path) or keep the IIFE for the pure no-escape case.
- `finally` body duplication across `match` arms vs. hoisting `F'` into a local
  block/closure invoked on each path (watch: a closure re-introduces a boundary —
  prefer a plain inlined block or a `let`-bound `()` block).
- Nested `try` inside `try` — labeled blocks nest with distinct labels (`'try_1`,
  `'try_2`); the `break` targets the innermost.
