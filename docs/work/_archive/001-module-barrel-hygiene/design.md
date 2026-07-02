# 001 — Module & barrel hygiene

**Type:** pure refactor (behavior-preserving). Per the workflow, this needs a
design doc only — no new specs; the existing green suite is the safety net.

## Problem

Barrel/re-export files and unjustified single-file folders were creeping in,
against the standing rule: *no re-export barrels; folders-as-modules only when a
single file grows too large, and then `index.ts` must hold real functionality.*

Two violations:

1. `src/emitter/index.ts` — a folder containing exactly one file, with no
   sibling. The folder buys nothing; the flat files (`analysis.ts`, `hir.ts`,
   `lower.ts`, `ast.ts`) are the correct shape.
2. `src/harness/index.ts` re-exported three types from its sibling `cargo.ts`
   (`export type { CargoResult, RustDiagnostic, DiagnosticSpan } from "./cargo"`).
   A pure barrel line — and it had **zero external consumers**.

## Change

- Flatten `src/emitter/index.ts` → `src/emitter.ts`. Imports of `./src/emitter`
  resolve unchanged (Bun/TS resolve `emitter.ts` for `./emitter`). The file's own
  relative imports move up a level (`../hir` → `./hir`, etc.).
- Delete the re-export line from `src/harness/index.ts`. `harness/` stays a
  folder — its `index.ts` holds the real `RustProject` impl alongside sibling
  `cargo.ts`, which is exactly the justified case. Anything needing those types
  imports `./harness/cargo` directly (direct sibling import, not a barrel).

## Verification

Existing gates stay green: `bun run typecheck`, `bun run lint`,
`bun test packages/compiler` (23 pass / 12 todo / 0 fail). No behavior change,
no new specs.

## Note

The flatten momentarily broke `emitter.ts`'s `../`-relative imports (they were
correct only at the old nested path); `tsc` caught it as implicit-`any` +
missing-return rather than a clean "cannot find module". Consider tightening
`moduleResolution` so a bad relative import fails with TS2307 directly.
