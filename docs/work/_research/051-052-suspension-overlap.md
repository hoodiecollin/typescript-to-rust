# Research spike — 051 (async concurrency) ↔ 052 (generator state machines): where do they overlap?

**Status:** research/design spike (not a series). Prerequisite to the 051→052
sequence. Answers the three questions the sequence plan posed, then recommends
sequencing. Ends with two items that need Collin's input.

**Method:** read both design docs + specs, then ground every claim in the current
lowering code (`lower.ts`, `analysis.ts`). Anchors are cited so the conclusions are
checkable, not asserted.

---

## TL;DR

The intuition behind bundling 051 and 052 was that both are "suspension-point
transforms" and might share a CFG + live-variable subsystem. **The code does not bear
that out.** The two series are mechanically disjoint:

- **052 hand-builds a state machine** (CFG + liveness across `yield` → `struct` +
  `impl Iterator` + `match self.state`) **because Rust gives us no stable coroutine
  surface for `Iterator`.** This CFG+liveness pass is genuinely new and used by nobody
  else.
- **051 builds no state machine at all.** An `async fn` is compiled into its own
  `Future` state machine *by rustc*; rustc also captures live-across-`await` locals for
  free. 051 is a **combinator-mapping + ownership** series (map `Promise.all`→`join!`,
  un-awaited call→`spawn`, shared state→`Arc<Mutex>`). Its one novel analysis — 051c's
  task-escape pass — is an **inter-body capture/ownership** analysis that **reuses the
  #9 free-var set** (`freeVarsOf`, `lower.ts:3247`), *not* a CFG or a liveness pass.

So there is **no "shared suspension CFG" to build once.** The genuine shared seams are
narrower (and 051 shares them with #9/#14/#49, not with 052 — see §3). The real
intersection the "async generators" example points at is a **third, future thing**
(`async function*` → `Stream`) that sits on top of *both* subsystems — and that is the
only place a "design them together" decision actually pays off (§4).

**Recommendation:** build 051 and 052 **independently, in the planned order (051 then
052)** — there is no shared-infra win from interleaving them. Do 052 with **one
forward-looking factoring discipline** (§5) so a future async-generator series can reuse
its CFG+liveness+field-carry passes by swapping only the emit template. Keep
`async function*` fail-loud in both (it already is; nothing regresses). Two things need
Collin before impl starts: the **#14 prerequisite ordering** for 051a, and (later, not
now) the **async-generator `Stream` encoding** (hand-rolled `poll_next` vs the
`async-stream` crate).

---

## The two "suspensions" side by side

| | **052 generator (`yield`)** | **051 async (`await`)** |
|---|---|---|
| Who builds the resumable state machine? | **We do.** Hand-rolled: CFG + liveness → `struct { state, …fields }` + `impl Iterator` with `loop { match self.state }` (052 design, "Worked example"). | **rustc does.** An `async fn` *is* the CPS transform; the compiler emits the `Future` state machine. We emit ordinary `async`/`.await` and never see it. |
| Suspension primitive emitted | `self.state = k; return Some(v);` (the new `yieldReturn` HIR stmt) | `.await` (today: `lowerAwait`, `lower.ts:2876`, emits a `{kind:"await"}` / `{kind:"try", …}` node) |
| Live-across-suspend locals | **We must find + carry them** — backward liveness → struct fields (052 design, "CFG + liveness"). Load-bearing query: *is a local live across any `yield`?* | **rustc captures them automatically** into the generated Future. We do zero liveness work for `await`. |
| Novel analysis this series adds | **Intra-function** CFG + live-variable analysis (a new subsystem in `analysis.ts`). | **Inter-body** task-escape/capture analysis (051c) — *which bindings a spawned closure captures*, reusing #9's free-var set; decides `move` vs `Arc` vs `Arc<Mutex>`. |
| Output contract | `impl Iterator<Item = T>` (unchanged from 035) | `async fn` / implicit `Future` (unchanged from 014/016) |
| New crate? | **None.** Pure std `Iterator`. | `futures` (051b dynamic fan-out) + tokio `"time"` feature (051b timers). `join!`/`select!`/`spawn` are tokio macros, no new crate (051a/051c). |

The asymmetry in row 1 is the whole story: **Rust's `async`/`await` already is the
coroutine surface that `Iterator` lacks.** That is why 051 can be "just" surface mapping
+ ownership while 052 has to hand-roll the machine. They are not two instances of one
pattern; they are one pattern the compiler gives us for free (async) and one it does not
(generators).

---

## Q1 — Is there shared CFG/liveness machinery worth building once?

**No.** Concretely:

- **051 needs neither a CFG nor liveness.** Sequential `await` is already a single HIR
  node (`lowerAwait`, `lower.ts:2876`). The combinators (051a/b) are local rewrites of a
  `Promise.all([...])` / `.then(cb)` / `arr.map(f)` call shape — no control-flow graph is
  built. 051c's task-escape analysis walks a *spawned callback's* free-var set to decide
  ownership; that set is already computed by the #9 lambda-lift (`freeVarsOf`,
  `lower.ts:3247`; `liftCallback`, `lower.ts:3386`). It is a capture/aliasing question
  ("does this binding cross into a concurrently-running body, and is it mutated /
  multiply-captured?"), answered over free-var sets — not a backward dataflow over a CFG.
- **052's CFG + liveness is intra-function and single-purpose.** It exists solely to
  decide *which locals become struct fields* and *what the resume-state numbering is*
  (052 design, "What becomes a struct field", "State numbering"). Nothing else in the
  compiler consumes a basic-block graph or live-in/live-out sets today, and 051 would not
  start.

There is no third caller that would justify a general-purpose CFG library, and the two
series' analyses answer different questions over different inputs. Building a shared
abstraction first would be **speculative generality** — we would design it against one
real consumer (052) and one imagined one (051, which turns out not to want it).

---

## Q2 — Async generators = `Stream`: what would `async function*` actually need?

This is the real intersection, and it is a *future* series, not part of 051 or 052.
Today `async function*` is a hard `DialectError`, and **both** 051 and 052 keep it
fail-loud (051 design "Fail-loud residuals"; 052 design "Fail-loud residuals",
"async generators (`async function*` → `Stream`, out of std)"). So the spike's job here
is to chart the path, not build it.

An `async function*` is **both** a generator (yields a sequence → a state machine) **and**
async (awaits between yields → a `Future` at each step). Its Rust target is
`futures::Stream` (`poll_next(cx) -> Poll<Option<T>>` — the async analog of
`Iterator::next`). Producing one needs, jointly:

1. **052's CFG + liveness across suspend points** — a `Stream` still suspends at `yield`
   *and* at `await`, so live locals must still be carried across both. This is exactly
   052's subsystem, extended so an `await` is also a suspend point (not just `yield`).
2. **051's async surface** — the awaits inside the body, and the `futures` crate
   (`Stream` lives in `futures`, the crate 051b already adds).

Two encodings, and they mirror the async-vs-generator asymmetry above:

- **(a) Hand-roll `impl Stream`** — extend 052's machine to emit `poll_next(&mut self,
  cx: &mut Context) -> Poll<Option<T>>` instead of `next() -> Option<T>`, threading
  `Context`/`Poll` and driving inner futures to readiness at each `await` point. This is
  **substantially harder than 052's `Iterator`** (manual `Poll` plumbing, pinning), and
  it is the sync-hand-roll philosophy carried forward.
- **(b) Adopt `async-stream`'s `stream! { … yield x; … y.await … }` macro** — this gives
  us the coroutine surface for streams the way `async fn` gives it for futures, reducing
  async-gen to *surface mapping* (like 051) instead of hand-rolled CPS (like 052). Cost:
  a new crate (`async-stream`), and a **philosophical divergence** — 052 deliberately
  hand-rolls the *sync* `Iterator` (per the #19 DECISION, Collin chose the full state
  machine over pulling a coroutine crate). Using a macro crate for async but hand-rolling
  sync is defensible (std has no stream coroutine at all, whereas the sync hand-roll was a
  deliberate choice) — but it is a dialect/dependency-shape call.

**Finding:** async generators are tractable *after* both 051 and 052 land, and they are
the one place the two subsystems genuinely compose. The encoding decision (a vs b) is a
`needs-user-input` dialect/dep call — deferred to that future series, flagged here so 052
can be factored to keep option (a) cheap (§5).

---

## Q3 — Does the `futures` dep seam cover both?

**Partly — it covers the trait, not the ergonomics.**

- 051b adds `futures = "0.3"` via the Cargo-dep injection seam (reused from 049; 051
  design "Cargo manifest additions"). `futures::Stream` is in that **same crate**, so an
  eventual async-gen series needs **no additional crate** if it hand-rolls `impl Stream`
  (encoding a).
- If async-gen instead adopts the `stream!` macro (encoding b), that is a **separate**
  crate (`async-stream = "0.3"`) on top of `futures`. So the dep footprint depends
  entirely on the a-vs-b decision from Q2.
- 052 itself adds **no** crate (pure std `Iterator`), so there is no dep overlap between
  051 and 052 to coordinate — only between 051 and the *future* async-gen series.

Net: the `futures` seam 051b introduces is the foundation async-gen builds on; whether
async-gen touches the manifest again is gated on the encoding choice, not on 051 or 052.

---

## The seams that ARE shared (and who actually shares them)

Worth naming precisely, because they are real — just not shared between 051 and 052:

| Seam | Where it lives | 051 | 052 | Note |
|---|---|---|---|---|
| **#9 free-var / lambda-lift** | `freeVarsOf` `lower.ts:3247`, `liftCallback` `lower.ts:3386`, `liftedFns`/`liftCounter` (`analysis.ts:187`) | **Heavy** — `.then` cb, `Promise.all(arr.map(f))`, spawn body, `setTimeout` body; 051c's task-escape reuses the free-var set | **None** — a generator body is not a lifted callback | Shared between **051 and #9/#14**, not 052 |
| **Cargo-dep injection** | seam from 049 (`.scratch/Cargo.toml`) | **Yes** — `futures`, tokio `"time"` | **No** | Shared between **051 and #49/future async-gen**, not 052 |
| **Fallibility fixpoint** | `analyzeFallible` `analysis.ts:687`, `fallible` set | **Yes** — `try_join!`/`try_join_all`/`?` (051a/b) | **No** — generators aren't fallible in-dialect | Shared between **051 and #16**, not 052 |
| **CFG + liveness across suspend** | *new in 052* (`analysis.ts`) | **No** | **Yes (sole owner)** | Reused only by a **future async-gen** series (Q2/§5) |

**The one seam 051 and 052 both touch is the `#[tokio::main]` / async-runtime-entry
decision** (`lower.ts:224`) — and only trivially: a program that uses either does not
change how the other decides its entry point. No coordination needed.

---

## Recommendation

1. **Build 051 and 052 independently, in the planned order: 051 then 052.** No
   shared-infra-first win exists (Q1). 051 first unblocks the higher-demand concurrency
   surface; 052 is a self-contained subsystem that lands cleanly after. This **confirms
   the existing sequence plan** — the spike does not imply a re-order.

2. **Factor 052 for future reuse (the one "design them together" action — §5).** Keep
   052's CFG-block→state-number mapping, across-suspend field set, and state-arm bodies
   *generic over the suspend primitive*, so async-gen can reuse the passes and swap only
   the emit template + suspend node. Near-zero cost to 052; preserves the cheap-hand-roll
   option for async-gen.

3. **Keep `async function*` fail-loud in both series.** It already is; both designs list
   it as a residual. Nothing regresses. Async generators become their own future series,
   designed after 051+052 land, carrying the a-vs-b encoding decision from Q2.

4. **Settle the #14 prerequisite before 051a.** 051 assumes #14 (async methods/arrows)
   has landed the async-arrow-as-named-fn machinery, because a `.then` / `Promise.all(
   arr.map(f))` callback is an async arrow (051 design "Coupling"). Today `asyncFns`
   tracks free functions only and `lowerMethod` rejects `async` (`lower.ts:1745`). This is
   a genuine ordering question for Collin (below).

---

## §5 — The one concrete cross-series design constraint on 052

When 052 introduces `HirGenerator` (052 design "New HIR + emitter"), shape it so the
suspend primitive is a **parameter of the emit template, not baked into it**:

- Represent the machine as **(ordered fields incl. `state`) + (ordered state arms of
  `HirStmt[]`) + (a suspend node carrying `value` + `resumeState`)** — already the plan.
  Just keep the suspend node's *kind* nameable (`yieldReturn`) so a sibling
  (`streamYield` → `Poll::Ready(Some(v))`) can be added without touching the CFG/liveness
  passes.
- Keep the CFG + liveness passes (`analysis.ts`) **agnostic to whether the machine emits
  `next` or `poll_next`** — they answer "what's live across a suspend point"; a suspend
  point being a `yield` vs an `await` is the emitter's concern, not the analysis's.

This is a naming/factoring discipline, not extra code, and it is the entire payoff of
having looked at 051 and 052 together: async-gen (encoding a) reuses 052's analysis
wholesale and only writes a new `poll_next` template.

---

## Needs Collin's input (per the "get input before dialect-shape decisions" rule)

1. **#14 ordering vs 051a. — DECIDED (Collin, 2026-07-08): land #14 first as its own
   series.** The revised sequence is **#14 → 051 → 052**. 051a therefore assumes the full
   async-arrow-as-named-fn + async-method machinery is present, and gets all its shapes
   (incl. `.then` / `arr.map(f)`) at once. No 051a scope is deferred for the prerequisite.

2. **(Later, not now) async-generator `Stream` encoding.** When async-gen graduates:
   hand-roll `impl Stream`/`poll_next` (encoding a — no new crate, consistent with 052's
   hand-roll, harder) vs adopt the `async-stream` `stream!` macro (encoding b — new crate,
   surface-mapping ergonomics, a philosophical split from the sync hand-roll). Flagged now
   so 052's factoring (§5) keeps option (a) cheap; the decision itself belongs to that
   future series.
