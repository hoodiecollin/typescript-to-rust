# 073 — `finally` + an escaping jump (carrier-enum, the 063 committed follow-on)

> **Status: SHIPPED (2026-07-14).** Graduates 063's sole deferred residual, issue
> **#31** — a **committed** follow-on (Collin uses `try { return X } finally { F }`
> directly). Dialect call made with Collin 2026-07-10. Reserved **strictly** to the
> `finally`+escape combination; the 063 labeled block stays the path for everything
> else. Specs: `specs.md` → `packages/compiler/tests/value-yielding-try-finally.test.ts`.
>
> **Impl notes / deviations:**
> - **Per-carrier enum names** (`Ctrl_<label>`, `BreakTarget_<label>`) instead of a
>   bare `Ctrl` — nested carriers each declare their own local enum in the same fn
>   body, so distinct names avoid the shadow/collision (a nested dispatch that
>   re-records into the *outer* carrier references the outer's `Ctrl_<outerLabel>`).
> - **`Return` vs `Err` variants gated separately.** `Return` is emitted when a
>   `return` escapes; `Err` **only** when an error can escape the whole construct — a
>   carrier-level `throw`/`?` in a *fallible* scope. A `catch` that fully handles the
>   error leaves the fn non-fallible, so no `Err` variant / `return Err(..)` arm (that
>   arm would not type-check against a plain return type).
> - **No `V`-threading.** The `Return(V)` payload type comes from the enclosing fn's
>   return annotation via `analysis.fns.get(scope).retAnn` → `lowerType` (a scope with
>   no return annotation is fail-loud — the carrier can't name `V`).
> - **Nesting** rewrites the inner carrier's *dispatch* (not its arms) to re-record
>   into the outer via an `outerLabel` field — `F1` then `F2` run inner→outer, verified
>   by CN1.
> - `divergesFully`/`diverges` learned that a `carrierTry` diverges when its dispatch
>   always escapes (`dispatchDead || !tryFallsThrough`), so a nested carrier that always
>   returns elides the outer `Ctrl::Normal` arm (else the fn tail mis-types).
>
> Spec-first: this `design.md` → RED `specs.md` → impl → archive.

## Problem

063 lowers `try`/`catch`/`finally` to a Rust **labeled block** (`'try: { … }`) + `match`.
Native `return`/`break`/`continue` inside `try`/`catch` "just work" there — a labeled block
is not a function boundary — **except** when a `finally` is also present. A native escape
would jump straight out, **skipping the trailing `finally`**, but JS runs `finally` on that
path. So 063 fails loud on exactly that combination:

- `lower.ts:1746` — `try`/`finally` (no catch) whose body escapes → `UnsupportedError`.
- `lower.ts:1778` — `try`/`catch` where either arm escapes **and** a `finally` is present.

Both guards call `escapesClosure()` (`lower.ts:2046`), which already walks the arms for
`return`/`break`/`continue`. #31 replaces these two throws with the carrier lowering.

## Decision — carrier enum, self-escaping `finally` accepted

Lower **only** the `finally`+escape construct to a control carrier. Each escape in the
`try`/`catch` arms is rewritten to record its intent in the carrier and break out to a
wrapper block; the `finally` body runs; then a dispatch site **replays** the recorded escape.
Everything else (value-yield, escapes without `finally`, `finally` without an escape,
`try`/`finally`-no-handler) stays on 063's labeled block — the carrier **never** widens the
general try/catch surface.

**Self-escaping `finally` is supported** (decided 2026-07-10): the `finally` body is emitted
**natively, before the dispatch**, so a `return`/`break`/`continue`/`throw` *inside* `finally`
executes first and **pre-empts** the replayed carrier — which is exactly JS semantics
(`try { return 1 } finally { return 2 }` → `2`; `finally { throw E }` masks the pending
action). No special handling is needed for the override; it falls out of ordering. When the
`finally` body **unconditionally** escapes, the dispatch is dead code → suppress it via the
existing `diverges()` check.

## Mechanism

### The carrier

A **concrete, per-construct** enum (V = the enclosing fn's return inner type, E = the program
error type — both known at emit; **no generics required**), emitted as a local item:

```rust
enum Ctrl { Normal(V), Return(V), Err(E), Break(BreakTarget), Continue(BreakTarget) }
```

`BreakTarget` is a small generated enum with **one variant per distinct break/continue target**
among the escapes (a named loop label, or the implicit nearest-enclosing loop for an unlabeled
jump). For the dominant `return`+`finally` case (Collin's use) **no** `Break`/`Continue`
variants and **no** `BreakTarget` are generated — the carrier is just `Normal | Return | Err`.

### Lowering

1. **Route** — when `escapesClosure()` is true **and** a `finallyBody` is present, produce a
   new HIR node (`carrierTry`, or `tryBlock` extended with a `carrier` target-set) instead of
   throwing. Collect the set of escape targets for `BreakTarget`.
2. **Rewrite arms** — in `try` (and `catch`), each escape becomes a carrier record + break to
   the wrapper label:
   - `return v` → `break 'ctrl Ctrl::Return(v)`
   - `break L` / `continue L` → `break 'ctrl Ctrl::Break(BreakTarget::L)` / `…::Continue(…)`
   - `throw e` / fallible `?`-error → `break 'ctrl Ctrl::Err(e)` (reuse `rewriteTryBreaks`)
   - normal completion → `Ctrl::Normal(v)` (statement-level: `Normal(())`).
   With a `catch`, the inner `'try:` block yields `Result`; its `match` maps `Ok`/`Err` arms
   into `Ctrl::…`, and escapes **inside `catch`** are carrier-encoded the same way.
3. **Emit F natively** — the `finally` statements, once, after the wrapper block, before the
   dispatch. Self-escape pre-empts (above).
4. **Dispatch** — replay:
   ```rust
   let __ctrl: Ctrl = 'ctrl: { /* try; catch-match; escapes → break 'ctrl Ctrl::X */ };
   F;                       // finally, native, once
   match __ctrl {
       Ctrl::Return(v)    => return v,           // Ok-wrapped iff fallible (below)
       Ctrl::Err(e)       => return Err(e),
       Ctrl::Break(t)     => match t { BreakTarget::L => break 'L, … },
       Ctrl::Continue(t)  => match t { BreakTarget::L => continue 'L, … },
       Ctrl::Normal(v)    => v,                  // value-yield / fall-through
   }
   ```

### Reuse

- **Escape detection** — `escapesClosure()` (`lower.ts:2046`), unchanged.
- **`throw`→break** — `rewriteTryBreaks()` (`lower.ts:1858`), retargeted to the carrier.
- **Ok-wrapping** — `Return(v)`/`Normal(v)` dispatch wraps in `Ok` **iff `analysis.fallible.has(scope)`**
  (the exact condition 063 uses at `lower.ts:1787`); reuse `wrapReturns` semantics at the
  dispatch arm rather than inside the block.
- **Labels** — plain-string scheme (`'ctrl_N`, existing loop labels); `loopLabel()` emit.
- **Dead dispatch** — `diverges()` to omit the `match` when `F` always escapes.

### Nesting

`try { try { return 1 } finally { F1 } } finally { F2 }` — each `finally`+escape gets its own
carrier with a distinct wrapper label (`'ctrl_1`, `'ctrl_2`). The inner dispatch's replayed
`return 1` sits inside the **outer** `try`, so the outer lowering carrier-encodes it in turn →
F1 then F2 run in the correct inner-to-outer order.

## Fail-loud residuals

- **`break`/`continue` targeting a label that itself sits *inside* the `try`** — degenerate;
  same boundary 063 notes. (The target must be an enclosing loop, not one nested in `try`.)
- Everything 013/021 already reject downstream (non-`Error` throw values, etc.) — unchanged.
- The carrier is **opt-in for finally+escape only**; no other try/catch shape is affected.

## Impl sequence

1. Replace the two `escapesClosure` throws (`lower.ts:1746`, `:1778`) with routing to the
   carrier node when a `finallyBody` is present; collect the `BreakTarget` set.
2. Arm rewrite: escapes → `break 'ctrl Ctrl::X(..)`; normal → `Ctrl::Normal`; `catch` arm
   mapping; retarget `rewriteTryBreaks` to the carrier.
3. Emit: local concrete `Ctrl` (+ `BreakTarget`) enum; wrapper block; native `finally`;
   dispatch `match` with Ok-wrapping on `Return`/`Normal` per `fallible`; `diverges(F)`
   dead-dispatch suppression.
4. Nesting: distinct wrapper labels; verify inner→outer `finally` order.
5. RED `specs.md` → GREEN (differential — every finally-ordering path).

## Specs sketch

- `try { return f(n) } finally { F }` — F runs, then returns; both ok and throwing input
  differential-match (F observed exactly once, before the return).
- `outer: for(...) { try { continue outer } finally { F } }` — F runs, then `continue 'outer`.
- `try { break L } finally { F }` (labeled + unlabeled variants) — F then the jump.
- `try { throw E } catch(e) { return 1 } finally { F }` — catch runs, F runs, then returns 1.
- `try`/`finally` no catch, body throws — F runs, then the error propagates (`Ctrl::Err`).
- **Self-escaping finally:** `try { return 1 } finally { return 2 }` → `2`;
  `try { return 1 } finally { throw E }` → throws `E` (pending return masked) — both
  differential-match JS.
- **Nested:** `try { try { return 1 } finally { F1 } } finally { F2 }` → F1 then F2, returns 1.
- Regression: a `finally` *without* an escape, and an escape *without* a `finally`, still take
  063's labeled-block path (byte-for-byte unchanged).

## Open sub-details (impl, not dialect forks)

- **Carrier node**: a dedicated `carrierTry` HIR node vs. extending `tryBlock` with a
  `carrier`/target-set field (the 063 `tryBlock` doc currently asserts `finallyBody` only
  appears without an escape — pick one and update that invariant).
- **`Ctrl` placement**: a local `enum` item inside the fn body (concrete V/E — recommended)
  vs. a generic `tslib::Ctrl<V,E>` (the `BreakTarget` per-fn discriminant argues against a
  shared generic).
- **`BreakTarget` representation** — a generated enum vs. small integer discriminants; only
  built when break/continue escapes exist.
- **Return-only fast path** — whether to special-case `try { return X } finally { F }` (no
  `Break`/`Continue`) to the leanest `Normal | Return | Err` carrier automatically (it already
  falls out of "generate variants only for targets present").
- **F duplication** — none: the carrier runs `F` once at the dispatch site (an improvement
  over 063's no-catch arm duplication).
