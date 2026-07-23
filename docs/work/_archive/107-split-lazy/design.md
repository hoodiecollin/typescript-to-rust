# 107 — Lazy `split`: never allocate a `Vec` for a split consumed without keeping the pieces

Issue **#88** (under perf epic **#86**), sub-task **2c**. Framed by the **principle**,
not the benchmark: *a `String.prototype.split` whose result is consumed without keeping
the pieces should allocate no `Vec<String>` at all.* `benchmarks/corpus/strbuild.ts` is
one witness; it is not the target.

## Why this framing (not "flip strbuild")

The perf epic is derived from benchmark losses, which carries a real hazard: tightening a
guard until it fits the one shape we happen to watch, then reading a green corpus cell as
proof of a general win. It isn't. The generality evidence in this repo is the
**differential specs** — varied cargo-compiled shapes plus the **negative rejects** where
the optimization must *not* fire — not the 8-workload corpus (a perf smoke test). So this
series is specified by a **consumer taxonomy**, validated across that taxonomy by specs,
and the corpus grows alongside with *varied* split shapes (including ones that must stay
materialized, as honest controls).

## Problem

`s.split(sep)` lowers to `tslib::string::split(&s, sep)` → `Vec<String>`, allocating one
owned `String` **per piece** plus the vector frame — every call, unconditionally. In a
scan loop (strbuild: 300 rounds × ~thousands of one-char pieces) that is millions of
heap allocations for a loop that only *reads* each piece and drops it.

Rust's native `str::split(sep)` yields each piece as a borrowed `&str` **lazily**, storing
nothing, and — per tslib's own note — matches JS semantics exactly for a **non-empty**
separator. So whenever we can prove the consumer never keeps a piece, we can stream
`s.split(sep)` directly and allocate nothing.

## Ruling

A standalone, pure, idempotent HIR → HIR pass — `refineSplitLazy` — that recognizes a
**non-empty-separator** `split` whose result is consumed by a **non-retaining** consumer
and rewrites it to stream. Output is **byte-identical**; there is **no dialect-surface
change** — `string[]` still means `Vec<String>` everywhere. The compiler is only choosing
a representation it can *prove* observationally identical, exactly as iterator fusion
(#89) does. No new `Vec<&str>` type is exposed to the dialect.

### Separator eligibility (Dial 1 — fixed by soundness)

Only the **1-arg, non-empty separator** form is eligible — the compiler lowers it to
`tslib::string::split(recv, sep)`. These stay materialized (each needs its own later
treatment; none yields a clean `&str` stream):

- `split("")` → `tslib::string::split_chars` — yields `char`, not `&str`.
- `split(sep, limit)` → `split_limit`/`split_chars_limit` — deferred (a lazy form is
  `…split(sep).take(split_take(limit))`; sound but out of v1 scope).
- regex `re.split(s)` — a different code path (regex engine).

### Consumer taxonomy (Dial 2 — the full non-retaining set)

Given an eligible split, the consumer decides the representation:

| consumer | rewrite | allocates |
|---|---|---|
| **(a) iterate** — `for…of`, `.forEach`, a `map/filter/reduce` chain | stream `recv.split(sep)` as the iterator source | nothing |
| **(b) count** — `.length` and nothing else | `recv.split(sep).count() as f64` | nothing |
| **(c) single index** — exactly one `[i]` | `recv.split(sep).nth((i) as usize).unwrap()` | nothing |
| **(d) anything else** — repeated `[i]`, stored/returned, or a piece moved out to own | `tslib::string::split(...)` (today) | `Vec<String>` |

(b) and (c) are the anti-overfit part: without them the win is tied to the exact `for…of`
shape strbuild uses. With them the optimization tracks the *principle* — a split consumed
without retaining pieces never allocates.

### Detection & guards

Mirrors iter-fusion's structure (`refineIterFusion`, series 104):

- **Inline form** — `for (const p of s.split(sep)) { … }` (no temp binding): the `forIn`
  node's `iter` is `tslib::string::split(...).iter()`. Rewrite `iter` to the lazy source.
  No producer/refcount involved. Guard: **G-elem** (below).
- **Temp-binding form** — `let parts = s.split(sep)` followed by a single consumer:
  - **G1** — `parts` is referenced **exactly once** across the whole body (complete
    `refCount`, the same conservative count iter-fusion uses; a second use ⇒ materialize).
    This *is* the "single index vs repeated index" and "not stored/reused" test.
  - **G3** — no statement between producer and consumer writes the split **source** root
    (`recv`) — the stream borrows `recv`, so it must be unmutated across the borrow. (Same
    gap-mutation scan as iter-fusion.)
  - The single use is classified into (a)/(b)/(c); if it is none of these, materialize.
  - On rewrite: replace the consumer expression with the lazy node and **delete** the
    `let parts` producer.

- **G-elem (iteration soundness)** — the streamed element is a borrowed `&str`, where the
  materialized form yielded `&String`. For every **read-only** use this is a transparent
  `Deref` substitution (`.len()`, `.contains`, `==`, `Display`/concat, passing where
  `&str` is wanted — the dialect never emits a `&String` param). The **only** unsound case
  is an element that **escapes as an owned `String`** (pushed into a `Vec<String>`,
  returned, bound to a `let x: string`, stored in a field). Iteration fuses **only when no
  element escapes**; an escaping element ⇒ materialize (case (d)). The loop `mode` field is
  **not** a sufficient signal (a piece pushed into a `Vec<String>` today keeps `mode:
  "ref"`), so escape is detected structurally on the element binder's uses. The negative
  spec **SL-esc** (a piece pushed into an owned array) pins this: it must **compile** and
  stay byte-identical, i.e. must **not** fuse.

### Soundness summary

- Non-empty `str::split` ≡ JS split for the separator forms we accept (documented in
  tslib and re-proven by every spec running byte-identically under node/bun/ttr).
- The stream borrows `recv` for exactly the consumer's extent; G3 keeps `recv` unmutated
  across it; Rust's borrow checker is the backstop (a live conflicting borrow fails to
  compile rather than misbehaving).
- No piece is retained past the consumer (G1 single-use + G-elem non-escape), so replacing
  owned pieces with borrows is observationally identical.
- `.nth(i).unwrap()` reproduces today's `Vec` index panic on out-of-range; `.count() as
  f64` reproduces `.len()` as `f64`.

### HIR additions

Three nodes (precedent: `strConcat`/`strAppend`), each carrying `recv` + `sep`:

- `strSplitIter { recv, sep }` → emits `<recv>.split(<sep>)` — the lazy source used as a
  `forIn.iter`, a `.forEach` receiver, or the head of a fused adapter chain.
- `strSplitCount { recv, sep }` → emits `(<recv>.split(<sep>).count() as f64)`.
- `strSplitNth { recv, sep, index }` → emits `<recv>.split(<sep>).nth((<index>) as usize).unwrap()`.

`sep` follows the existing `strPatternArg` interning (a literal renders as a bare
`&'static str`, per #88/2b). None needs a std import (`str::split`/`count`/`nth` are core);
`usesKind` still auto-discovers them for any future need.

### Pass placement

`refineSplitLazy` runs on final binding types (after `refineStrings`). The
`map/filter/reduce`-over-split case (a) interacts with `refineIterFusion`: `refineSplitLazy`
sets the chain **head** to iterate the `strSplitIter` source, and `refineIterFusion`
(running after) fuses the adapter chain downstream as usual. For-of/forEach/count/index
are fully handled within `refineSplitLazy`.

## Implementation staging (spec-first, within the series)

**v1 (this series) — iterate (a): for-of, temp + inline.** The strbuild-class win. Node
`strSplitIter`; pass `refineSplitLazy` (G1/G3/G-elem); emitter; refine-chain wiring.
Sound, byte-identical, fully specced. This is where the measured allocation win lives.

**Deferred follow-ons (each has a concrete, named blocker — not just "later"):**

- **Count (b) — `.length`.** *Blocked on an orthogonal dialect issue.* `parts.length`
  lowers to `parts.len()` (a `usize`), which does **not** coerce into an `f64` context
  (`let n: f64 = parts.len()` / `return parts.len()` don't compile today — the documented
  `.length`-non-coercion constraint). So there is **no byte-identical materialized
  baseline** for a count consumer to optimize against: `strSplitCount` emitting
  `…count() as f64` would *enable* programs that don't compile today, which is a dialect
  change, not a representation swap. Count graduates once `.length`→`f64` coercion is
  fixed. (`strSplitCount` HIR + emit are in place, unused, for that increment.)
- **Single index (c) — one `[i]`.** Needs a **result-escape** guard: `.nth(i).unwrap()`
  yields a borrowed `&str`, so it is only sound when the indexed piece is *used*
  read-only (not moved into an owned `String`) — the same escape question as G-elem but on
  the index expression's *result* rather than a loop binder. Its own pass + specs.
  (`strSplitNth` HIR + emit are in place for that increment.)
- **Adapter chains (a) — `map/filter/reduce`-over-split.** Head-laziness handshake with
  `refineIterFusion` (make the split a lazy chain head). The chain already runs today,
  just materialized; this removes the head allocation. Own increment.

`forEach` iteration is grouped with (a) but has a `&${param}` ref-pattern subtlety
(Copy-element assumption) and lands with the adapter-chain increment.

## Corpus growth (alongside — honest, varied)

Per the "don't build for the benchmark" concern, the perf signal must not be inferred from
`strbuild`'s one shape (an *unused* loop binder). v1 adds a second iteration workload where
each piece is genuinely **read**, proving the streaming win isn't tied to the discard case:

- `splitscan.ts` — split + for-of that **reads each piece** read-only (a predicate over the
  piece drives a `for…of` counter). Exercises (a) with a used `&str` element.

Deferred workloads land with their consumer's increment (so each is a runnable,
byte-identical proof, not a stub): `splitindex.ts` with (c); `splitfold.ts` with the
adapter increment. A pieces-**stored** control (case (d)) is intentionally *not* added:
storing a piece into an owned `Vec<String>` is itself an unsupported residual (it does not
compile), so it cannot be a runnable corpus workload — the (d) guard is proven by the
`SL-esc` spec instead.

Each corpus file exports pure `run(): number`, ASCII, byte-identical across node/bun/ttr,
and obeys the existing dialect constraints (unit-step loops, counts via `for…of`).

## Scope

- **In (v1):** non-empty-separator `split`, iteration consumer (a) — for-of temp + inline;
  case (d) and all ineligible separators unchanged; `splitscan.ts` corpus.
- **Out (noted follow-ons, each with a named blocker above):** count (b, blocked on
  `.length`→`f64`), single-index (c, needs a result-escape guard), adapter chains + forEach
  (iter-fusion handshake). Plus `split_limit` lazy form, `split("")` char-stream, regex
  split. Each is a separate increment; none regresses.

## Results

Measured 2026-07-22 (`bun bench`, this machine). Both the differential taxonomy and the
corpus hold **byte-identical** across node/bun/ttr (correctness gate green on all 9
workloads; every SL spec compiles + runs identical). The lazy-split pass fires on the real
workloads — both `strbuild` and `splitscan` emit `for … in s.split("5")` with **no**
`tslib::string::split` / `Vec<String>`.

### The streaming win is real — `splitscan` (the clean shape)

`splitscan` (split + for-of that **reads** each piece) is a **TTR win in both dimensions**:

| | node | bun | ttr | ttr vs bun / node |
|---|---|---|---|---|
| steady-state | 99.9ms | 99.1ms | **60.8ms** | **1.6× / 1.6×** |
| end-to-end | 204ms | 107ms | **64.3ms** | **1.7× / 3.2×** |
| peak RSS | 82.3MB | 63.2MB | **1.6MB** | 40× less |

Streaming a borrowed `&str` instead of materializing thousands of one-char heap `String`s
per round is a genuine, measurable win on a shape where the split *is* the work.

### 2c does **not** flip `strbuild` — and the reason is the honest headline

`strbuild` **stays a loss** (steady 81.4ms vs bun 20.0ms = 0.2×; e2e 83.6ms vs bun 34.5ms
= 0.4×). 2c shaved it (steady ~99.4 → 81.4ms, e2e ~103 → 83.6ms) by removing the per-round
`Vec<String>`, but did not move it out of the *loses* column. Isolating strbuild's scan
loop into two native-binary probes (startup floor 3.4ms) shows **why** — and corrects a
prior unmeasured claim:

| probe (strbuild scan loop) | e2e min | ≈ compute |
|---|---|---|
| split-only (streamed, no `indexOf`) | 18.0ms | ~14.6ms |
| `indexOf("789")`-only (no split) | 72.8ms | ~69ms |
| full strbuild | 83.9ms | ~80ms |

The pre-2c note "~99ms is the split scan" was itself **wrong** — it conflated the split
loop with the `s.indexOf("789")` sitting next to it (line 19: a full ~80KB substring search
returning −1, ×300). Measured, the split was ~31ms *with* the Vec and is **~14.6ms now**
streamed; the dominant ~69ms is `indexOf`. So strbuild's real bottleneck is **substring
search** (`tslib::string::index_of` vs Bun's native `String.prototype.indexOf`), a
**separate** perf item unrelated to `split`. **This is the "measure the halves before
claiming a workload is fixed" lesson a fourth time** — the design's own "flips strbuild"
framing was the unmeasured claim; the `splitscan` corpus (added precisely to isolate the
streaming win) is what actually proves 2c works.

### Net

- v1 (iteration consumer, non-empty separator) ships sound + byte-identical; the pass fires
  where expected and stays materialized on every negative (SL-mut / SL-empty / SL-limit /
  SL-regex / SL-esc).
- The streaming optimization is validated by `splitscan` (**1.6× / 1.7× win**, 40× RSS).
- `strbuild` remains a loss, now correctly attributed to `indexOf` substring search — filed
  as **#92** under #86 (not a `split` regression; 2c improved it ~18ms).
