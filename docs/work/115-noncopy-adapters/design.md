# 115 — Non-Copy element adapter chains: reduce / forEach / chained receivers

Issue **#96** (`deferral-graduation`, series-057 residual). Surfaced by series 112 while
splitting #88's consumer tails. Array adapter chains over a **non-Copy element type**
(`string[]`, `object[]`) don't lower today; this graduates the fail-loud residual.
**Pure dialect/codegen — no new dialect surface** (the accepted split-streaming nodes
already exist).

## The three fail-loud holes (from the map)

1. **`reduce` over non-Copy** — `liftCallback` (`closures.ts:369-374`) rejects when
   `!isCopyRustType(elemType) && arity !== 1`. `reduce`'s callback is arity-2
   `(acc, elem)`, so it is *always* rejected on a non-Copy element, e.g.
   `parts.reduce((acc, p) => acc + 1, 0)` →
   *"reduce over a non-Copy element type — element borrowing is only wired for
   map/filter/find/some/every"*.
2. **Chained / inferred non-Copy receiver** — `elementTypeOf` (`expressions.ts:1520-1542`)
   can't resolve the element type of an adapter/`split` result, so
   `parts.map(…).reduce(…)` and `s.split(sep).map(…)` throw *"cannot lift callback:
   receiver element type unknown"*.
3. **`forEach` over non-Copy** — `tryForEach` (`expressions.ts:1749-1788`) hardcodes the
   Copy-element ref pattern `for &p in …` (line 1787); a `&str`/`String` element can't
   bind an unsized `str` through `&p`.

Element-use classification (`classifyElementUse`, borrow `&T` vs owned-`clone`
`elemMode`) already exists and is reused unchanged — the holes are purely in *where the
lift is allowed* and *what iteration pattern is emitted*.

## Design

### 1. `reduce` over non-Copy — relax the arity guard

The `arity !== 1` guard in `liftCallback` exists because the Copy fast-path assumes a
single element param. Generalize it: a non-Copy element is bound **by borrow** (`&T`,
the existing `elemMode: "borrow"`) regardless of arity. For `reduce`:

- accumulator: by value / owned, type from `initType` (existing `iterReduce` machinery,
  `expressions.ts:1298-1329`);
- element: `&T` (no `copied()`/deref). The emitter's `iterReduce`
  (`emitter.ts:2266-2270`) currently derefs `*b` for the Copy path — gate that on
  `elemMode`: Copy → `*b`, borrow → bind `&T` directly. `.fold(init, |acc, p| …)` where
  `p: &String`.

The accumulator must itself be a supported type (f64, String, bool, …); an owned-`String`
accumulator folding non-Copy elements is the common case (`parts.reduce((a,p) => a + p, "")`)
and is in scope. A non-Copy **accumulator that also needs clone-on-read** stays whatever
the existing accumulator machinery already supports — no regression.

### 2. Chained / inferred non-Copy receiver — teach `elementTypeOf`

Extend `elementTypeOf` / `receiverTypeOf` (`typing.ts:319`, `expressions.ts:1520`) to
resolve the element type of an **adapter or split result** receiver:

- `xs.map(f)` result element = the callback's return type (already known at the lift
  site) — thread it so a following `.reduce`/`.filter`/… can resolve its element.
- `s.split(sep)` result element = `String` (a `str`/`String` piece).

This makes `parts.map(…).reduce(…)` and `s.split(sep).map(…)` resolve their element type
instead of hitting "receiver element type unknown".

### 3. `forEach` over non-Copy — borrowed iteration pattern

Branch `tryForEach` (`expressions.ts:1749-1788`) on element Copy-ness:

- Copy element → `for &p in xs.iter()` (unchanged);
- non-Copy element → `for p in xs.iter()` binding `p: &T` (no `&` in the pattern).

The callback body already reads the element through `classifyElementUse`, so a borrowed
binding is consistent with map/filter's element handling.

### 4. Re-open #88's split adapter/forEach tail

With 1–3 landed, `s.split(sep).map/filter/reduce/forEach` **lower** (materialized
baseline). That unblocks the split-streaming tail deferred by series 112: teach
`refineSplitLazy` (`split-lazy.ts:42`) to stream the fused chain head over an eligible
`split` — swap the head source to `strSplitIter`, guarded on `recvIter !== "own"` (the
fused-iter handshake with `refineIterFusion`, `iter-fusion.ts:44`). This is the "for
free" payoff the issue calls out.

## Outcome (2026-07-24)

- **Done (in):** non-Copy `reduce` (borrowed element via `elemMode` on `iterReduce`;
  f64 / owned-`String` accumulator); non-Copy `forEach` (`for p in …`); element-type
  resolution through a **`split`** receiver so `s.split(sep).map/reduce/forEach` lift
  (the case #96/#88 own). Plus a small `typeCbBody` enhancement: `+` with a
  provably-String operand types `String` (so a String-accumulator reduce compiles) —
  a numeric `+` whose operand isn't statically typeable (`acc + p.length`) stays `f64`.
  Specs `noncopy-adapters.test.ts` **7/7** green.
- **Handed off, not deferred:**
  - **`X.map(cb).reduce(…)` and other adapter *chains*** (a non-`split` adapter feeding
    another) fail one layer up in **adapter-result element typing** — a **Copy-agnostic**
    gap (`xs.map(x=>x*2).reduce(…)` fails identically). Filed **#100**. Resolving it needs
    a *side-effect-free* adapter-result element typer (it can't lower the callback inside
    the pure `elementTypeOf` query), so it is its own design, not part of #96's non-Copy
    borrowing.
  - **Split adapter/forEach *streaming*** (task 4 — swap the materialized
    `tslib::string::split(…).iter()` head to native lazy `str::split`) is the **#88 perf
    tail**, not a correctness graduation: the adapters now **lower and are
    differential-correct** (they materialize a `Vec<String>`, exactly as `string[]` means
    today). Streaming them is `refineSplitLazy` surgery sharing the 107/112 guards and
    belongs to **#88** ("re-open #88" per the issue). Tracked there.
- **Out:** non-Copy elements requiring an **owned move out of the iterator** where the
  "no silent clone" guard (`closures.ts`) refuses — that guard stays. `object[]` element
  **field mutation** through an adapter (a distinct ownership question) is not part of
  this codegen graduation.

## Risks

- **Borrow vs owned in `reduce`:** `acc + p` where `acc: String, p: &String` needs
  `acc + p` / `acc + &p` / `acc.push_str(p)` shaped correctly by the existing string
  concat lowering — verify the concat path accepts a `&String` rhs (it does for
  `&str`). A spec pins the owned-`String` accumulator case.
- **Split re-open regressions:** the 107/112 split-lazy guards are shared; re-run
  `split-lazy.test.ts` + `split-consumers.test.ts` to confirm streaming the adapter head
  doesn't regress the iteration/count/index consumers.
