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
them per element (map x₀, filter x₀, fold; map x₁, …). Three independent conditions
must all hold, or the chain is left eager:

- **G1 — intermediate not observed later.** Each fused intermediate binding
  (`doubled`, `kept`) must be **dead-out** after its consumer statement, per
  `computeLiveOut` over the enclosing body. This subsumes textual single-use and also
  rejects closure captures / loop back-edge reuse (liveness keeps those live). *(This is
  the #89↔#88 "shared escape check" — it already exists and is already reused by the 068
  consuming-edge in `alias-escape.ts` and by the for-of ownership-mode pass. #89 reuses
  it; it does not build a new analysis.)*
- **G2 — callbacks are pure.** Because fusion reorders when each stage's callback runs
  relative to the others, the lifted `__cb_*` callbacks must be side-effect-free (no
  writes to captured/free bindings, no I/O, no calls to non-pure functions). Pure
  callbacks yield identical results under any interleaving, so fusion is observationally
  identical. Conservative: unknown ⇒ impure ⇒ don't fuse. arraypipe's callbacks
  (`v*2+1`, `v%5!==0`, `a+b`) are pure.
- **G3 — no source/capture mutation in the gap.** For a non-adjacent consumer, no
  statement between producer and consumer may write to the chain **source** or to any
  **free variable** the callbacks capture (lazy reads them at fold time, not at producer
  time). Scan the intervening statements for such writes; any ⇒ don't fuse. (Adjacent
  consumers trivially satisfy G3.)

`computeLiveOut` handles loops/branches/nested blocks, so G1 is sound inside control
flow. G2/G3 are conservative local scans that fall back to eager on any doubt.

## The fusion pass — `refineIterFusion`

A new pure, idempotent HIR → HIR pass (`packages/compiler/src/iter-fusion.ts`), appended
to the refine chain (`refineBitwise → refineNumerics → refineStrings → refineIterFusion`).
Runs per function/method/main body, recursing into nested bodies. Per body:

1. `computeLiveOut(body, allLocals)`.
2. Find a **producer**: `let NAME = <iterMap | iterFilter | iterFlatMap>` (the lazy,
   `Vec`-collecting adapters — the *intermediate* shapes).
3. Find its **consumer**: the unique later use of `NAME` as the `receiver` of another
   iter-adapter (`iterMap`/`iterFilter`/`iterFlatMap`/`iterReduce`/`iterFind`/`iterAny`/
   `iterAll`). Require G1 (dead-out after consumer), G2 (both callbacks pure), G3 (no
   interfering write in the gap).
4. Rewrite: mark the producer node `lazy` (drop terminal `.collect()`) and `sourceIter`
   on the consumer where its receiver is now an iterator (drop `.iter()`, switch the
   element shim to by-value, drop `.copied()`); splice the producer node in as the
   consumer's `receiver`; **delete** the producer statement.
5. Fixpoint: a 3-stage chain fuses in two rounds (map+filter, then (map∘filter)+reduce).

**3c (into_iter):** after fusion, if the chain **head**'s source is a local that is
dead-out after the (now single) chain statement, emit `.into_iter()` instead of `.iter()`
and drop the head deref shim. Same `computeLiveOut` result; same guard style.

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
2. **G1/G2/G3 analysis** — `iter-fusion.ts`: reuse `computeLiveOut`; add a conservative
   `isPureCallback` (over the lifted `__cb_*` bodies) and a gap-mutation scan.
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
