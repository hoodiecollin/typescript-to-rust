# 037 — Ownership analysis: CFG + backward liveness (the real engine)

> **Status: 037a + 037b LANDED (archived).** Epic: GitHub issue #1
> (`hoodiecollin/typescript-to-rust`, label `ownership`). Decision on file
> (2026-07-06): build the **full CFG + dataflow now**, not the staged-heuristics
> path. This series replaced the straight-line `refineMoves` (series 034) with a
> proper control-flow-graph + liveness dataflow, and folded struct derives in.
>
> **037a** — `refineOwnership` (`src/ownership.ts`): CFG + backward liveness
> replacing the heuristic; loop back-edges + branch joins handled. Specs:
> `tests/ownership-cfg.test.ts` (7). All 034 cases preserved. **037b** — the
> `structDeriveClause` helper (`src/derives.ts`, `Clone` + `Debug`) + folding
> `struct` into the movable set; `refineOwnership` reordered to run last. Specs:
> `tests/struct-derives.test.ts` (6).
>
> **Still open under epic #1** (later series): partial moves, move-out-of-borrow,
> move-through-store; the `PartialEq`/`===` semantics decision is issue #28.

## Why this exists / what changes

`refineMoves` today (`src/ownership.ts`) is a straight-line, document-order pass
that uses **last *textual* use** as a proxy for last *dynamic* use. That proxy is
wrong exactly where control flow bends:

- **Loops** — a value moved in a loop body but live across the back-edge looks
  like a last use (one textual occurrence), so no clone is placed → cargo `E0382`.
- **Branch joins** — a value moved on one branch and used after the join, or moved
  on *both* branches and used after, isn't reasoned about per-path.

The straight-line pass's saving grace — and the invariant this series
**preserves** — is that it only ever *adds* clones and only when it can prove a
later use; everything it can't prove stays a bare move that **cargo rejects
loudly**. So the pass can never miscompile. **This epic does not fix correctness
bugs — the fail-loud floor is already safe. It raises the ceiling: accept more
valid programs (fewer cargo rejections) and emit fewer needless clones.** Cargo
remains the backstop throughout, which is what lets us land the engine
incrementally without ever risking a silent miscompile.

The precise question "does this move need a clone?" is a textbook **liveness**
query: *insert `.clone()` at a move of binding `x` iff `x` is live immediately
after the move* (some path — including a loop back-edge — reaches a later use of
`x` before it is re-bound). Liveness is a backward dataflow over a CFG. That is
the engine we build here.

## Scope of this series (first engine slice)

**In:**
1. A **CFG** built structurally over each HIR body (`fn`, method, ctor, `main`).
2. **Backward liveness** dataflow to fixpoint over that CFG.
3. **Clone placement** at every move site whose moved-from binding is live-out
   (subsuming and deleting the straight-line heuristic).
4. **Struct derives (`Clone`, `Debug`)** via a gated `deriveClause` helper: emit
   `#[derive(Clone)]` on plain data structs / class structs whose fields are all
   cloneable (folding `struct` into the movable set so struct moves participate),
   and `#[derive(Debug)]` (near-universally eligible) so `console.log(struct)` can
   render — the derive that unblocks the whole-struct-printing deferral (issue #22).

**Out (still fail-loud / cargo-backstopped, later slices under epic #1):**
- Partial moves (moving `s.field` out of a struct).
- Move-out-of-borrow, reborrow splitting.
- `Rc`/arena *escape* (already the `use rc` / `use arena` directives' job).
- Any place the analysis is unsure → bare move → cargo error (never a wrong value).

## The CFG

HIR bodies are **structured** — the only non-lexical edges are `break`/`continue`,
and both are lexically scoped to the nearest enclosing loop. So we build the CFG
by a **syntax-directed** recursion rather than a generic goto-solver.

**Node.** A basic block = a list of *program points* (statement / sub-expression
positions where a use or move happens), plus successor edges. We don't need SSA or
fine intra-expression ordering beyond "uses before the move at the same site."

**Builder shape.** `buildCfg(body): { entry, exit }`, recursively, threading two
loop targets (for `break` → loop exit, `continue` → loop header/continue-point):

| HIR stmt | CFG edges |
|---|---|
| straight-line (`let`, `expr`, `return`, `throw`) | one block, falls through; `return`/`throw` edge to the body exit (no fallthrough) |
| `if cond { c } else { a }` | cond block → both branch entries; branch exits → join block (`alt: null` ⇒ the empty else edges straight to join) |
| `while cond { b }` | header(cond) → body entry and → exit; body exit → header (back-edge); `break`→exit, `continue`→header |
| `forRange` / `forIn` | header → body and → exit; body exit → header; the iterable/range bounds evaluate once at header; `break`/`continue` as `while`. For `forIn`/`forRange` the loop *variable* is a fresh binding each iteration (not a move of an outer value) |
| `block { b }` | inline sub-CFG, fall through |
| `match disc { arms }` | disc block → each arm entry; arm exits → join (arms terminate today, but model the join generally) |
| `tryCatch` | `tryBody` is emitted as an IIFE closure — treat it as its **own** nested body (its own CFG/liveness), then `catchBody` and `finallyBody` sequence after; a binding moved *into* the closure is a move at the enclosing point |
| `break` / `continue` | edge to the threaded loop exit / header; no fallthrough |

The back-edge is the whole point: it makes a use at the top of a loop body
**live-out** at the bottom, so a move inside the loop of an outer binding is
correctly cloned.

## The dataflow: backward liveness

Standard gen/kill backward liveness over the CFG, per body:

- **Domain:** sets of *movable binding names* (params + `let` bindings whose type
  is cloneable-movable — see below). Non-movable names are irrelevant.
- **use(n)** (gen): a movable name **read** at point `n` — an `ident` read, an
  owned/borrowed use, a receiver, etc.
- **def(n)** (kill): a movable name **bound / re-bound** at `n` (`let x = …`, and
  we treat the moment of a move as *not* a def — the binding still names the value
  until reassigned; a fresh `let x` shadowing kills the old liveness).
- **Transfer:** `liveIn(n) = use(n) ∪ (liveOut(n) − def(n))`;
  `liveOut(n) = ⋃ liveIn(succ)`.
- **Fixpoint:** iterate to convergence (loops need ≥2 passes; a worklist keeps it
  linear-ish). Monotone, finite lattice ⇒ terminates.

**Clone placement.** At each **move site** (defined exactly as series 034: a `let`
whose init is a bare movable ident, or an owned call/ctor argument that is a bare
movable ident — now also permitting `struct`-typed movables), insert `.clone()`
iff the moved-from binding is in `liveOut(moveSite)`. The last dynamic use on every
path is thus left a bare move; a move that any path re-reads is cloned. This is
strictly more precise than last-textual-use and is correct across loops and joins.

**Shadowing fix (free win).** Because `def` kills liveness and we key by the
binding introduced at each `let`, an inner-scope shadow no longer aliases the outer
binding's liveness (the flat name-set bug called out in 034's Deferred).

## Struct derives — a gated `deriveClause` helper

**Principle (governs all struct-gen going forward): derive on-demand, never
speculatively.** Each derive is gated on (a) an actual feature that needs it and
(b) field-type *eligibility* — because a derive we add that fails to compile
(`#[derive(Hash)]` on an `f64` field, `#[derive(Copy)]` on a `String` field) is
fail-loud pointing the wrong way (us breaking a valid program). This mirrors the
existing enum logic, which derives `Clone, Copy, PartialEq` only because a `switch`
guard needs comparison.

**The helper.** Introduce `deriveClause(struct, analysis): string` — computes the
*eligible* derive set from field types and returns `#[derive(...)]\n` (or `""`).
Today it returns **`Clone` + `Debug`**; every future trait is one predicate added
here rather than scattered emitter edits. `emitStruct` (and the struct half of
`emitClass`) prepends its result. Error-class structs (022) keep their hand-written
impls and are unchanged.

- **`Clone`** — emitted when every field type is cloneable (transitively:
  scalars/`String`/`Vec`/`HashMap`/nested cloneable `struct`). A struct with a
  non-cloneable field gets no `Clone` and stays out of the movable set (its moves
  stay bare → cargo-loud).
- **`Debug`** — emitted near-universally (all in-dialect field types are `Debug`).
  Unblocks `console.log(struct)` → `println!("{:?}", …)` (the whole-struct-printing
  deferral, issue #22). The actual `println` lowering of a struct arg is #22's
  scope; 037b only guarantees the derive is present.

**Fold `struct` into `isCloneableMovable`.** Add `struct` (name-resolved to its
field set via `analysis`) to the cloneable predicate, so struct moves become
eligible for the liveness-driven clone — but only when the struct actually got the
`Clone` derive (same eligibility test), keeping the two in lockstep.

**Deliberately *not* derived here** (each its own gated predicate later, when its
feature lands): `PartialEq`/`Eq` (⚠️ semantic — TS object `===` is *identity*, Rust
`==` is *structural*; a `needs-user-input` decision, filed separately — not decided
in 037), `Hash`+`Eq` (struct `HashMap`/`Set` keys, issue #21), `PartialOrd`/`Ord`
(struct sort/compare, issue #10), `Copy` (an optimization that interacts with this
very ownership pass — a moved value staying usable), serde `Serialize`/
`Deserialize` (JSON, issue #26).

Ordering note: enums already derive `Clone, Copy` (Copy ⇒ no clone needed — they
fall out of the movable set naturally). `Rc`/arena bindings are produced by the
*later* `refineRc`/`refineArena` passes, so they never appear as movable structs
here.

## Wiring

`refineMoves` → **`refineOwnership`**, now run **last** — after
`refineRc`/`refineArena`, not before (a 037b change; see below). Public surface:
the pass stays a single `HirModule → HirModule`. `src/ownership.ts` grows the CFG +
liveness; the move-site collection and `cloneOf` helpers are reused.

```
refineOwnership(refineArena(refineRc(refineStrings(refineNumerics(mod))), …))
```

**Why ownership runs last (037b).** Once structs are movable (037b), a class-typed
alias `const b = a` in a `"use rc"` scope is a move the clone pass would rewrite to
`a.clone()` — stomping the `Rc::clone` that `refineRc` produces. Running ownership
*after* the directive passes means it sees the HIR with the directives' ownership
model already imposed: an `rc` alias is already `Rc::clone` (not a bare move) and an
arena `Vec` is already un-annotated (`ty: null`, so not movable), so the clone pass
leaves both alone and only fills the remaining plain-move gaps. (037a shipped with
ownership *before* the directives; that was safe only because structs weren't yet
movable — 037b surfaced the ordering and fixed it.)

## Fail-loud contract (unchanged, restated)

The pass still **only adds clones**. If the liveness result is ever too
conservative (keeps something live that dynamically isn't) the cost is a *needless
clone* (slower, still correct). If it's ever too permissive we'd risk a bare move
that's actually used — but liveness is a *may*-analysis (union at joins,
fixpoint over back-edges), so it over-approximates live-ness, i.e. it errs toward
*more* clones, never fewer. Worst realistic case remains a **cargo error**, never a
wrong value. This is the property that keeps epic #1 safe to build in slices.

## Test strategy (specs.md — to be written next)

Differential oracle, per the workflow. RED cases the straight-line pass **cannot**
pass but this engine must:

- **Loop-carried move** — a `String`/`Vec` moved inside a `while`/`for` body and
  read again next iteration → must clone; behaves + compiles.
- **Branch-join reuse** — moved in an `if` branch, read after the join → clone;
  moved on *both* branches, read after → clone on both.
- **No needless clone** — a move that is genuinely the last use stays bare (assert
  the emitted Rust has no `.clone()`).
- **Struct move + reuse** → `#[derive(Clone)]` present, clone placed, behaves.
- **Struct with a non-cloneable field** → no `Clone` derive, move stays bare,
  cargo-loud (fail-loud preserved).
- **`Debug` derive present** on emitted data/class structs (asserts
  `deriveClause` includes it; the `console.log(struct)` lowering itself is #22).
- **Regression** — every existing `ownership-clone.test.ts` case still green.

## Open sub-questions for review

1. **Explicit basic-block CFG vs syntax-directed transfer functions.** For a
   structured IR the two give *identical* precision; the syntax-directed form is
   far less code (no block materialization) but a materialized CFG generalizes to
   future analyses (definite-init, borrow regions). Decision recorded as: **build
   the explicit CFG** per the "full CFG" call — but flagging that we could get the
   same liveness result with less machinery if you'd rather keep it lean.
2. **Series size.** This is large for one series. **Decided: split.** **037a** =
   CFG + liveness replacing the heuristic (loops + joins); **037b** = struct derives
   (`deriveClause` → `Clone` + `Debug`, `struct` into the movable set). Independent
   and each separately testable. The `===`→structural-`==` (`PartialEq`) question is
   **out of both** — filed as its own `needs-user-input` issue.
