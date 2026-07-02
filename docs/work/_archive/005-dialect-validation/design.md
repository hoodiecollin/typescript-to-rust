# 005 — Dialect validation: reject `any` / `unknown`

## Problem

The pipeline (plan.md) names **step 2 — dialect validation — reject anything
outside dialect.md, FAIL LOUD** — but it does not exist as a distinct step.
Today, forbidden input is caught only incidentally by lowering: `const x: any =
1` reaches `lowerType`, falls through to the `default`, and throws
`UnsupportedError` — the *same* error used for constructs the dialect intends but
the emitter hasn't built yet (control flow, classes, …).

That conflation is wrong. `dialect.md` draws a hard line:

- **Forbidden** — `any`/`unknown`, dynamic object manipulation, escaping shared
  mutable aliasing, class inheritance. These will *never* be accepted.
- **Deferred** — control flow, records, `interface`/`class`, `throw`/`try`,
  `async` — *in* the dialect, not yet implemented.

A user who writes `any` should be told "this is outside the dialect" (fix your
input), not "not implemented yet" (wait for a release). This slice introduces the
validator seam and the distinct error, enforcing the most central prohibition.

## Scope (decided 2026-07-02)

**In:** a dedicated validation pass that rejects **`any` and `unknown`** type
annotations anywhere they appear (variable, parameter, return type, and nested
type arguments like `Array<any>`), with a new `DialectError` distinct from
`UnsupportedError`.

- New pass `validate(program): void` in `src/validate.ts`, run as the **first
  step of `lower()`** — the single entry every path (CLI, `emit`) goes through —
  so it is pipeline step 2 in effect.
- New error class `DialectError` ("forbidden by the dialect"), re-exported from
  `lower.ts` and `emitter.ts` alongside `UnsupportedError` ("not yet
  implemented"). The two now mean distinct things.

**Deferred — own validator slices (documented, not silently handled):**

- **Missing annotations** (the "explicit type annotations" requirement) — needs
  the trivial-literal exception (`const n = 5`) and a return-type audit of
  existing fixtures; untyped *parameters* already throw in lowering (kept as-is
  for now). Its own slice.
- **Class inheritance** (`extends`) — trivial AST check, but classes are not
  lowered at all yet (they throw `UnsupportedError`); a dedicated
  inheritance-`DialectError` lands with the class slice.
- **Dynamic object manipulation** (add/delete props, monkey-patching) and
  **escaping shared mutable aliasing** — semantic checks that need shape/alias
  analysis; they arrive with data structures and the ownership generalization.

**Out:** rewriting existing `UnsupportedError` sites. Only `any`/`unknown` moves
from "unsupported" to "forbidden"; everything else keeps its current error.

## Design

### The seam

```ts
// src/validate.ts
export class DialectError extends Error { … }
export function validate(program: Program): void   // throws DialectError, or returns
```

`lower()` calls it first:

```ts
export function lower(program: Program): HirModule {
  validate(program);          // step 2: reject forbidden input, fail loud
  const analysis = analyzeModule(program);
  …
}
```

A standalone pass (not folded into the `lowerType` recursion) keeps the
forbidden/deferred distinction crisp and gives the validator room to grow —
future rules (inheritance, dynamic shapes, missing annotations) slot into the
same walk without touching lowering.

### The check

Walk the whole program AST; on any `TSAnyKeyword` or `TSUnknownKeyword` type
node, throw `DialectError` naming the offending keyword. A generic node walk
(the same shape `analysis.ts` uses) finds them wherever they nest — top-level
annotations, parameter/return types, and inside `Array<…>` type arguments.

### Error semantics

- `DialectError` — input is **outside the dialect** and always will be. The fix
  is the user's (`dialect.md`).
- `UnsupportedError` — construct is **in** the dialect but not yet implemented.
  Unchanged.

Both fail loud; they differ in what they tell the user to do.

## Limits (documented, not silently handled)

- Only `any`/`unknown` are enforced this slice. The other forbidden categories
  and the missing-annotation requirement remain future validator slices.
- The trivial-literal-initializer exception is not exercised (no annotation
  enforcement here), so it needs no implementation yet.

## Verification

- **Unit (cargo-free):** `tests/validate.test.ts` drives the public `emit(...)`
  entry (proving the whole pipeline rejects) and asserts `DialectError` for
  `any`/`unknown` in variable, parameter, return, and nested-type-argument
  positions, and that a fully-annotated valid program does **not** throw
  (specs V1–V6).
- No new compile/behave fixture: a *rejected* program produces no Rust to check,
  so the oracle here is "the pass throws `DialectError`", asserted at unit level
  through `emit`.

## Workflow note

Full spec-first workflow: docs → mock (`validate.ts` — `DialectError` real, but
`validate` a no-op, so `any` still throws the *wrong* error and the RED specs
fail) → **RED** specs against the mock → real `validate` to GREEN → archive.
