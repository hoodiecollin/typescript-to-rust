# 058 — Arrow binding deferrals (`let`/`var`, multi-declarator, destructuring)

> **Status: DESIGN (decided, awaiting impl).** Graduates the fail-loud deferral in
> issue #12. Builds on `015-arrow-functions` (`normalizeArrows`) and
> `048-lambda-lifting-closures` (Mechanism 3, fn-pointers). Dialect-shape decisions
> made with Collin 2026-07-09.

## The problem

`normalizeArrows` (`lower.ts:285`) promotes only a **single-declarator, top-level
`const`** arrow to a free `fn`; `topLevelConstArrow` (`lower.ts:334`) bails on
everything else. After `054` (which shipped **top-level `const` async arrows** and an
async-aware callback lift), the genuinely remaining deferrals are:

1. **`let`/`var`-bound arrows** — a *reassignable* callable binding (top-level or
   local).
2. **Multiple declarators** — `const f = …, g = …` (the `declarations.length !== 1`
   bail).
3. **Destructuring / rest params** — `({x, y}) => …`, `(...args) => …`.

All **non-capturing** — a capturing arrow stays fail-loud (048), unchanged.

## Decision

- **Binding form (Fork 1): lift to the nearest enclosing scope as a nested `fn`
  item + a `fn`-pointer binding.** A `let`/`var`/local-`const` arrow becomes a named
  `fn` placed in the *same block* as its declaration, and the binding holds a
  pointer to it. Reassignment works via `let mut f: fn(..)->.. = __arrow_1; f =
  __arrow_2;` (a `fn`-pointer is a `Copy` value). Nested `fn` items **cannot
  capture** — which is exactly the non-capturing constraint already enforced, so
  this needs no capture pass.
- **Graduate now (Fork 2): multiple declarators + destructuring params.**
- **Defer: rest params** — no Rust variadics; `(...args: number[])` must become a
  slice/`Vec` param, a call-site-convention change that gets its **own** series.

### Why nearest-scope over top-level

Rust allows nested `fn` items, and placing the lifted fn in the declaring block
keeps it beside its use (locality/readability) instead of floating to module scope.
048 hoisted to top-level only because its callbacks are lifted from deep in an
*expression* (an iterator chain) with no obvious statement list to return to; a
`let`-bound arrow is *already* at statement position, so block placement is natural.
Top-level `let`/`var` arrows land at module scope anyway (their nearest scope *is*
the module), so the rule is uniform: **lift to the nearest enclosing scope.**

## Mechanism

### Binding lift

- Extend the arrow-normalization surface (currently `topLevelConstArrow`) to a
  general **arrow-bound-declarator** recognizer: any `const`/`let`/`var` declarator
  whose init is a non-capturing `ArrowFunctionExpression`, at any scope.
- Emit a nested `fn __arrow_n` (per-module `__arrow_` counter, hygienic `__`
  prefix) into the block that contains the declaration; bind `let [mut] f:
  fn(P…)->R = __arrow_n;`. `mut` is added iff the binding is reassigned later in
  scope (a local reassignment walk, same shape as existing mutability detection).
- Types for the nested fn reuse the 048 bounded expression typer (params from
  annotations/inference, return from the body). An arrow whose param/return types
  can't be resolved → fail-loud (same boundary as 048).
- **Async:** a `let`-bound `async` arrow lifts to a nested `async fn` (nested async
  items are legal) and binds a matching pointer. Async-callback-**in-adapter** stays
  deferred to 051b, unchanged from 054.
- Capturing arrow → **fail-loud** (unchanged); the user lifts it to a named fn
  taking the data as explicit params.

### Multiple declarators

`const f = a, g = b;` normalizes **per declarator**: each arrow-bound declarator
lifts independently; non-arrow declarators lower as today. A mixed statement splits
cleanly into per-binding lowering.

### Destructuring params

`({x, y}: Point) => …` → the nested fn takes a Rust struct pattern param:
`fn __arrow_n(Point { x, y }: Point) -> …`. Requires the param to have a **named
struct type** (e.g. `Point`) so there is a pattern to name; a destructured
**anonymous** object-type param → fail-loud (no nameable struct). Array/tuple
destructuring params follow the same "named, statically-shaped only" rule; anything
else fails loud.

## Fail-loud residuals

- **Rest params** (`(...args) => …`) — deferred to its own slice-convention series.
- **Capturing arrow** — unchanged (048).
- **Destructuring an anonymous object-type param** — no named struct to pattern.
- **Un-typeable arrow** (params/return the bounded typer can't resolve) — 048
  boundary.

## Impl sequence

1. Generalize the declarator recognizer (const/let/var, any scope) + nearest-block
   placement of the nested `fn` item.
2. `mut`/reassignment detection for the binding.
3. Per-declarator handling for multiple declarators.
4. Destructuring param → struct-pattern param (named-struct-only).
5. Async nested-fn binding (reuse 054 async lift typing).
6. RED specs → GREEN.

## Specs sketch

- `let f = x => x + 1; f(2);` → nested fn + fn-ptr binding; differential-match.
- Reassignment: `let mut op = add; op = sub; op(1,2);`.
- Multiple declarators: `const f = x => x+1, g = x => x*2;`.
- Destructuring: `const dist = ({x, y}: Point) => x*x + y*y;`.
- Local (nested-scope) arrow inside a fn body stays in that block.
- Async: `let load = async () => 1; await load();`.
- Fail-loud: rest param; capturing arrow; anonymous-object destructured param.

## Open sub-details (impl, not dialect forks)

- Whether the `__arrow_` counter is shared with 048's `__cb_` pool or separate.
- Exact reassignment-detection reuse from the existing local mutability walk.
