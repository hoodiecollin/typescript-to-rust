# 006 — Control flow: `if` / `else` and `while`

## Problem

The dialect intends control flow (plan.md "Next": `if`/`else`, `while`, `for`,
`for…of`, `switch → match`), but lowering implements **none** of it: every one of
`IfStatement`, `WhileStatement`, `ForStatement`, `ForOfStatement`,
`SwitchStatement` falls through `lowerStatement`'s `default` and throws
`UnsupportedError`. The five `02_control_flow/*` fixtures are all `test.todo`.

Control flow is also the blocker named elsewhere in the plan: nested-scope
shadowing (ownership generalization) and `i64`/`for`-counter numeric refinement
both wait on "no block scopes exist yet." This series introduces the first block
scopes.

## Scope (decided 2026-07-02)

Ship the **structural foundation** — the two constructs that need only a *block*
(a nested statement sequence) and a *condition*, and no desugaring, iterator, or
match machinery:

**In:**

- **`if` / `else if` / `else`** — `IfStatement` with an optional `alternate` that
  is either a block (`else { … }`) or another `if` (`else if …`). Lowers to a new
  HIR `if` statement; the emitter renders an `else if` chain idiomatically.
- **`while`** — `WhileStatement` → a new HIR `while` statement.

Both introduce **block bodies**: a braced, nested `HirStmt[]`. The emitter grows
one `block(stmts)` helper shared by `if`, `while`, and (already) function bodies.

**Deferred — each its own later series (documented, not silently handled):**

- **C-style `for`** (`03_for_loop`) — no direct Rust equivalent; needs desugaring
  to `while` (or range-detection to `for i in a..b`) plus init-binding scoping.
- **`for…of`** (`04_for_of_loop`) — needs an iterator-borrow decision
  (`for x in &arr` vs `.iter()`, element copy vs borrow) tied to the ownership
  pass.
- **`switch → match`** (`05_switch`) — needs match-arm modeling, fall-through
  **rejection** (a `DialectError`/`UnsupportedError` call), a `_` default arm, and
  the statement-vs-expression match question.

**Out:** `break`/`continue` (neither shipped fixture uses them; they land with the
loop-focused `for` slices). Nested-scope **shadowing** analysis stays out — the
shipped fixtures don't shadow, and name-based mutability already sees nested
assignments (see Limits).

## Design

### HIR — two new statement kinds

```ts
export type HirStmt =
  | { kind: "let"; … }
  | { kind: "return"; value: HirExpr | null }
  | { kind: "expr"; expr: HirExpr }
  | { kind: "if"; cond: HirExpr; then: HirStmt[]; alt: HirStmt[] | null }
  | { kind: "while"; cond: HirExpr; body: HirStmt[] };
```

`if.alt` is `null` for a bare `if`, a one-element `[{kind:"if"…}]` for `else if`,
or the else block's statements otherwise. Modeling the alternate as `HirStmt[]`
(not a nested block node) keeps the shape flat; the emitter recognises the
single-`if` alternate to print `else if` rather than `else { if … }`.

### Lowering (`lower.ts`)

Two new `lowerStatement` cases, replacing the `default`-throw seam:

- **`IfStatement`** → `{ kind:"if", cond: lowerExpr(test), then: lowerBlock(consequent), alt: lowerAlternate(alternate) }`.
- **`WhileStatement`** → `{ kind:"while", cond: lowerExpr(test), body: lowerBlock(body) }`.

`lowerBlock(node)` lowers a `BlockStatement`'s body (or a bare single statement)
to `HirStmt[]`, threading the **same scope key** — mutability is name-based and
per-function (see analysis.ts), so a binding declared or reassigned inside a
block is still looked up under the enclosing function's scope. `lowerAlternate`
returns `null`, a single-`if` array (else-if), or a lowered block.

The AST subset (`ast.ts`) grows `IfStatement` and `WhileStatement` node types.

### Emitter (`emitter.ts`)

A shared `block(stmts)` helper renders `{\n<indented>\n}` (or `{\n}` when empty),
factored out of `emitFn`. Two `emitStmt` cases:

- **`while`** → `while <cond> <block(body)>`.
- **`if`** → `if <cond> <block(then)>`, then when `alt` is present: `else if …`
  when `alt` is exactly one `if` statement, else `else <block(alt)>`.

The emitter stays pure and total: every branch of the `HirStmt` union is handled,
so TS exhaustiveness is preserved (adding the kinds without cases would fail to
compile — the guarantee we want).

### Numeric pass (`numeric.ts`)

`eachStmtExpr` currently visits only `let`/`return`/`expr`. Extend it to descend
into an `if`'s `cond` + `then` + `alt` and a `while`'s `cond` + `body`, so index
refinement keeps working inside control flow (e.g. `arr[i]` in a loop). No shipped
fixture needs this yet, but skipping it would be a silent gap the moment indexing
moves into a branch. `strings.ts` only inspects parameter signatures, so it is
unaffected.

## Limits (documented, not silently handled)

- **Counters stay `f64`.** `while (i < 10) { i = i + 1 }` emits an `f64` counter.
  It compiles and runs (Rust `Display` prints `10` for `10.0`, matching JS), just
  not maximally idiomatic. `i64`/index-counter refinement is the deferred numeric
  addition and is **not** in this slice.
- **No nested-scope shadowing.** Mutability is name-based across the whole
  function body, so a block-local binding that shadows an outer name would be
  conflated. The shipped fixtures don't shadow; the general fix is the deferred
  ownership series (still blocked until block scopes are modelled as real scopes,
  which this slice does not do).
- **No `break`/`continue`, no C-`for`/`for…of`/`switch`** — deferred as above.
- **Negative literals** (`-3`) are a `UnaryExpression`, still unlowered — an
  independent expression gap surfaced (not introduced) here; the differential
  spec uses `0 - 3` to stay in-dialect. Its own future slice.

## Verification

- **Unit (cargo-free):** `tests/control_flow.test.ts` drives the public `emit(…)`
  entry from TS source and asserts the emitted Rust's structure for `if` /
  `else if` / `else` and `while` (specs CF1–CF6), plus a green control that a
  control-flow-free program still emits.
- **Oracle (cargo-backed):** flip fixtures `02_control_flow/01_if_else` and
  `02_control_flow/02_while_loop` to `SUPPORTED` (tier 1: COMPILES), and add two
  tier-2 differential programs — a branch-per-sign classifier and a counting loop
  — asserting Rust stdout equals the TypeScript's.

## Workflow note

Full spec-first workflow: docs → mock (HIR + emitter shape land, but `lower.ts`
keeps an explicit `IfStatement`/`WhileStatement` seam that throws
`UnsupportedError` "control flow lowering pending" — so the pipeline specs are
genuinely RED) → **RED** specs against that seam → real lowering to GREEN →
archive. Follow-ups (`for`, `for…of`, `switch`, `break`/`continue`, counter
refinement) each get a **new** series.
