# 109 — Modularize `lower.ts` (kill the monolith)

Epic. Prerequisite to the plugin system (series **110**): the plugin
recognition/expansion hook must land in a *clean* module, not get bolted onto a
16k-LOC file. This series is split into **two independent epics** by design (see
"Two epics, on purpose"), and plugin work may begin the moment **Phase 1** lands
— it does not wait for Phase 2.

## Problem

`packages/compiler/src/lower.ts` is **16,462 LOC / 320 top-level functions** (verified
2026-07-23). It is the AST→HIR lowering stage: the widest, most-edited file in the
compiler and the one every dialect/codegen series has to reopen. It has grown by
accretion — every new language shape added its `lowerX` here — and it is now the single
biggest drag on comprehension and the riskiest place to make a change.

What it is *not*, happily, is a tangle:

- **State is threaded explicitly.** Nearly every function takes `analysis:
  ModuleAnalysis` (the ~58-field shared-context object in `analysis.ts`) as a
  parameter. There is **no closure-captured mutable module state** — the file is a
  flat namespace of functions over an explicit context. That is exactly the shape that
  extracts mechanically.
- **The dispatch is switch-based and total.** `lowerStatement`, `lowerExpr`,
  `lowerMember`, `lowerCall`, `lowerType` are `switch` hubs over AST `.type`. They
  partition cleanly by node family.

So the risk here is **scope discipline, not structure**. The danger is a "while I'm in
here" cleanup silently changing emitted output. The whole plan is built to make that
impossible to do by accident.

## Two epics, on purpose

We deliberately **do not blend** extraction with cleanup. They have different risk
profiles and different verification gates, so they are two separate epics tracked as
two issues:

| | **Phase 1 — Extraction (this epic, blocking)** | **Phase 2 — Cleanup & efficiency (separate epic)** |
|---|---|---|
| Goal | Break the monolith into a `lower/` folder-module. **Zero behavior change.** | Make the extracted modules clean/efficient/understandable. |
| Gate | **Byte-identical** emitted Rust across the whole corpus, per commit. | Behavioral identity (corpus still passes the cargo oracle); byte drift *allowed* where intentional and reviewed. |
| Moves | Pure relocation of functions + imports. No logic edits. | Refactor internals, dedupe, simplify signatures, tighten `ModuleAnalysis` coupling. |
| Unblocks | Series 110 (plugins) can start once this closes. | Nothing downstream depends on it. |

Rationale: extraction with a **byte-identical** gate is a *mechanical, reviewable,
reversible* operation — a reviewer can trust "the bytes didn't move" without re-reading
the logic. Cleanup inherently changes bytes, so it needs a human reading each diff for
intent. Fusing them would force every mechanical move through a semantic review and rob
the byte gate of its meaning. Keeping them apart also lets plugin work (110) begin
against the clean module layout **before** Phase 2's slower, judgement-heavy pass runs.

## Phase 1 — the target layout

A `lower/` **folder-module** (not a barrel). `index.ts` holds **real orchestration** —
`lower()`, `lowerCrate()`, and the refine-chain composition — so it satisfies the
no-barrel rule (it is functionality, not a re-export shim). Siblings import each other
directly.

```
packages/compiler/src/lower/
  index.ts            # lower(), lowerCrate(), refine-chain composition — the orchestrator
  utils.ts            # pure helpers (rid, indent-adjacent, small predicates) — extract FIRST
  constants.ts        # frozen tables / note strings
  statements.ts       # lowerStatement hub + statement-family lowerers
  expressions.ts      # lowerExpr hub + expression-family lowerers
  calls.ts            # lowerCall (the ~855-LOC hub) — extract LAST, most entangled
  method-routing.ts   # lowerMember + method dispatch  ← plugin hook lands here in 110
  arrows.ts           # arrow / closure lowering
  classes.ts          # class → struct+impl lowering
  generators.ts       # generator / iterator state-machine lowering
  try-carrier.ts      # try/catch → Result carrier
  unions.ts           # union-type lowering
  regex.ts            # regex literal lowering
  var-decl.ts         # variable declaration lowering
  object-literals.ts  # object literal lowering
  types.ts            # lowerType + type lowering
```

The external import surface does not change: `./lower` keeps resolving (to
`./lower/index.ts`), and **no importer elsewhere in the tree moves**. Everything is
internal to the folder.

### Extraction order (one commit each, byte-identical after every commit)

The order runs *leaves → hubs*, cheapest and safest first:

1. **Break the error-import cycles.** `numeric.ts` / `bitwise.ts` / `emitter.ts`
   back-import `DialectError`/`UnsupportedError` through `lower.ts` while `lower.ts`
   imports `refineNumerics`/`refineBitwise` from them — genuine import cycles that
   fight the extraction. Repoint those three src consumers at `./errors` directly.
   **Keep** the `lower.ts` re-export (`lower.ts:137`) as a labeled compat shim: ~30
   test files still `import … from "./lower"`, and dropping it would churn all of
   them for no extraction benefit. Migrating those test imports to `./errors` and
   removing the shim is a **Phase-2** cleanup candidate, not a Phase-1 blocker.
2. **`utils.ts`** — pure, dependency-free helpers. The first real extraction; proves the
   folder-module wiring end-to-end.
3. **`constants.ts`** — frozen tables / note strings.
4. **Cohesive leaves**, each its own commit: `regex` → `generators` → `try-carrier` →
   `unions` → `method-routing` → `arrows` → `classes` → `object-literals` → `var-decl`
   → `types`.
5. **Dispatch hubs last**: `statements.ts`, `expressions.ts`, then **`calls.ts`** (the
   most entangled — it reaches into nearly every leaf).

Each commit: `feat`/`refactor(lower): extract X`, one module, corpus diff to zero.

### The safety net — byte-identical corpus snapshot

Before any move, snapshot the emitted `.rs` for the entire corpus. After **every**
extraction commit, re-emit and diff against the snapshot; a non-empty diff is a bug in
the extraction, full stop (never "adjust the snapshot to match"). This is strictly
stronger than "tests pass": the cargo oracle proves the output *compiles and behaves*,
but the byte diff proves we changed *nothing at all*. A Phase-1 task is to wire this as
a one-command check runnable from repo root (e.g. `bun run lower:snapshot` /
`bun run lower:verify`).

## Phase 2 — cleanup & efficiency (separate epic, non-blocking)

Once Phase 1 closes, the folder is safe to actually improve, per module. Phase 2's
gate is behavioral, not byte-level: the corpus must still pass the cargo oracle, and
any intentional byte drift must be reviewed as such. (In practice the first-target
work below was all pure motion and stayed *byte-identical*, so `lower:verify` gated
it — stronger than required.)

### First targets — DONE (2026-07-23)

- **Re-home the parked lowerers.** Template-string (`lowerTemplate`/
  `lowerTemplatePart`/`TEMPLATE_SCALAR_ELEM`) and update (`lowerUpdateAssign`/
  `lowerUpdateValue`) lowering moved `types.ts → expressions.ts` (they lower
  expressions; Phase 1 only parked them in `types.ts` for a byte-clean cut).
- **Repoint siblings off the `./index` re-export hub.** All 13 siblings now import
  each lowerer from its owning module (`./expressions` / `./statements` / `./types`);
  the three forwarding re-export blocks + `export type { ClassFieldPlan }` are gone.
  `index.ts` exports only real orchestration surface (`lower`/`lowerCrate` + its own
  item/directive helpers). Genuinely index-owned symbols (`collectionOf`/
  `retargetStructKey`/`structKeyName`/`wrapKey`/`tryHashMapInsert`/`tryMapSetMethod`/
  `lowerMethod`/`lowerParam`/`programErrType`/`takeDirectives`/`TSTypeParamDecl`) stay
  sourced from `./index` — those are its own exports, not forwards.
- **Drop the error re-export shim.** The ~18 test files importing `DialectError`/
  `UnsupportedError` `from "../src/lower"` now import them `from "../src/errors"`;
  `index.ts`'s `export { DialectError, UnsupportedError }` is removed (it still
  imports them from `../errors` for its own throws).
- **Sub-seam splits (two).**
  1. The discriminated-union / `typeof` / `in` narrowing recognizers (a
     self-contained ~650-LOC cluster, every symbol internal to `statements.ts`,
     2 analysis fields) → **`narrowing.ts`** (690 LOC).
  2. The shared "light typer" — the expression-typing predicates (`receiverTypeOf`
     core + `optionExprType`/`structTypeOfOperand`/`paramTypeOfOperand`/string-ness
     predicates/`truthyCond`/`needsTruthy`/`registerOpBound`+`JS_OP_TRAIT`/string-
     method catalogs), imported by expressions/types/method-routing/closures/
     statements — → **`typing.ts`** (545 LOC). This was the interleaved seam
     flagged below as a follow-up; done by extracting the contiguous predicate range
     and relocating the one interleaved statement lowerer (`lowerNarrowedBlock`) back.

  `statements.ts` 3,727 → 2,573. The folder is now **19 modules**.

### Assessed & resolved (not deferred)

- **`ModuleAnalysis` surface reduction — rejected as architecturally blocked.** The
  measured per-module field usage is 42 (statements) / 36 (index) / 36 (expressions)
  / 23 (classes) of ~72 fields for the hubs — a `Pick<>` there is noise, not clarity.
  Every small-slice leaf (regex reads 2 fields, unions 3, types 6, …) *calls back
  into the hubs* (`lowerExpr`/`lowerType`/`lowerStatement`), so it must hold and pass
  the **full** `analysis` transitively — a narrowed type can't be handed to a hub that
  needs the whole object. Narrowing only "works" for pure leaves that never re-enter
  lowering, and there are none. Not worth the churn; the explicit-context-threading
  pattern stays.
- **Idiom dedup — no high-value target.** No top-level helper is duplicated across
  modules (nothing to lift into `utils`), and the switch-hub shape-matching is
  intentionally explicit — deduping the three `recognize*IfLadder` recognizers into a
  shared walker would obscure three distinct narrowing shapes for marginal LOC.

### Status

All Phase-2 first-target work + both viable sub-seams are done; the two open
cleanup categories are assessed-and-resolved (ModuleAnalysis rejected, idiom-dedup
empty). The folder is **19 cohesive modules**; the largest hubs are `statements.ts`
2,573 / `expressions.ts` 2,548 / `index.ts` 2,328 — all reasonable for dispatch
hubs. #94 is complete.

## Rejected alternatives

- **One big-bang split.** Rejected: no per-step byte gate means a regression can hide
  anywhere in a 16k-line move, and review is impossible.
- **Blend extraction + cleanup ("refactor as we go").** Rejected — the core reason for
  the two-epic split. It destroys the byte-identical gate's meaning and forces
  mechanical moves through semantic review.
- **Flat sibling files with a re-export barrel `lower.ts`.** Rejected: violates the
  no-barrel rule and hides the orchestration. `index.ts`-as-orchestrator is the
  sanctioned folder-module shape.
- **Extract hubs first (top-down).** Rejected: hubs depend on the leaves, so moving
  them first means dragging half the file along or leaving dangling imports. Leaves-first
  keeps every intermediate commit self-consistent and byte-clean.

## Progress (Phase 1, as of 2026-07-23) — core extraction COMPLETE

`lower.ts` (16,465) → `lower/index.ts`, now **2,379 LOC of pure orchestration**
(directives + items + `lower()`/`lowerCrate()`); the whole AST→HIR lowering body
lives in **16 byte-identical sibling modules**, every commit byte-identical +
typecheck-clean + zero unused-import residue (`tsc --noUnusedLocals`).

- **Infra:** `bun run lower:snapshot` / `lower:verify` (62-entry corpus, 1,324 lines
  of emitted Rust pinned); error-import cycles broken (`numeric`/`bitwise`/`emitter`
  → `./errors`); `lower/` folder-module scaffolded.
- **Leaf modules:** `constants.ts` (frozen tables incl. the shared `CB_GLOBALS`
  name-set), `utils.ts` (leaf helpers + the shared structural AST/HIR walks
  `collectRefs`/`rewriteFieldRefs`/`collectDeclaredLocals`), `regex.ts`,
  `unions.ts` (registration/coercion), `async.ts` (await/combinator/spawn),
  `method-routing.ts` (primitive method dispatch + string/number catalog — future
  plugin-hook home), `io-shim.ts` (std-I/O + @ttr/std + JSON/RNG), `collections.ts`
  (Map/Set/Date/new + Object statics).
- **Cluster modules:** `generators.ts` (~730 — state machine + straight-line fast
  path), `try-carrier.ts` (~1030 — throw / custom-error / try-catch `?`-carrier),
  `classes.ts` (~1150 — class/interface/enum family + trait synthesis),
  `closures.ts` (~530 — callback lifting), `arrows.ts` (~770 — pure AST→AST arrow
  normalization).
- **Dispatch hubs (leaf→hub, last):** `types.ts` (717 — `lowerType` hub + Map/Set
  key policy + template/update-assign/untyped-ternary), `expressions.ts` (2,416 —
  `lowerExpr` + `lowerCall` + `lowerMember` + inference/generator-resolution
  helpers), `statements.ts` (3,727 — `lowerStatement` hub + statement family +
  `lowerVarDecl` + typed-literal path + class-field planning + shared
  expression-typing predicates). Extracted in that order so each cut was
  byte-clean; all three cross-recurse via `./index` (safe — every reference is a
  call-time function, the same cyclic-safe pattern the leaf modules use).

The hub decision (the judgement-heavy tail) resolved to **the 3-way section split**
(`statements`/`expressions`/`types`), *not* one big `dispatch.ts` — the epic's goal
is to kill the monolith, and one 6.6k-LOC file only relocates it. The ~27-name
cross-section weave that made the split look heavy is bounded and cyclic-safe, so it
was a non-issue. The extraction protocol that worked: cut the contiguous section
verbatim → add `export` to the externally-referenced entry points → **`index.ts`
re-exports the shared lowering surface** so the ~13 siblings never change their
`from "./index"` imports (index stays a real orchestrator + re-export hub, not a
barrel) → source cross-hub lowerers directly from `./expressions`/`./types` →
prune dead imports via `tsc --noUnusedLocals` → gate on `typecheck` +
`lower:verify` (byte-identical).

## Scope / status

- **Phase 1 (blocking):** #93 — extraction to `lower/`, byte-identical gate.
  **Core extraction complete** — the monolith is fully dissolved into 16 sibling
  modules; `index.ts` is orchestration-only. Closing this unblocks series 110.
- **Phase 2 (non-blocking):** #94 — per-module cleanup, behavioral gate. **First
  targets DONE (2026-07-23):** parked lowerers re-homed (`types → expressions`),
  all 13 siblings repointed off the `./index` re-export hub (hub emptied), error
  re-export shim dropped (tests → `../src/errors`), and two sub-seams split out —
  `narrowing.ts` (disc-union/typeof/in recognizers) + `typing.ts` (the shared light
  typer); statements.ts 3,727 → 2,573, folder now **19 modules**. `ModuleAnalysis`
  narrowing assessed and **rejected** (architecturally blocked by transitive context
  threading); idiom-dedup assessed (no high-value target). #94 complete — see the
  Phase 2 section above for the full record.
