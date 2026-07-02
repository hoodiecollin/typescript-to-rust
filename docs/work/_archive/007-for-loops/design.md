# 007 — Control flow (cont.): C-style `for`

## Problem

Series 006 shipped `if`/`else`/`while`. The control-flow queue continues with the
C-style **`for`** loop (`02_control_flow/03_for_loop`, still `test.todo`):

```ts
for (let i: number = 0; i < 5; i = i + 1) { total = total + i; }
```

Rust has **no** C-style `for` — its `for` is `for pat in iterator`. So a
`ForStatement` cannot map one-to-one; it must be **desugared**.

## Scope (decided 2026-07-02)

**In:** lower `ForStatement` by desugaring to a scoped `while`:

```
for (init; test; update) body
  ⟶  { init; while (test) { …body; update; } }
```

- `init` — a `let` declaration (`VariableDeclaration`) or an expression, lowered
  as-is; `null` → omitted.
- `test` — the loop condition; `null` → `true` (Rust `while true`).
- `update` — appended as the **last** statement of the loop body; `null` →
  omitted.
- The whole thing is wrapped in a **block** so the loop variable's scope is
  contained (no leak into the enclosing scope), which needs a new HIR `block`
  statement.

This desugaring is **general** — it handles any C-`for`, not just the canonical
counter — and reuses the series-006 `while` node and block-bodied emitter.

**Deferred — own later series (documented, not silently handled):**

- **Idiomatic range** (`for i in 0..5`) — a *recognition optimization* over the
  canonical `let i = a; i < b; i = i + 1` shape. The `while`-desugar is correct
  and general; range emission is a follow-up that strictly improves output, not
  correctness.
- **`for…of`** (`04_for_of_loop`) and **`switch → match`** (`05_switch`) — their
  own slices (iterator borrows; match arms + fall-through), unchanged from 006.
- **`break`/`continue`** — still deferred. Note the desugar is **only sound
  without `continue`**: a `continue` would skip the appended `update` and change
  semantics. The `break`/`continue` slice must revisit this (e.g. emit a real
  Rust `for`/range, or hoist the update) — called out here so it is not a silent
  trap.

**Out:** `i64`/idiomatic counters — a `for` counter stays `f64` (compiles, prints
identically), same as a `while` counter.

## Design

### HIR — one new statement kind

```ts
export type HirStmt =
  | … (let | return | expr | if | while)
  | { kind: "block"; body: HirStmt[] };   // a bare, scope-containing `{ … }`
```

A `block` renders as `{\n …\n}` (the existing emitter `block()` helper) and, as a
statement, needs no trailing `;`. It is the scope container the `for` desugar
wraps its `init` + `while` in; it is also a useful primitive on its own.

### Lowering (`lower.ts`)

`lowerFor` builds the desugar; the `ForStatement` case replaces the seam throw:

```ts
function lowerFor(stmt, analysis, scope): HirStmt {
  const init = stmt.init
    ? stmt.init.type === "VariableDeclaration"
      ? lowerVarDecl(stmt.init, analysis, scope)
      : [exprStmt(lowerExpr(stmt.init, analysis))]
    : [];
  const body = lowerBlock(stmt.body, analysis, scope);
  if (stmt.update) body.push(exprStmt(lowerExpr(stmt.update, analysis)));
  const cond = stmt.test ? lowerExpr(stmt.test, analysis) : { kind: "bool", value: true };
  return { kind: "block", body: [...init, { kind: "while", cond, body }] };
}
```

Scope is threaded unchanged — mutability stays name-based per function, so the
loop variable's `mut`-ness (it is reassigned by `update`) is picked up by the
existing analysis walk (see analysis.ts). `ForStatement` is added to `ast.ts`.

### Emitter (`emitter.ts`)

One `emitStmt` case: `case "block": return block(stmt.body);` — reusing the
shared helper. Exhaustiveness over `HirStmt` is preserved.

### Numeric pass (`numeric.ts`)

`flattenStmts` descends into a `block`'s `body` (so index refinement reaches
inside the desugared loop); `eachStmtExpr` needs no `block` case (a block has no
direct expressions — its statements are flattened).

## Limits (documented, not silently handled)

- **`while`-desugar, not idiomatic range** — output is
  `{ let mut i = 0.0; while i < 5.0 { …; i = i + 1.0; } }`, not `for i in 0..5`.
  Correct and general; range emission is the deferred optimization.
- **Unsound with `continue`** — deferred; see Scope. No shipped fixture uses it.
- **Counter stays `f64`** — same as `while`; `i64`/index refinement unchanged.
- **Name-based scope** — the `block` contains the loop var in the *emitted* Rust,
  but analysis is still name-based per function (no per-block shadowing), as in
  006.

## Verification

- **Unit (cargo-free):** `tests/for_loop.test.ts` drives `emit(…)` and asserts
  the desugared structure — a wrapping block, the hoisted `let mut i`, the
  `while` with the `update` as its last body statement (FOR1–FOR5), plus a green
  control.
- **Oracle (cargo-backed):** flip `02_control_flow/03_for_loop` to `SUPPORTED`
  (tier 1: COMPILES) and add a tier-2 differential — a summing loop — asserting
  Rust stdout equals the TypeScript's (`10`).

## Workflow note

Full spec-first: docs → mock (HIR `block` + emitter land; `lower.ts` keeps a
`ForStatement` seam throwing `UnsupportedError` "for-loop lowering pending", so
the specs are RED) → **RED** → real `lowerFor` to GREEN → archive. `for…of`,
`switch`, `break`/`continue`, and range-optimization each get a **new** series.
