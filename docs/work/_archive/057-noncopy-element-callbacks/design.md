# 057 — Non-Copy element callbacks + index param

> **Status: SHIPPED (2026-07-09).** Graduates the fail-loud deferral in issue #11.
> Builds directly on `048-lambda-lifting-closures` (lifted `fn` + shim; **no capture
> pass**). Dialect-shape decisions made with Collin 2026-07-09; the index-type
> decision was revised to `f64` at impl (see below). Specs:
> `packages/compiler/tests/noncopy-callbacks.test.ts`.
>
> **Impl deviations from the draft:** (1) the index forwards as `i as f64`, not
> `usize` (rationale below). (2) The consuming classifier ships the identity/return
> and by-value-argument shapes; a struct-literal-wrapped consume
> (`s => ({ wrapped: s })`) needs object-literal-return typing and stays fail-loud
> (unresolved). (3) Non-Copy element borrowing is wired for
> `map`/`filter`/`find`/`some`/`every`; a non-Copy `reduce`/`sort` element stays
> fail-loud (its two-param comparator/fold element isn't classified yet).

## The problem

`033`/`048` made array callbacks (`map`/`filter`/`reduce`/`find`/`some`/`every`/
`sort`) work by lifting the arrow body to a named pure `fn`, forwarding read-only
**Copy** free vars. Two deferrals remain:

1. **Non-Copy *element* types.** `.iter()` yields `&String` / `&Struct`; a lifted fn
   can't take a non-Copy element by value the way it takes an `f64`. We must decide
   how the shim hands the element to the fn.
2. **The `(el, i, arr)` extra params.** JS callbacks may take the index and the whole
   array. The index maps to `.enumerate()`; the array param is rare and forces a
   second borrow of `xs` mid-iteration.

Neither is a *capture* problem (048 deleted that) — both are **data-passing
conventions at the shim boundary**.

## Decision

- **Element passing: infer borrow-vs-clone per callback body (Option C).** A
  **local** read/consume walk of the one callback body decides:
  - element param **only read** → lifted fn takes `&str` (for `String`) / `&T` (for a
    struct); shim forwards the `&T` from `.iter()` — **no clone**.
  - element param **consumed** (returned, moved into a struct/collection, passed
    by-value to an owning fn, assigned to an owned slot) → lifted fn takes owned
    `String` / `T`; shim passes `s.clone()`.
  - **cannot classify** (element flows somewhere the local walk can't resolve) →
    **fail-loud** (honest; no silent clone).
  This is a bounded, single-body analysis — *not* the whole-program capture /
  `Fn`/`FnMut`/`FnOnce` inference 048 deliberately deleted.
- **Extra params: index only, via `.enumerate()`.** `(el, i)` supported; the
  whole-array third param → **fail-loud**.
  - **Index type — decided `f64` at impl (2026-07-09), revising the drafted
    `usize`.** `number` is uniformly `f64` across the dialect and JS's callback
    index *is* a number, so the shim forwards `i as f64`. This keeps the index on
    the f64 numeric surface: arithmetic bodies (`x + i`) work and the result binds
    to `Array<number>`. `usize` was tried first and rejected — it clashes with the
    f64 literals in the body and the `f64` map result (`Vec<usize>` ≠ `Vec<f64>`),
    admitting only a bare `(x, i) => i`. The `.enumerate()` yields `usize`; the
    `as f64` cast lives in the shim.

### Why Option C over borrow-only

Borrow-only (the drafted recommendation) rejects consuming bodies (`x => x`,
`x => ({ wrapped: x })`) outright. Collin chose to accept them via a per-body clone
decision so the common consuming shapes work, at the cost of a local read/consume
walk. The walk stays *local* (one body, no cross-call propagation), which keeps it
far from the machinery 048 removed.

## Mechanism

### Local read/consume classifier

Walk the callback body once, tracking the element parameter binding `s`:

- **Read-only** if every use is: a method call whose receiver is `&self`
  (`s.length`, `s.toUpperCase()`, `s.charAt(_)`), a field read (`s.x`), a
  comparison/arithmetic operand producing a *new* value, or forwarded by-ref.
- **Consumed** if `s` is: the body's returned value, an element of a returned
  struct-literal / array, a by-value argument to a fn/ctor that owns its param, or
  the RHS of an assignment into an owned binding.
- **Unresolved** → fail-loud with a message pointing at the ambiguous use.

The classifier reuses the existing HIR expression walk (`eachExpr`) and the method
receiver-mutability knowledge already used elsewhere (`analysis.ts` /
`ownership.ts`).

### Shim + lifted fn (extends 048)

| body classification | lifted fn param | shim (map) |
|---|---|---|
| read-only `String` | `s: &str` | `xs.iter().map(\|s\| __cb(s))` |
| read-only struct `T` | `s: &T` | `xs.iter().map(\|s\| __cb(s))` |
| consumed `String`/`T` | `s: String` / `s: T` | `xs.iter().map(\|s\| __cb(s.clone()))` |

`filter`/`find` predicates receive `&&T`, so the borrow case forwards `s` and the
clone case forwards `(*s).clone()` — the same `*`/`**` deref bookkeeping 048's
emitter already encodes. `String` read-only params normalize to `&str` via the
existing `strings.ts` refinement.

### Index param → `.enumerate()`

`(el, i)` → `xs.iter().enumerate().map(|(i, x)| __cb(<elem>, i, free…))`, with
`i: usize` appended to the lifted fn's params *before* the forwarded free vars. The
element passing (`<elem>`) follows the borrow/clone decision above.

### Element-type + body-return typing

The 048 bounded expression typer extends beyond the numeric surface: the element
type is resolved from the receiver's element type (`Vec<String>` → `String`,
`Vec<T>` → `T` via the binding→type map), and body-return typing must cover the
String/struct method results the body uses. **This leans on the library-method
catalog (issue #29 / series 029)** for `String`/struct method return types; where a
method's return type is unknown to the typer, the body fails loud (same "typed
surface first" boundary as 033/048).

## Fail-loud residuals

- **Whole-array (`arr`) callback param** — rare; forces a second borrow of `xs` and
  muddies the pure-fn shape. → `UnsupportedError`.
- **Unclassifiable element flow** — the local walk can't prove read-only or a clean
  consume. → `UnsupportedError` (no silent clone).
- **Body using a method the typer can't type** — deferred to the 029 catalog.
- **Mutable capture** — unchanged from 048 (still fail-loud).

## Impl sequence

1. Element-type resolution for non-numeric arrays in the lifted-fn typer.
2. Local read/consume classifier for the element param.
3. Shim emit: borrow vs `.clone()` per classification, incl. `filter`/`find` deref.
4. `.enumerate()` path for the index param (`i: usize`).
5. Body-return typing for the String/struct methods in scope (coordinate with 029).
6. RED specs → GREEN.

## Specs sketch

- Read-only: `strs.map(s => s.length)` → `&str` param, no clone; differential-match.
- Consumed: `strs.map(s => s + "!")` / `s => ({ v: s })` → owned param + `.clone()`.
- `filter`: `strs.filter(s => s.length > 2)` — `&&T` deref, borrow.
- Index: `xs.map((el, i) => …)` → `.enumerate()`, `i: usize`.
- Struct elements: `pts.map(p => p.x)` (read-only `&Point`).
- Fail-loud: `(el, i, arr)` third param; an unclassifiable consuming flow.

## Open sub-details (impl, not dialect forks)

- Exact consume-vs-read rule for a method whose receiver ownership the catalog marks
  as by-value (`into_*`) — treat as consume.
- Whether `sort`'s comparator (two element params) reuses the same classifier per
  param.
