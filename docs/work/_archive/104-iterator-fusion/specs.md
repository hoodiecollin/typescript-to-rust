# 104 — Specs: iterator chain fusion

Drives the public `emit(...)` / `compile(...)` entry via the differential harness
(`tests/_support/differential`), which cargo-compiles and runs the emitted Rust — so
every shape assertion is also a COMPILES/BEHAVES proof. Spec file:
`packages/compiler/tests/iter-fusion.test.ts`.

Per the corpus-coverage rule, every decided behavior below gets a fixture — the real
guards (G1, and G3's two mutation sub-cases) each get an explicit **negative** scenario,
not just the happy path. G2 (callback purity) is *free by construction* — the series-048
lift surface accepts only a bounded numeric expression, so a liftable-but-impure callback
isn't constructible; IF-G2 below asserts that property (a non-numeric callback is
fail-loud *before* fusion), it isn't a fusion decision.

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
  console.log(doubled.length); const total = doubled.reduce(h,0)` → `doubled`
  is live-out, so it is **not** fused: its `.collect::<Vec<_>>()` remains. Value identical.
- **IF6a** (G3 — source mutated in the gap) — `const doubled = xs.map(f);
  xs.push(999); const total = doubled.reduce(h,0)` → the intervening `xs.push` forbids
  fusion; `doubled` keeps `.collect()` (materialized before the push). Value identical.
- **IF6b** (G3 — forwarded free var reassigned in the gap) — `let k = 2; const doubled =
  xs.map(v => v + k); k = 5; const total = doubled.reduce(h,0)` → `k` is captured by the
  map callback and reassigned before the consumer; eager captures `k=2`, lazy would
  capture `k=5`, so fusion is forbidden. `doubled` keeps `.collect()`. Value identical.
- **IF-G2** (purity by construction) — a callback outside the numeric surface (e.g. one
  that calls a helper) is **fail-loud at lift time** (`too complex to lift`), never
  reaching fusion. Asserts the property that makes G2 free; not a fusion path.

## Edge

- **IF7** (sort barrier) — `xs.map(f).sort().filter(g)` → not fused across the sort;
  `sort` materializes, and the pre-/post-sort segments may fuse independently but the
  chain is **not** one expression. Compiles; value identical.
- **IF8** (nothing to fuse) — a lone `const out = xs.map(f)` with no downstream adapter
  is unchanged: `xs.iter().map(…).collect::<Vec<_>>()`.

## Cross-spec updates (live files the impl must touch)

- **`benchmarks/README.md`** — *(done)* record the fused single-pass shape and the
  **measured** outcome: fusion is an e2e/RSS win but the steady-state loss persists,
  because the real cost is the predicate's `f64` modulo (`frem`), not allocation
  (`build + fold` alone is 0.86ms; f64 `%` 9.6ms vs i64 `%` 1.4ms). arraypipe's
  steady-state loss re-homes under **#87**, not #89.
- **`benchmarks/corpus/arraypipe.ts`** — already exercises the positive fusion path as a
  perf workload; no new corpus workload needed for the happy path. (The G1/G2/G3
  negatives are correctness fixtures, not perf workloads — they live in the spec file.)
- **`docs/plan.md`** — no refine-chain enumeration exists there today; nothing to add.

## Differential (cargo-backed)

- arraypipe prints its checksum identically under node/bun/ttr before and after fusion.
- The IF6a/IF6b gap-mutation programs print the identical value in their eager form
  (fusion would read the mutated source/capture — this proves the G3 guard is
  load-bearing, not cosmetic).
- Every fixture compiles under cargo (the fused element-shim threading is validated by
  the oracle, not by shape-matching alone).
