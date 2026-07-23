# 108 — Substring search: `index_of` / `last_index_of` through `str::find`

Issue **#92** (under perf epic **#86**). Surfaced by series 107: after the lazy
`split` streamed `strbuild`'s scan, the workload *still* lost — probes isolated the
residual as the per-round `s.indexOf("789")`, not the split.

## Problem

`tslib::string::index_of` (and `last_index_of`) opened with:

```rust
let chars: Vec<char> = s.chars().collect();   // allocate the WHOLE haystack, every call
```

then scanned char windows by hand. For `strbuild`'s 300 × `s.indexOf("789")` over an
~80KB string that is 300 full-haystack `Vec<char>` allocations plus an O(n·m) hand
scan. The search was never the point — the **per-call allocation** was.

## Ruling

Route both through Rust's native substring search (`str::find` / `str::rfind`), which
is memchr/two-way-accelerated and **allocation-free**, then convert the returned
**byte** offset back to a **char** index to preserve the documented char-vs-UTF-16
divergence (this dialect indexes by char, matching `charAt`/`str_at`/`split_chars`).

```rust
pub fn index_of(s: &str, needle: &str, from: f64) -> f64 {
    let f = from.trunc();
    let start_char = if f.is_nan() || f < 0.0 { 0 } else { f as usize };
    if needle.is_empty() { return start_char.min(s.chars().count()) as f64; }
    let byte_start = match char_to_byte(s, start_char) { Some(b) => b, None => return -1.0 };
    match s[byte_start..].find(needle) {
        Some(rel) => s[..byte_start + rel].chars().count() as f64,
        None => -1.0,
    }
}
```

### Why byte-identical

Both `s` and `needle` are valid UTF-8, so a **byte** match of `needle` in `s` occurs
**iff** the char sequence matches starting at that char boundary — `str::find` only
reports char-boundary-aligned matches. The byte offset is mapped back to a char index
via `s[..b].chars().count()`, so the returned index is exactly the old char-window
scan's result. The JS-parity edges (negative/NaN/over-length `from` clamping, empty
needle → `min(from, len)`, needle longer than haystack → −1, last-vs-first occurrence)
are preserved and locked by `crates/tslib/tests/parity.rs`
(`index_of_matches_js` / `last_index_of_matches_js`, including non-ASCII char-index cases).

### Hot-path notes

- `char_to_byte(s, 0)` short-circuits to `Some(0)` on the first char, so the common
  `from = 0` search never walks the string — it is one `str::find`.
- `str::find`'s memchr scan replaces the `Vec<char>` collect; on a miss it scans the
  bytes once instead of allocating + comparing char windows.
- `last_index_of` gets the symmetric fix (`str::rfind`); it had the identical
  `Vec<char>` wart even though only `index_of` was on the strbuild hot path.

## Scope

- **In:** `index_of` + `last_index_of` reimplementation (tslib-internal; **no** emitter
  / lowering / dialect change — the routing and signatures are unchanged). Parity tests.
  A hoist-proof `strsearch` corpus workload.
- **Out:** any dialect-surface change; `charAt`/`str_at`'s own `Vec<char>` collect
  (single-char, not a substring scan — separate if ever measured).

## Corpus — `strsearch` (honest, hoist-proof)

`strsearch.ts` builds one large haystack, then scans it with `indexOf` where the
`from` offset is **derived from the loop counter** — a first draft with a fixed `from`
was worthless: a warmed JIT hoisted the loop-invariant `s.indexOf("789")` out of the
2000-round loop (Bun steady-state read 387µs vs TTR's real 30.8ms — the JIT computed it
once). Varying `from` defeats that on both sides, so the workload measures real
substring-search throughput, not invariant hoisting.

## Results

Measured 2026-07-23 (`bun bench`, this machine). Correctness gate green on all 10
workloads — the rewrite is **byte-identical** (`strsearch` node=bun=ttr=81200; tslib
parity suite 11/11).

### `strbuild` flipped — the #92 goal

Removing the per-call `Vec<char>` moved `strbuild` out of the *loses* column:

| | bun | ttr (before → after #92) | vs bun |
|---|---|---|---|
| end-to-end | 34.4ms | 83.6ms → **21.3ms** | **1.6× win** (was 0.4×) |
| steady-state | 19.5ms | 99.4ms → **17.7ms** | **1.1× win** (at-par vs node) |
| peak RSS | 54.7MB | **1.6MB** | 34× less |

Combined with series 107 (streamed `split`), `strbuild` — historically the worst TTR
workload — is now a win end-to-end.

### `strsearch` — honest residual: raw search still trails JSC

The dedicated, **hoist-proof** substring workload is a **loss vs Bun**, a win vs Node:

| | node | bun | ttr | vs bun / node |
|---|---|---|---|---|
| end-to-end | 141ms | 22.5ms | 36.0ms | **0.6×** / 3.9× |
| steady-state | 37.2ms | 9.4ms | 32.1ms | **0.3×** / 1.2× |

This is the honest read #92 was worth adding: the fix eliminated the *allocation*
pathology (that is what flipped `strbuild`), but Rust's `str::find` on a short needle
whose first byte recurs frequently (`"789"`/`"abc2"` over `"abc0abc1…"`) still does
more work than JSC's optimized `indexOf`. Byte-identical, so it is not a regression —
it is a **new, separate throughput gap**, not the allocation bug #92 set out to kill.
Possible follow-up: route through the `memchr::memmem` two-way+SIMD searcher (kept as a
tracked residual on #92; **not** in this series — no dependency added, no dialect change).

**Net:** #92 fixed the measured `strbuild` bottleneck (allocation), delivering the flip;
raw search throughput vs JSC remains an open, lower-priority residual.
