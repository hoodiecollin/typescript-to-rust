# 048 — Lambda lifting: callback bodies → named pure `fn`s + `fn`-pointers

Graduates the dialect's value-position-closure deferral (#9) — the boundary
`015-arrow-functions` and `033-value-position-closures` both stop at. Per the
**revised** decision (`_pending-decisions.md` §#9, 2026-07-07), closures are **not**
the mapping destination. Captures are the entire source of difficulty, so we
eliminate them by **closure conversion (lambda lifting)**: every callback body is
lifted to a top-level pure `fn` whose former free variables become explicit
parameters, and function *values* map to `fn`-pointers. **No capture-analysis pass,
no `Fn`/`FnMut`/`FnOnce` inference, no `Box<dyn Fn>`, no closure lifetimes** — those
are deleted from scope, not built.

## The reframe

`015` already lambda-lifts one shape: a top-level `const f = (…) => …` is rewritten
to a free `fn f` by `normalizeArrows` / `arrowToFunctionDecl` *before* analysis, so
it needs no capture reasoning. This series generalizes that precedent to **callback
arrows** and **function values**.

Today `033`/`039` lower a callback arrow to an *inline* Rust closure: `iterMap` /
`iterFilter` / `iterFind` / `iterReduce` / `iterAny` / `iterAll` / `iterSortBy` HIR
nodes carry `{ receiver, param, body }` and the emitter renders `|&x| body`
(`emitter.ts`). Capture "falls out of Rust's closure capture" — which quietly works
only for Copy free vars and breaks the moment a capture is non-trivial. We replace
that inline body with a lifted named `fn` + a trivial forwarding shim.

## Mechanism 1 — callback body → a named pure `fn`

Each callback arrow's body is lifted to a top-level `fn`. Its parameters are the
arrow's own parameter(s) **followed by** its free variables (the outer bindings the
body reads), in a deterministic order. A named callback (`xs.map(f)` where `f` is a
top-level fn / normalized-arrow) forwards to that fn directly; an **anonymous** arrow
gets a synthesized, hoisted name `__cb_<method>_<n>` (`__cb_map_1`, `__cb_filter_2`,
…) from a per-module counter.

```ts
const bump = 10;
xs.map(x => x + bump);
```
```rust
fn __cb_map_1(x: f64, bump: f64) -> f64 { x + bump }
// … at the call site, see Mechanism 2:
xs.iter().map(|x| __cb_map_1(*x, bump)).collect::<Vec<_>>()
```

New HIR: a **lifted-fn item** (a `HirFn`-shaped top-level, reusing the existing fn
item + emitter path) plus the adapter nodes change from `{ …, param, body }` to
`{ …, cbName, elemParam, forwarded }` — the callback's name and the list of
free-variable HIR exprs to forward. The lifted fn is registered so it prints among
the module's top-level items (like a normalized arrow).

## Mechanism 2 — the iterator-adapter boundary forces a shim

Rust's `.map`/`.filter`/`.fold`/`.any`/`.all`/`.find` are typed `F: FnMut(Item) ->
…`; they cannot receive a bare **multi-argument** `fn` (its arity ≠ the adapter's).
So the lifted fn cannot be passed directly. We emit **one** trivial auto-generated
shim closure that forwards the element plus the read-only free vars:

| adapter | emitted shim |
|---|---|
| `xs.map(cb)` | `xs.iter().map(\|x\| __cb(*x, free…)).collect::<Vec<_>>()` |
| `xs.filter(cb)` | `xs.iter().filter(\|x\| __cb(**x, free…)).copied().collect::<Vec<_>>()` |
| `xs.find(cb)` | `xs.iter().find(\|x\| __cb(**x, free…)).copied()` |
| `xs.some/every(cb)` | `xs.iter().any/all(\|x\| __cb(*x, free…))` |
| `xs.reduce(cb, init)` | `xs.iter().fold(init, \|acc, x\| __cb(acc, *x, free…))` |
| `xs.forEach(cb)` | `for &x in xs.iter() { __cb(x, free…); }` |

The `*x` / `**x` deref is exactly the `|&x|` vs `|&&x|` distinction the current
emitter already encodes (`.iter()` yields `&T`; a predicate receives `&&T`). This
shim is the **only** closure the pipeline ever emits, and its captures are always the
trivial read-only-by-copy kind Rust handles with zero analysis.

## The read-only-scalar-forwarding rule

A free variable is forwardable iff it is **read** (never assigned) in the callback
body and is **Copy** (a scalar — `f64`/`usize`/`i64`/`bool`, or a `&T` read-only
borrow). It is passed **by value/copy** into the lifted fn's params. This keeps
`map(x => x + bump)` ergonomic (Collin's explicit call): forwarding read-only outer
scalars is allowed. A free var that is *assigned* in the body (a stateful/mutable
capture) is **not** forwardable → fail-loud (see residuals). The read/write
classification is a local walk of the callback body, not a whole-program pass.

## Mechanism 3 — function *values* → `fn`-pointers

An arrow/fn used as a **value** (a parameter, a stored field, a returned value)
lowers to a Rust `fn`-pointer `fn(T) -> U`. Only a **non-capturing** top-level fn or
normalized arrow qualifies — those coerce to a `fn` pointer with zero cost and no
generics in the signature.

```ts
function apply(f: (n: number) => number, x: number): number { return f(x); }
```
```rust
fn apply(f: fn(f64) -> f64, x: f64) -> f64 { f(x) }
```

New AST node `TSFunctionType` (`(x: T) => U`) — currently unmodeled (fail-loud
generic `Unsupported`) — is added to the `MODELED` allowlist (`validate.ts`) and
mapped by `lowerType` to a new `RustType` `{ kind: "fnPtr"; params; ret }` →
`fn(params…) -> ret`. Passing a bare fn name as a value (`apply(double, 3)`) lowers
to an `ident` referencing the top-level fn (coerces to the pointer). This lifts the
`015` deferral: an arrow in argument position that is a non-capturing top-level
reference is now accepted; a *capturing* one is fail-loud (the user lifts it to a
named fn taking the data as explicit args).

## Hoisting & naming

Lifted fns are collected during lowering and emitted as module top-level items:
the user's items in source order, with each anonymous callback's lifted fn hoisted
to module scope under its `__cb_<method>_<n>` name. Names are drawn from a per-module
counter so they are
stable and collision-free; the `__cb_` prefix cannot collide with a user identifier
(leading double-underscore is reserved by the emitter's hygiene, same as `__o`).

## Slices (each lands green)

1. **048a — lift anonymous callback bodies + shim.** Convert `iterMap`/`iterFilter`
   and `forEach` from inline `|&x| body` to a lifted `__cb_*` fn + forwarding shim;
   no free vars yet (element-only bodies). Pure refactor of the emitted shape,
   behavior-identical, cargo-green.
2. **048b — read-only scalar forwarding.** Detect read-only Copy free vars, append
   them to the lifted fn's params, forward them in the shim. `map(x => x + bump)`.
   Extend to `reduce`/`some`/`every`/`find`/`sort`.
3. **048c — `fn`-pointer values.** `TSFunctionType` annotation → `fnPtr`; a
   non-capturing top-level fn/arrow passed as an argument or returned. `apply`.

## Decision 2026-07-08 — forEach is not lifted; mutable capture kept

Two conflicts with shipped behavior surfaced at impl time and were resolved with
Collin:

1. **`forEach` keeps its shipped for-loop lowering** (`tryForEach` →
   `for &x in xs.iter() { … }`). It is a *statement* form and is already
   effectively "lifted" to a loop, which naturally handles a **mutable-capture**
   accumulator (`forEach(x => { total = total + x })`, a green 027-cl test).
   Lifting it to a `__cb_foreach` fn would *regress* that, so forEach is excluded
   from lifting. Only the **expression-bodied** adapters (map/filter/find/some/
   every/reduce/sort) lift — their accepted body shape (expression or single
   `return`) cannot mutate an outer binding, so the mutable-capture question does
   not arise for them.
2. **The lifted fns need explicit Rust types**, which the inline `|&x| body` path
   never computed. A **bounded expression typer** (this series) types the shipped
   numeric surface: element param → the receiver's element type (`f64` for the
   numeric-array surface, resolved via a binding→type map); free-var scalars →
   their binding type (Copy only); body → `f64` for arithmetic, `bool` for
   comparison/logical, `reduce` acc → the init type. Anything the typer cannot
   type fails loud — the same "numeric arrays first" boundary as 033/039.

## Fail-loud residuals (the honest boundary)

- **Stateful / mutable-capture callback** — a closure counter, `xs.forEach(x =>
  { total += x })`, `onClick(() => this.x++)`. The free var is *assigned*, so it is
  not forwardable-by-copy. → `UnsupportedError` "mutable capture in a callback (lift
  to a named fn taking the state as an explicit param)".
- **A capturing function value** — an arrow passed/stored/returned that reads an
  outer local. It has no `fn`-pointer form. → fail-loud; the user lifts it.
- **A runtime-selected function value** that isn't a nameable top-level fn (`const f
  = cond ? a : b; f(x)`) — no single `fn` to point at. → fail-loud.
- **Non-Copy element forwarding** stays where `033` left it (numeric arrays first);
  a `String` element needs the shim to `.clone()`/borrow — that is **#11**, a
  downstream series, not this one.
- **Forwarded free-var type = pre-refinement type.** The lifted fn's free-var
  params are typed from `bindingTypes`, which is built *before* `refineNumerics`,
  so a forwarded scalar is `f64`. A free var that the numeric pass would later
  refine to `usize`/`i64` (e.g. it is also used as an array index elsewhere) and
  is *then* forwarded into a callback would mismatch the `f64` param. No shipped
  case hits this (forwarded scalars — `bump`/`factor`/`seed` — are never indices);
  if it ever arises it is fail-loud at the cargo oracle, and the fix is to type the
  lifted fn after refinement. Recorded so it is not mistaken for coverage.

## Knock-on (downstream, not this series' scope)

- **#11 (non-Copy inline)** collapses to "the shim borrows/clones the element" — it
  reuses this series' shim, no capture pass.
- **#12 (`let`-bound arrow)** becomes a non-capturing `fn`-pointer binding — it
  reuses Mechanism 3, no capture pass.
</content>
