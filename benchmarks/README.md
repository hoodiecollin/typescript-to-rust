# benchmarks — Node vs Bun vs TTR

Microbenchmarks comparing three ways to run the *same* program:

- **node** — Node.js running the TypeScript directly (native type-stripping).
- **bun** — Bun running the TypeScript directly.
- **ttr** — the TypeScript compiled to Rust by this repo, built `--release`, run as a
  native binary.

Microbenchmarks are easy to lie with, so the design is built around *not* fooling
ourselves:

- **One corpus, three consumers.** Each workload in `corpus/` exports a single pure
  `run(): number`. It is compiled to Rust by the real compiler and also run as-is
  under node/bun — same logic, three backends.
- **Correctness gates timing.** Before anything is timed, every workload is run under
  all three and their stdout must be **byte-identical**. A benchmark whose variants
  disagree is meaningless and aborts the run.
- **Two questions, measured separately** (they tell opposite-feeling stories):
  - **End-to-end** (`e2e.ts`) — the whole process: startup + runtime init + compute.
    The real-world "you ran the script" cost. A near-empty **startup baseline** is
    measured too, so `compute ≈ workload − startup`. Peak RSS and native artifact
    size are reported here as well.
  - **Steady-state** (`bench-js.ts` + criterion) — the hot `run()` alone, startup
    excluded, warmed up. mitata measures the JS side under node and bun; criterion
    measures the TTR side. This is where a warmed JIT is genuinely competitive.
- **Anti-DCE on every side.** mitata uses `do_not_optimize`; criterion black-boxes
  the *function pointer* (not just the result) so a nullary pure `run()` can't be
  const-folded away by LTO.

## Running

```
bun bench            # full pipeline → prints both tables, writes .build/report.{json,md}
bun bench:verify     # just the correctness cross-check
```

Everything runs from the repo root. Generated crates, the shared cargo `target/`,
and the reports live under `benchmarks/.build/` (gitignored).

## The corpus

| workload | stresses |
|---|---|
| `fib` | recursive function-call overhead + integer arithmetic |
| `loopsum` | tight numeric loop with a modulo branch |
| `sieve` | array allocation + index-heavy inner loops |
| `mandelbrot` | dense `f64` math (where native + JIT are closest) |
| `arraypipe` | `map`/`filter`/`reduce` — allocation + closure calls |
| `sort` | comparator-callback sort of a pseudo-random array |
| `strbuild` | string concatenation + `split`/`indexOf` scanning |
| `splitscan` | `split` + for-of that reads each piece (lazy-split streaming) |
| `strsearch` | `indexOf` substring search, loop-derived `from` (hoist-proof) |
| `histogram` | number-keyed `Map` — hashing + insert/update churn |

### Dialect constraints (why the corpus looks the way it does)

The workloads are written in the **strict TTR dialect**, which shapes them:

- Every binding is explicitly typed; numbers are `f64` end to end.
- **Index loops** (`arr[i]`) must use a unit step and a `usize`-typed bound
  (`.length`) or an integer literal, or the emitted index (`usize`) and the loop
  bound (`f64`) mismatch. That is why `sieve` bounds on `sieve.length`.
- `.length` in an `f64` context is cast `(… as f64)` (series 111); in a `usize` slot
  (index, range bound) it stays a bare `usize`. Other `usize`-returning calls still
  don't auto-coerce. (The corpus keeps its `for…of` counters — they predate 111 and
  stay byte-identical.)
- `charCodeAt` is a deferred UTF-16 residual; `strbuild` scans with `split`/`indexOf`.
- A `Map` mutated by a `&String` key hits an ownership residual, so `histogram`
  uses a numeric key.

These are honest reflections of the accepted dialect today — not the harness working
around bugs. When the dialect graduates a residual, a workload can be broadened.

## Reading the numbers

TTR is not uniformly faster. It wins big where native code and tight memory layout
matter (recursion, sorting, sieving) and can **lose** where a naive lowering costs
more than a warmed JIT (`O(n²)` string concatenation, allocation-heavy closure
chains). Those losses are the point: they show the comparison isn't rigged, and they
double as a to-do list for the codegen.

That to-do list is live. **`loopsum`** was the worst result in the suite — a tight
`f64`-modulo loop lowering to a libm `frem` call ×5M, where a warmed JIT used
hardware integer modulo. **Series 103 (numeric type-specialization)** closed it: the
inference pass now proves the counter/accumulator integer-valued and retypes them
`f64` → `i64`, emitting a native `for i in 0i64..N` range with hardware integer
arithmetic — so `loopsum` moves from the *loses* column to a **win** (~95ms → ~7ms
steady-state), with byte-identical output. The accepted `i64` divergence (past 2⁵³)
is documented in `docs/DIALECT.md`.

**`arraypipe`** taught a lesson about *measuring* before optimizing — twice. It looked
like an allocation problem — `map`/`filter`/`reduce` materialized two throwaway `Vec`s —
so **series 104 (iterator fusion, #89)** fused the chain into one lazy
`xs.into_iter().map(…).filter(…).fold(…)` pass with no intermediates. That shipped and is
correct (byte-identical, low RSS), but the *steady-state* barely moved — because
allocation was never the cost. Isolating it: `build + fold` alone is **0.86ms**; the whole
loss was the predicate's `f64` modulo (`v % 5`), a libm `frem` per element — **f64 `%`
9.6ms vs i64 `%` 1.4ms** (7×). Same root cause as `loopsum`, except the modulo lives
inside a lifted `__cb_*` callback the intra-body numeric pass didn't reach.

**Series 105 (module-wide integrality lattice, #90)** closed it: a greatest-fixpoint
proves an element/param integer *across* call sites and iterator stages — the push-loop
counter is integer, `map` preserves it, `filter` inherits it — so the predicate's `v % 5`
lowers to a hardware `(v as i64) % 5` inside the callback body. With that, `arraypipe`
moves from the *loses* column to a **win in both dimensions**: **steady-state ~1.4ms
(2.9× Bun, 5.7× Node)** and **end-to-end 5.5ms (4.4× Bun, 23.4× Node)**, RSS **7.4MB** vs
Bun 58MB — byte-identical throughout. The lattice only specializes a value it *proves*
integer; a fractional source, an upstream `/`, or a single fractional call site leaves the
modulo `f64` (no truncation). The accepted `i64` divergence (past 2⁵³) is documented in
`docs/DIALECT.md`.

**`strbuild`** — the last workload to flip — taught the *same lesson* a second time. Its build
loop `s = s + "abc" + (i % 10)` lowered to `s = format!("{}{}{}", s, …)` — a fresh buffer +
full copy of the accumulator each iteration, `O(n²)`. **Series 106 (in-place string append,
#88 sub-task 2a)** fixed exactly that: the self-append rebind now emits
`write!(s, "{}{}", "abc", …).unwrap()`, appending through the accumulator's
`std::fmt::Write` impl (amortized-O(n), and it even composes with #90's integer-domain
modulo). But — as with `arraypipe` — the headline cost was elsewhere: isolating the halves,
the whole build loop is **~1ms of compute** (a build-only binary runs in 4.6ms e2e, barely
over the 3.6ms startup floor), while the **300-round `s.split("5")` scan is ~99ms** — it
materializes a `Vec<String>` of thousands of one-char heap `String`s every round. So 2a is a
real O(n²)→O(n) win (strbuild e2e **~138ms → 103ms**, steady **~135ms → 99.4ms**) but does
**not** flip the workload. **Series 107 (borrow-yielding/lazy `split`, #88 2c)** then streamed
the scan's `split` — a non-empty-separator `split` consumed by a non-retaining for-of now
emits Rust's native `str::split` (borrowed `&str`, zero allocation) instead of materializing
a `Vec<String>` of thousands of pieces per round. On a **clean** split-scan shape that is a
decisive win: the new `splitscan` workload (split + for-of that *reads* each piece) is
**1.6× steady / 1.7× e2e vs Bun, RSS 1.6MB vs 63MB (40×)**.

But — the *fourth* time this lesson recurs — 2c did **not** flip `strbuild` (still steady
81.4ms / 0.2×, e2e 83.6ms / 0.4×). Isolating strbuild's scan loop into two native probes
(startup floor 3.4ms) shows the split was never the bottleneck: **split-only 18.0ms e2e
(~14.6ms compute), `indexOf("789")`-only 72.8ms (~69ms compute)**. The pre-2c note "~99ms is
the split scan" was itself unmeasured — it conflated the split with the `s.indexOf("789")`
sitting next to it (a full ~80KB substring search returning −1, ×300). So strbuild's real
cost is **substring search** (`tslib::string::index_of` vs Bun's native `indexOf`) — a
separate item, filed as **#92**. 2c did shave strbuild ~18ms (the removed `Vec<String>`).
All tracked under perf epic **#86**. **Lesson kept, and paid for again:** measure the halves
before claiming a workload is fixed — `splitscan` is the honest witness for 2c, not `strbuild`.

**Series 108 (#92) closed the `indexOf` gap and flipped `strbuild`.** `tslib::string::index_of`
opened by collecting the *whole* haystack into a `Vec<char>` on every call, then hand-scanning
char windows — for strbuild's 300 × `s.indexOf("789")` over ~80KB that is the ~69ms. The
rewrite routes the search through Rust's native `str::find` (memchr, allocation-free) and
converts the byte offset back to a char index (byte-identical, char-vs-UTF-16 divergence
preserved). With it, **`strbuild` moves to a win**: e2e **83.6ms → 21.3ms (1.6× vs Bun)**,
steady **99.4ms → 17.7ms (1.1× vs Bun)**, RSS 1.6MB. But the dedicated, *hoist-proof*
`strsearch` workload keeps the story honest: raw substring search is **still a loss vs Bun**
(e2e 0.6×, steady 0.3×; a win only vs Node), because JSC's `indexOf` out-searches `str::find`
on a short needle whose first byte recurs often. So #92 killed the *allocation* pathology (that
is what flipped `strbuild`) — the raw-throughput gap vs JSC is a separate, lower-priority
residual (a `memchr::memmem` follow-up), not the bug it set out to fix. **First draft of
`strsearch` was worthless** (a fixed `from` let Bun's JIT hoist the invariant search out of
the loop — 387µs vs TTR's real 30.8ms); deriving `from` from the loop counter is what makes it
measure search, not hoisting.
