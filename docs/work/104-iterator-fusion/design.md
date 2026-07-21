# 104 — Iterator chain fusion: fuse single-use map/filter/reduce

Epic **#89** (under perf epic **#86**). Motivated by `benchmarks/corpus/arraypipe.ts`
— steady-state **9.7ms vs Bun 4.3ms (0.4×)**, the last remaining steady-state loss
alongside `strbuild` (#88).

## Problem

An `xs.map(f).filter(g).reduce(h, 0)` chain lowers to three **separate** statements,
each an iter-adapter HIR node that bakes in its own `.iter() … .collect::<Vec<_>>()`:

```rust
let doubled = xs.iter().map(|v| __cb_map_1(*v)).collect::<Vec<_>>();          // ~500k Vec
let kept    = doubled.iter().filter(|v| __cb_filter_2(**v)).copied().collect::<Vec<_>>();  // ~400k Vec
let total   = kept.iter().fold(0.0, |a, b| __cb_reduce_3(a, *b));
```

Two throwaway `Vec`s are materialized (~900k elements of allocation + copy) purely to
hand each stage to the next. Bun's JIT fuses the chain into one pass; we don't.

The target is the idiomatic single lazy chain, which LLVM fuses into one
allocation-free loop:

```rust
let total = xs.iter().map(|v| __cb_map_1(*v)).filter(|v| __cb_filter_2(*v)).fold(0.0, |a, b| __cb_reduce_3(a, b));
```

## Ruling (Collin, 2026-07-21)

1. **Fusion gate: liveness-precise (aggressive).** `ownership.ts`'s `computeLiveOut`
   is the primary oracle. Fuse whenever the intermediate binding is **dead-out** after
   the consuming stage — not merely when it is textually single-use — and allow a
   **non-adjacent** consumer (statements may sit between producer and consumer).
2. **3c ships with 3a.** `into_iter()` when the chain's *source* is a dead-out local is
   the same `computeLiveOut` check applied to the chain head; land it in the same series.

Both relaxations bring mandatory soundness guards (below); when a guard can't be
discharged, the pass leaves the eager `collect()` form untouched — always a safe
fall-back.

## Core analysis: when is fusion sound?

Fusion is a **reordering-of-side-effects** transform. Eager form runs each stage to
completion (all maps, then all filters, then the fold); the lazy fused form interleaves
them per element (map x₀, filter x₀, fold; map x₁, …). Two conditions must hold, or the
chain is left eager — a third (callback purity) is **free by construction**:

- **G1 — intermediate not observed elsewhere.** Each fused intermediate binding
  (`doubled`, `kept`) must be referenced **exactly once** in the enclosing body — that
  one reference being the consumer's `receiver` — via a complete deep reference count
  (every `{kind:"ident"}` occurrence, over the whole statement subtree). The consumer
  need not be adjacent (the aggressive relaxation); non-adjacency is made safe by G3.

  *Ground-truth correction:* the plan was to reuse `ownership.ts`'s `computeLiveOut`
  (the "shared escape check"). On inspection its `collectUses` is **move-liveness** — it
  deliberately skips borrow-only uses (an `iterReduce`/`iterFind`/`iterAny`/`iterAll`
  receiver is a `.iter()` borrow, so it is *not* recorded), because it exists to place
  clones on moves. Using it for "is this value *read* later?" would **under-count**
  reads and could fuse an intermediate that is still observed → unsound. So G1 uses a
  complete reference count instead. (Name-shadowing only ever *inflates* the count, so
  the gate stays conservative/sound.) Full read-liveness precision — fusing when an
  intermediate is referenced more than once but dead on the fused path — is **deferred**;
  it needs a read-liveness pass the codebase doesn't have yet.
- **G3 — no source/capture mutation in the gap.** For a non-adjacent consumer, no
  statement between producer and consumer may write to the chain **source** or to any
  **forwarded free variable** the callbacks capture — lazy reads them at fold time, not
  at producer time, so a mutation in the gap would change the result (e.g. `const d =
  xs.map(f); xs.push(9); … d.reduce(…)`, or a captured `let k` reassigned in the gap).
  Scan the intervening statements for writes to {source root} ∪ {forwarded names}; any ⇒
  don't fuse. (Adjacent consumers trivially satisfy G3.)

- **G2 — callback purity — holds by construction (no code needed).** Fusion reorders
  *when* each stage's callback runs, so it is only sound if the callbacks are
  side-effect-free. They always are: the series-048 callback-lift surface (`typeCbBody`
  in `lower.ts`) accepts **only a bounded numeric expression** — literals, param/free-var
  idents, arithmetic/comparison/logical binary ops, unary `!`/`-`, and (flatMap) an
  array-literal of those. Any call, method, assignment, statement, or I/O is *already*
  fail-loud at lift time, and forwarded free vars are read-only Copy. So every liftable
  `__cb_*` is pure — a liftable-but-impure callback is not constructible, and fusion
  never needs to check. (The numeric-surface restriction **is** the purity guarantee.)

`computeLiveOut` handles loops/branches/nested blocks, so G1 is sound inside control
flow. G3 is a conservative local scan that falls back to eager on any doubt.

## The fusion pass — `refineIterFusion`

A new pure, idempotent HIR → HIR pass (`packages/compiler/src/iter-fusion.ts`), appended
to the refine chain (`refineBitwise → refineNumerics → refineStrings → refineIterFusion`).
Runs per function/method/main body, recursing into nested bodies. Per body:

1. Find a **producer**: `let NAME = <iterMap | iterFilter | iterFlatMap>` (the lazy,
   `Vec`-collecting adapters — the *intermediate* shapes).
2. Find its **consumer** in the same statement list: a later statement holding an
   iter-adapter (`iterMap`/`iterFilter`/`iterFlatMap`/`iterReduce`/`iterFind`/`iterAny`/
   `iterAll`) whose `receiver` is `{ident NAME}`. Require **G1** (refCount(body, NAME) ===
   1) and **G3** (no write to source/forwarded names in the gap). Bail if any fused stage
   carries an `indexParam` — its index would be miscounted once the chain is a single
   lazy pass (a conservative correctness guard).
3. Rewrite: set the producer node `lazy` (drop terminal `.collect()`) and the consumer
   `recvIter = "iter"` (drop `.iter()`, by-value element shim, drop `.copied()`); splice
   the producer node in as the consumer's `receiver`; **delete** the producer statement.
4. Fixpoint: a 3-stage chain fuses in two rounds (map+filter, then (map∘filter)+reduce).

**3c (into_iter):** scoped to *fused* chains only (to avoid re-lowering every `xs.map`
in the codebase). After fusion, a chain **head** is a producer node with `lazy===true`,
`recvIter` unset, and an ident receiver `SRC` that is a body-local `let`. If `SRC` is not
referenced in any top-level statement after the chain statement, set `recvIter = "own"`
(`into_iter()`, owned element). A lone unfused `map` has no `lazy` flag, so 3c never
touches it — its `.iter()` shape is unchanged.

## Emit change

Precedent already exists: `arrayFromMap` carries a `fromIterator` flag that toggles
exactly this ("a generator source is already an iterator by value — no `.iter()` / no
deref"). We add the analogous two bits to `iterMap`/`iterFilter`/`iterFlatMap` (and
`sourceIter` to the terminal `iterReduce`/`iterFind`/`iterAny`/`iterAll`):

- **`lazy?: boolean`** (intermediate adapters only) — when set, omit the trailing
  `.collect::<Vec<_>>()`; the node evaluates to an iterator.
- **`sourceIter?: boolean`** — when set, the `receiver` is already an iterator: omit
  `.iter()`, and the closure element is **by value** (`|p|`, `*p` in a `filter`
  predicate over owned `T`) rather than the `.iter()` deref shim (`**p`/`.copied()`).

The element-type threading (owned `T` after a `map`, vs `&T` from a collection's
`.iter()`) is the main implementation care-point; it mirrors the `fromIterator` branch
already shipped, and every spec is differential (cargo-compiled), so a wrong shim is a
hard COMPILE failure, not a silent bug.

`iterSortDefault`/`iterSortBy` are **not** fusable (sorting is not a lazy adapter); a
chain through a sort breaks into two fusion regions.

## Pipeline placement

Last in the refine chain — it consumes final adapter/element-mode shapes and only edits
statement lists + adapter nodes, so it must run after ownership/numeric/string refinement
has settled the element modes it reads.

## Impl plan (spec-first BDD slices)

1. **Mock + RED specs** — `packages/compiler/tests/iter-fusion.test.ts`, differential
   (`tests/_support/differential`), one scenario per `specs.md` row.
2. **G1/G3 analysis** — `iter-fusion.ts`: reuse `computeLiveOut` for dead-out; add the
   gap-mutation scan over {source root} ∪ {forwarded names}. (G2 is free — see above.)
3. **Rewrite + delete** — splice producer into consumer, set `lazy`/`sourceIter`, drop
   the dead statement; fixpoint loop.
4. **Emit** — `lazy`/`sourceIter` branches on the adapter nodes (mirror `fromIterator`).
5. **3c** — head-source `into_iter()` when dead-out.
6. **Re-bench + docs** — re-run `bun bench`; update `benchmarks/README.md` (arraypipe →
   win/parity) and record the fused-shape note; corpus coverage per the fixtures rule.
7. **Archive** to `docs/work/_archive/`.

## Deferred (future series)

- Fusing chains that cross a `sort` (would need a materialize-at-sort boundary).
- Fusing `map`→`collect` into `Map`/`Set` builders (adjacent to series 072 builders).
- Relaxing G2 to reorder-*safe* effects (e.g. per-element independent logs) — only if a
  real workload wants it; today unknown-effect ⇒ eager.
