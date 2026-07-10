# 067 — Binding destructuring (exact-arity `const {x,y}=` / `const [a,b]=`)

> **Status: DESIGN COMPLETE (2026-07-10). Impl pending.** Graduates the 008 residual,
> issue **#34**. Dialect calls made with Collin 2026-07-10 (`needs-user-input`
> cleared). Blocks **#39** (generator array-destructuring is a special case).
>
> Spec-first: this `design.md` → mock → RED `specs.md` → impl → archive.

## Problem

General variable-declarator destructuring is fail-loud (`lower.ts:4111`/`4136`,
`"destructuring binding"`). Only four narrow forms are modeled: `for (const [k,v] of
…)` (043), named-struct `for (const {x,y} of …)` (064), destructuring **params**
`({x,y}: Point)` (058), and the `join!` tuple `let (a,b) = …` (051a). Plain bindings
like `const {x,y} = point` and `const [a,b] = pair()` throw.

## Scope — exact-arity only (decided 2026-07-10)

Graduate the shapes that **can never produce a missing element**, so they need no
`undefined` model:

1. **Object-pattern over a named struct** — `const { x, y } = point` (`point`'s type
   is a declared struct/class; every field is present by type). Mirrors 058/064.
2. **Array-pattern over a fixed-arity tuple** — `const [a, b] = pairFn()` where the
   source lowers to a Rust tuple `(T, U)`. Mirrors 051a. **Includes the generator
   case** `const [a, b] = g()` when `g` yields a fixed tuple (unblocks #39).

**Deferred:**
- **Array-pattern over a `Vec`/`Array`** (`const [a,b] = arr`) — runtime length, so an
  out-of-bounds slot is `undefined`. **Blocked on #42 / series 066** (the `undefined`
  model). Not part of this series.
- **Rest** `[a, ...rest]` / `{ x, ...rest }` — deferred rest machinery; revisit after
  the exact-arity forms land.

## Decision — ownership is liveness-driven

The destructured **source**'s ownership is chosen by backward liveness (already
available from `ownership.ts`), matching JS observable behavior at minimum cost:

| Source after the destructure | Lowering | Rationale |
| --- | --- | --- |
| dead / a temporary (`= makePoint()`, `= g()`) | `let Point { x, y } = point;` — **move** | zero-cost; source unused |
| live + `Copy` fields | `let Point { x, y } = point;` — Copy, source stays valid | JS: source still usable |
| live + non-`Copy` | `let Point { x, y } = point.clone();` — clone the source | keep source usable, JS-faithful |

Element/field **types come from the source's known struct/tuple type** — no annotation
is needed (unlike a plain binding, which requires one). Names bind in declaration
order (tuple) / by field name (struct).

## Mechanism

- **`lowerVarDecl`** (`lower.ts:4098`): today the `ArrayPattern` branch accepts only a
  `join!` tuple init (`isJoinTuple`) and everything else throws; the non-`Identifier`
  branch throws `"destructuring binding"`. Extend:
  - **ArrayPattern + fixed-arity tuple source** → reuse the existing `names` field on
    the HIR `let` node (already used for `let (a,b) = …`): `pat = "(a, b)"`, one `let`
    binding carrying `names = [a, b]`. The source must lower to a tuple expr (a
    tuple-returning fn, a generator yielding a tuple, a `[literal, literal]` of fixed
    arity typed as a tuple). A `Vec`-typed source → fail-loud (deferred, points at #42).
  - **ObjectPattern + named-struct source** → emit a Rust struct-pattern binding
    `let Point { x, y } = <source>;`. **Reuse `destructureForOfPattern`** (064), which
    already builds a struct pattern for `for (const {x,y} of …)`; lift it to a plain
    binding. Shorthand fields only (`{ x, y }`), same as 064; a renamed/nested/defaulted
    field is fail-loud.
- **HIR** — the struct-pattern binding needs a `let` variant carrying a Rust *pattern*
  string (not just a name). Either extend `names`/`pat` to carry the struct pattern, or
  add a `pat`-string field to the `let` node; the emitter renders `let <pat> = <init>;`.
- **Ownership** — a new lookup on the source binding's post-destructure liveness selects
  move vs Copy vs `.clone()` per the table. Reuse `ownership.ts` liveness; the `.clone()`
  insertion mirrors the 038 move-out pass.

## Fail-loud residuals

- **Array-pattern over a `Vec`/`Array`** — deferred to #42/066 (`undefined`).
- **Rest elements** `[a, ...rest]` / `{ x, ...rest }`.
- **Nested patterns** (`const { a: { b } } = …`), **renamed** (`{ x: y }`),
  **defaulted** (`{ x = 5 }` — rides #42), **computed** keys.
- **Object-pattern over a non-named-struct** (anonymous/index-typed) source.
- **Non-single declarator arity mismatch** — a pattern whose arity doesn't match the
  source tuple/struct.

## Impl sequence

1. ArrayPattern-over-tuple in `lowerVarDecl` (reuse `names`); `Vec` source → fail-loud.
2. ObjectPattern-over-named-struct (lift `destructureForOfPattern` to plain bindings);
   HIR `let` carries the struct pattern; emitter renders it.
3. Liveness-driven move/Copy/clone selection on the source.
4. RED `specs.md` → GREEN (differential; move/clone cases match JS, source-reuse works).

## Specs sketch

- `const { x, y } = point; console.log(x, y)` — struct pattern, source dead → move.
- `const { x, y } = p; use(p)` — source live → Copy/clone, `p` still usable.
- `const [a, b] = pairFn()` (tuple return) → `let (a, b) = …`.
- `const [a, b] = g()` (generator yielding a tuple) → tuple move (unblocks #39).
- `const [a, b] = arr` (Vec) → `UnsupportedError` pointing at #42.
- `const { x, ...rest } = p` → `UnsupportedError` (rest deferred).

## Open sub-details (impl, not dialect forks)

- Exact HIR shape for a struct-pattern `let` (extend `names` vs a new `pat` field).
- Whether a `[a, b]` **array literal** typed as a fixed tuple is accepted as a source,
  or only tuple-returning calls/generators.
- Interaction with the numeric pass (a destructured `f64` field used as an index).
