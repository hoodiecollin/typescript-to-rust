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

Once Phase 1 closes, the folder is safe to actually improve, per module:

- Simplify signatures; reduce the `ModuleAnalysis` surface each module actually needs
  (today everything takes the whole ~58-field object — most modules use a slice of it).
- Dedupe the repeated shape-matching idioms the switch hubs accreted.
- Break `calls.ts` down internally if it is still too large after extraction.

Phase 2's gate is behavioral, not byte-level: the corpus must still pass the cargo
oracle, and any intentional byte drift must be reviewed as such.

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

## Scope / status

- **Phase 1 (blocking):** issue TBD — extraction to `lower/`, byte-identical gate.
  Closing this unblocks series 110.
- **Phase 2 (non-blocking):** issue TBD — per-module cleanup, behavioral gate.
