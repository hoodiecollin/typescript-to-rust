# 108 — Specs: substring search (`index_of` / `last_index_of`)

Because #92 is a **tslib-internal** reimplementation (no emitter / lowering / dialect
change), the primary proof is a **Rust unit-test parity** pass in
`crates/tslib/tests/parity.rs` — the JS-parity semantics must hold byte-for-byte across
the `str::find` swap. The corpus workload adds a cargo-compiled + cross-runtime
byte-identical proof at scale.

## Parity — `crates/tslib/tests/parity.rs`

- **`index_of_matches_js`** — hit / miss / first-occurrence; `from` clamping (negative
  → 0, over-length → −1 for a non-empty needle); empty needle → `min(from, len)`; needle
  longer than haystack → −1; and the **char-index divergence** (`"éxyz".indexOf("xyz")`
  = 1 by char, not 2 by byte) that the byte→char conversion must preserve.
- **`last_index_of_matches_js`** — last occurrence; miss → −1; empty needle → `len`;
  non-ASCII char-index case.

## Corpus — `benchmarks/corpus/strsearch.ts`

Cargo-compiled + byte-identical-gated by the bench correctness pass:

- `strsearch.ts` — one large haystack, then many `indexOf` scans with a **loop-derived
  `from`** so neither a warmed JIT nor rustc can hoist the (otherwise invariant) search
  out of the loop. Covers the miss case (`"789"`, full scan → −1) and a hit. This is the
  honest witness: a fixed-`from` first draft was worthless (Bun's JIT hoisted the
  invariant call out and read 387µs vs TTR's real 30.8ms).

## Verification gate

- `cargo test -p tslib` green (parity + all existing tslib tests).
- Full compiler suite green (no emitter/lowering change → differential specs that route
  `index_of` recompile against the new tslib and stay byte-identical).
- Bench correctness gate byte-identical across node/bun/ttr for all 10 workloads.
- `design.md` Results records **both** the `strbuild` flip and the honest `strsearch`
  loss vs Bun (no overclaim).
