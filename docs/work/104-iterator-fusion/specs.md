# 104 — Specs: iterator chain fusion

Drives the public `emit(...)` / `compile(...)` entry via the differential harness
(`tests/_support/differential`), which cargo-compiles and runs the emitted Rust — so
every shape assertion is also a COMPILES/BEHAVES proof. Spec file:
`packages/compiler/tests/iter-fusion.test.ts`.

Per the corpus-coverage rule, every decided behavior below gets a fixture — the three
guards (G1/G2/G3) each get an explicit **negative** scenario, not just the happy path.

## Positive — fuses (RED until `refineIterFusion` lands)

- **IF1** (arraypipe shape) — `xs.map(f).filter(g).reduce(h, 0)` where the two
  intermediates are single-use and all callbacks pure → **one** chained expression
  `…map(…).filter(…).fold(…)`; emits **no** `.collect::<Vec<_>>()` and no `doubled`/
  `kept` `let`s. Prints the identical checksum to node/bun.
- **IF2** (two-stage, terminal collect) — `const out = xs.map(f).filter(g)` with `out`
  the result → fuses to `xs.iter().map(…).filter(…)…collect::<Vec<_>>()` (one collect,
  no intermediate). Value identical.
- **IF3** (3c — source dead) — in IF1, `xs` is not used after the chain → head lowers to
  `xs.into_iter().map(…)` (no `.iter()`, head deref dropped). Value identical.
- **IF3b** (3c — source live) — same chain but `xs` is read after (e.g. `xs.length`
  logged) → head stays `xs.iter()` (borrow, not move). Value identical; compiles.

## Negative — left eager (each isolates one guard)

- **IF4** (G1 — intermediate observed later) — `const doubled = xs.map(f); …;
  console.log(doubled.length); const total = doubled.filter(g).reduce(h,0)` → `doubled`
  is live-out, so it is **not** fused: its `.collect::<Vec<_>>()` remains. Value identical.
- **IF5** (G2 — impure callback) — a `map` callback that mutates a captured counter (or
  performs I/O) → the chain is **not** fused (both stages keep `.collect()`), preserving
  JS's run-all-maps-then-all-filters ordering. Stdout identical to node/bun (the point of
  the guard: eager output must match, and fused output would have reordered it).
- **IF6** (G3 — source mutated in the gap) — `const doubled = xs.map(f);
  xs.push(999); const total = doubled.filter(g).reduce(h,0)` → the intervening
  `xs.push` forbids fusion; `doubled` keeps `.collect()` (materialized before the push).
  Value identical to node/bun.

## Edge

- **IF7** (sort barrier) — `xs.map(f).sort().filter(g)` → not fused across the sort;
  `sort` materializes, and the pre-/post-sort segments may fuse independently but the
  chain is **not** one expression. Compiles; value identical.
- **IF8** (nothing to fuse) — a lone `const out = xs.map(f)` with no downstream adapter
  is unchanged: `xs.iter().map(…).collect::<Vec<_>>()`.

## Cross-spec updates (live files the impl must touch)

- **`benchmarks/README.md`** — after 104 re-measures, move `arraypipe` out of the
  "loses" discussion in *Reading the numbers* (to a win/parity note) and record the
  fused single-pass shape.
- **`benchmarks/corpus/arraypipe.ts`** — already exercises the positive fusion path as a
  perf workload; no new corpus workload needed for the happy path. (The G1/G2/G3
  negatives are correctness fixtures, not perf workloads — they live in the spec file.)
- **`docs/plan.md`** — note the new `refineIterFusion` step in the refine-chain summary.

## Differential (cargo-backed)

- arraypipe prints its checksum identically under node/bun/ttr before and after fusion.
- The IF5 impure-callback program prints the identical value eager (fusion would have
  changed the interleaving — this proves the guard is load-bearing, not cosmetic).
- Every fixture compiles under cargo (the fused element-shim threading is validated by
  the oracle, not by shape-matching alone).
