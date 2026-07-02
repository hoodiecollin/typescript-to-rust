# 009 — Control flow (finale): `switch → match` + `break`/`continue`

## Problem

Series 006–008 shipped `if`/`else`/`while`/`for`/`for…of`. Two constructs remain
to close out control flow (the last `02_control_flow` fixture is `05_switch`):

```ts
function matchNum(x: number): string {
  switch (x) {
    case 1: return "one";
    case 2: return "two";
    default: return "other";
  }
}
```

and `break`/`continue`, which the loop slices deferred. They are **coupled** here
deliberately: `break` is JavaScript's `switch`-case terminator, so the two
features meet at the point where a case body's trailing `break` must be handled,
and `break`/`continue` must be validated against the loop lowerings 006–008 left
behind.

## Scope (decided 2026-07-02)

**In — `switch → match`:**

- Lower `SwitchStatement` to a Rust `match` over the discriminant. Because the
  discriminant is `f64` (and Rust **forbids floating-point literal patterns**),
  arms are **guarded wildcards**: `case v =>` becomes `_ if <disc> == v => { … }`,
  and `default =>` becomes `_ => { … }`. This is correct for any discriminant that
  supports `==` (numbers, and later strings), sidestepping float-pattern illegality.
- **No fall-through** (Rust `match` has none): each case must terminate with
  `break` or `return`. A trailing `break` is the case terminator and is
  **stripped**; a `return` is kept. A non-terminating, non-final case → fall-through
  → `UnsupportedError`.
- A synthetic `_ => {}` catch-all is appended when the `switch` has no `default`,
  so the `match` is exhaustive (JS runs nothing when nothing matches).

**In — `break`/`continue`:**

- `BreakStatement`/`ContinueStatement` → HIR `break`/`continue` → Rust
  `break;`/`continue;`. Sound in `while`, `for…of`, and (for `break`) the C-`for`
  desugar — a `break` in the `while`-desugar exits the loop, exactly as the
  `for` would.

**Deferred — own later series (documented, not silently handled):**

- **`continue` inside a C-style `for`** — the 007 desugar `{ init; while test {
  body; update } }` runs `update` at the body's end, but `continue` jumps to the
  condition and would **skip** it: unsound. `lowerFor` **rejects** an own
  `continue` (one not inside a nested loop) with `UnsupportedError`. The fix is a
  labeled-block desugar (`'step: { body }`, `continue` → `break 'step`, then
  `update`) — its own series. `break`/`continue` in `while`/`for…of` and `break`
  in `for` are unaffected.
- **Literal / or-pattern arms** — idiomatic `match x { 1 => …, 2 | 3 => … }` for
  integer/string discriminants (and stacked empty cases `case 1: case 2:`) is a
  refinement over guarded wildcards; empty/stacked cases currently throw.
- **Labeled** `break`/`continue` (`break outer;`) → `UnsupportedError`.
- **Non-trailing `switch` breaks** (a `break` not at a case's end, e.g. inside a
  nested `if` in the case) are not stripped; they lower to a Rust `break` and, if
  not inside a loop, fail the cargo oracle (fail-loud, not silent). Documented.

## Design

### HIR — three new statement kinds

```ts
export interface HirMatchArm {
  guard: HirExpr | null;   // `disc == case`; null = the wildcard `_` (default)
  body: HirStmt[];
}
export type HirStmt =
  | … (let | return | expr | if | while | block | forIn)
  | { kind: "match"; disc: HirExpr; arms: HirMatchArm[] }
  | { kind: "break" }
  | { kind: "continue" };
```

### Lowering (`lower.ts`)

- **`lowerSwitch`** — lower the discriminant once; for each `SwitchCase`, lower
  its `consequent`, enforce the terminator rule (strip trailing `break`, keep
  `return`, reject a non-terminating non-final case, reject an empty case), and
  build an arm. A `case` → `{ guard: disc == test, body }`; `default` →
  `{ guard: null, body }`, emitted last. Append `_ => {}` if no `default`.
- **`break`/`continue`** → `[{ kind: "break" }]` / `[{ kind: "continue" }]`;
  a labeled `break`/`continue` throws.
- **`lowerFor` guard** — before desugaring, walk the `for` body for an *own*
  `continue` (stopping at nested loops); if found, throw `UnsupportedError`
  (deferred, see Scope).

`SwitchStatement`, `SwitchCase`, `BreakStatement`, `ContinueStatement` are added
to `ast.ts`.

### Emitter (`emitter.ts`)

- `match` → `match <disc> {\n  <arm>…\n}` where each arm is
  `_ if <guard> => <block(body)>` (or `_ => <block(body)>`), indented one level.
- `break` → `break;`, `continue` → `continue;`. Exhaustiveness over `HirStmt`
  preserved.

### Numeric pass (`numeric.ts`)

`flattenStmts` descends into each `match` arm body; `eachStmtExpr` visits the
`disc` and each arm `guard`. `break`/`continue` carry no expressions.

## Limits (documented, not silently handled)

- **Guarded-wildcard arms**, not literal/or-patterns — a faithful, compiling
  `match`; idiomatic literal arms are a refinement.
- **Cases must terminate**; empty/stacked and non-final fall-through throw.
- **`continue` in a C-`for` throws** (unsound desugar); everything else is sound.
- **Labeled and non-trailing-`switch` `break`/`continue`** — unsupported /
  fail-loud as above.
- The discriminant is re-evaluated per guard arm (harmless for the identifier
  discriminants the dialect expects).

## Verification

- **Unit (cargo-free):** `tests/switch.test.ts` (SW1–SW5) asserts the guarded
  `match` shape, the stripped trailing `break`, the synthetic catch-all, and
  fall-through rejection; `tests/break_continue.test.ts` (BC1–BC5) asserts
  `break;`/`continue;` emission in `while`/`for…of`, and that a C-`for` `continue`
  throws. Each file carries a green control.
- **Oracle (cargo-backed):** flip `02_control_flow/05_switch` to `SUPPORTED`
  (tier 1: COMPILES), and add tier-2 differentials — a `switch` classifier, a
  `while` with `break`, a `while` with `continue`, and a `for…of` with `continue`
  — asserting Rust stdout equals the TypeScript's.

## Workflow note

Full spec-first: docs → mock (HIR `match`/`break`/`continue` + emitter land;
`lower.ts` keeps seams throwing `UnsupportedError` for `SwitchStatement`/
`BreakStatement`/`ContinueStatement`, so specs are RED) → **RED** → GREEN in two
focused steps (`switch`, then `break`/`continue` + the `for`-`continue` guard) →
archive. The deferred labeled-block `for`-`continue` desugar, literal-pattern
arms, and labeled jumps each get a **new** series when revisited.
