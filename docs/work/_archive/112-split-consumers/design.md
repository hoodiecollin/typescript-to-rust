# 112 — Lazy `split`: the count & single-index consumers

Issue **#88**. Extends `refineSplitLazy` (series 107, which streamed the **iteration**
consumer) to the remaining **non-retaining** consumers, now unblocked by series 111
(`.length`→`f64`). Same principle: a `split` consumed without keeping the pieces
allocates no `Vec<String>`. Byte-identical, no dialect-surface change.

## Consumers added

| consumer | rewrite | node |
|---|---|---|
| **count** — `parts.length` / `s.split(sep).length` | `s.split(sep).count() as f64` | `strSplitCount` |
| **single index** — `parts[i]` / `s.split(sep)[i]` | `s.split(sep).nth((i) as usize).unwrap()` | `strSplitNth` |

Both HIR nodes + emitters already existed (added unused in series 107); this series makes
`refineSplitLazy` *produce* them. The temp-binding handler is generalized from "find a
`for…of parts`" to "classify the single use of `parts`": a for-of (stream), a `parts.length`
(count), or a `parts[i]` (nth). The inline forms (`s.split(sep).length` / `[i]`) are matched
directly.

## Guards

- **count** is unconditionally sound (`count()` yields an `f64`, holds no borrow past the
  call, cannot escape) beyond the existing **G1** single-use and **G3a** source-unmutated-
  across-the-gap. It relies on series 111: `parts.length` in an f64 context must itself
  compile (`parts.len() as f64`) for the streamed form to be byte-identical.
- **single index** yields a borrowed `&str`, so it fires **only where the result is used
  read-only** — the same default-deny slot allowlist as the iteration element. An owned-
  `String` escape stays materialized: a piece **returned**, **stored**, or passed through an
  **owned-producing method** (`.clone()` / `.to_string()` / `.to_owned()`). That last case
  fixed a hole shared with the 107 iteration guard: a method receiver was blanket-treated as
  read-only, but `(&str).clone()` is a `&str` (not the `String` the context needs), so those
  methods are now excluded from the safe slot.
- A consumer statement that **writes the source** is left materialized (the stream borrows
  the source across the consumer expression; a same-statement write would be a live-borrow
  conflict).

## Not done here — forEach & adapter chains are blocked *below* streaming

Investigation (2026-07-23) found the remaining "tails" are **not** split-streaming problems
— they do not lower at all, independent of `split`:

- **`map`/`filter`/`reduce` over a split** — `s.split(sep).map(…)` throws at lowering
  (*"cannot lift callback: receiver element type unknown"*); the temp form
  `parts.reduce(…)` throws *"reduce over a non-Copy element type — element borrowing is only
  wired for map/filter/find/some/every (fail-loud residual, series 057)"*. `string[]` adapter
  chains are a **pre-existing series-057 residual** (non-Copy element borrowing through lifted
  callbacks), not something `refineSplitLazy` can reach — there is no materialized baseline to
  make lazy.
- **`forEach` over a split** — lowers to `for &p in …` (a Copy-element ref pattern); a
  borrowed `&str` stream cannot bind an unsized `str` through `&p`, and the materialized form
  over `String` elements has the same problem. The pass correctly leaves it materialized (the
  `SF` spec pins that it does not emit `for &p in s.split(…)`).

So the adapter/forEach graduation is gated on the **057 non-Copy-element callback residual**,
a separate and larger dialect area — re-homed as a follow-up, **not** part of #88's
split-streaming scope. Count and single-index are the split-streaming consumers that were
actually reachable.

## Scope

- **In:** `strSplitCount` / `strSplitNth` production in `refineSplitLazy` (temp + inline),
  the read-only escape guard incl. the `.clone()`/`.to_string()` fix, and the plain-binder
  requirement that keeps `forEach`'s `&p` pattern materialized. Differential specs
  (`split-consumers.test.ts`).
- **Out:** `map`/`filter`/`reduce`/`forEach` over split (057-residual-blocked, re-homed);
  `split_limit`/`split("")`/regex-split lazy forms (each its own increment).

## Results

Measured 2026-07-23. `split-consumers.test.ts` **7/7** green (cargo-compiled + byte-identical:
SC1/SC2 count stream, SC-mut stays materialized, SI1/SI2 index stream read-only, SI-esc stays
materialized, SF forEach stays materialized). `split-lazy.test.ts` (107) still **8/8** — the
shared-escape-guard changes (`.clone()`/`.to_string()` exclusion; plain-binder requirement) did
not regress iteration. **Full compiler suite 1379 pass / 0 fail** (150 files). Count and
single-index now stream a borrowed `&str` with no `Vec<String>`; adapter/forEach re-homed to
**#96** (057 residual, no streaming baseline).
