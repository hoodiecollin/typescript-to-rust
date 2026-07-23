# 107 — Specs: lazy `split` (no `Vec` for a non-retaining consumer)

Drives the public `emit(...)` / `compile(...)` entry via the differential harness
(`tests/_support/differential`), cargo-compiling and running each program so every shape
assertion is also a COMPILES/BEHAVES proof (Rust stdout ≡ Bun stdout ≡ pinned literal).
Spec file: `packages/compiler/tests/split-lazy.test.ts`.

Per the corpus-coverage rule, **every** taxonomy branch gets a fixture — the positives that
stream, and (soundness-critical) the negatives that must **keep** `tslib::string::split`.
The negatives are the anti-overfit and anti-unsoundness guards: each must compile and stay
byte-identical while *not* fusing.

## Positive — streams, no `Vec` (v1; spec file `split-lazy.test.ts`)

- **SL1** (strbuild shape — for-of over a temp, unused piece) — `const parts = s.split("5")`
  then `for (const _p of parts) n++`: emits `for _p in s.split("5")` (native `str::split`,
  `&str`), **no** `tslib::string::split`, **no** `let parts`. Byte-identical. (Also asserts
  the split site appears exactly once — idempotency.)
- **SL2** (inline for-of, no temp) — `for (const p of s.split("5"))`: emits
  `for p in s.split("5")`; **no** `.iter()` over a tslib call.
- **SL3** (read-only piece is used) — `for (const p of s.split("5")) acc = acc + p`: still
  streams (a `&str` flows through the concat's `Display`), output identical.

### Deferred positives (land with their increment — see design blockers)

- **SL4 count** (`.length`) — blocked on `.length`→`f64`; no compiling baseline yet.
- **SL5 single-index** (`[i]`) — needs the result-escape guard.
- **SL6 forEach** / **SL7 adapter chain** (`map/filter/reduce`) — iter-fusion handshake.

## Negative — keeps `tslib::string::split` (v1)

- **SL-esc** (piece escapes as owned — **soundness-critical**, emit-only) —
  `for (const p of s.split("5")) { out.push(p); }`: the piece is retained as an owned
  `String`, so a borrowed `&str` stream would be wrong — stays `tslib::string::split(&s,
  "5")` + `parts.iter()`. Proves G-elem excludes escapes. (Emit-only: the escaping shape is
  itself an unsupported residual that does not compile, which is *why* fusing it is unsound.)
- **SL-mut** (source mutated across the borrow) — `const parts = s.split("5"); s = s + "9";
  for (const _p of parts) n++`: G3 fails — the source `s` is written (a `strAppend` after
  106) between producer and consumer — stays materialized (pieces must outlive the mutation,
  and streaming would re-split the *mutated* `s`).
- **SL-empty** (empty separator) — `for (const p of s.split(""))`: ineligible — stays
  `tslib::string::split_chars` (yields `char`, not `&str`).
- **SL-limit** (limit arg) — `const parts = s.split(",", 2)`: ineligible — stays
  `tslib::string::split_limit`.
- **SL-regex** (regex split) — `const parts = s.split(/[0-9]/)`: ineligible — stays the
  regex `.split` path (`parts.iter()`).

## Corpus workloads (added this series — honest + varied)

Cargo-compiled + byte-identical-gated by the bench correctness pass, not just timed:

- `splitscan.ts` — split + for-of that **reads each piece** read-only → exercises (a) with a
  used `&str` element, proving the streaming win isn't tied to `strbuild`'s discarded binder.

(`splitindex.ts` / `splitfold.ts` land with their deferred increments; a pieces-stored
control is intentionally omitted — it does not compile, so `SL-esc` proves the (d) guard.)

## Verification gate

- Full compiler suite green (baseline + the new specs).
- Every negative compiles and is byte-identical while keeping `tslib::string::split*`.
- Bench correctness gate byte-identical across node/bun/ttr for all corpus workloads
  (old + new).
- `Results` section of `design.md` filled with the **per-consumer** measured effect (not
  only strbuild), and the honest note on the `splitkeep` control staying a loss.
