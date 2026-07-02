# 008 — Control flow (cont.): `for…of`

## Problem

Series 006–007 shipped `if`/`else`/`while`/`for`. Next in the control-flow queue
is **`for…of`** (`02_control_flow/04_for_of_loop`, still `test.todo`):

```ts
function sumArray(arr: Array<number>): number {
  let total: number = 0;
  for (const val of arr) { total = total + val; }
  return total;
}
```

Rust's `for` *is* `for pat in iterator`, so `for…of` maps far more directly than
C-`for` did — the real question is **how to borrow the iterable** so iteration
neither moves it nor forces the element type wrong.

## Scope (decided 2026-07-02)

**In:** lower `ForOfStatement` over an array to a Rust `for … in … { … }` that
**iterates by reference via `.iter()`**:

```
for (const val of arr) body   ⟶   for val in arr.iter() { …body }
```

- The loop binding (`const`/`let val`) becomes the Rust pattern name.
- The iterable is lowered and `.iter()` is called on it — a uniform, always-sound
  choice: `.iter()` borrows, so it works identically whether the iterable is an
  owned `Vec<T>` (local) or an already-borrowed `&Vec<T>` (a `ref` parameter,
  like the fixture), and never consumes it.
- The element binding is therefore `&T`. For the numeric fixture, `total + val`
  (`f64 + &f64`) compiles via std's reference-arithmetic impls
  (`impl Add<&f64> for f64`), so no explicit deref is needed.

A new HIR `forIn` statement (`for <pat> in <iter> { body }`) carries this; the
`.iter()` call is baked in during **lowering** (an ownership decision), leaving
the emitter a trivial renderer.

**Deferred — own later series (documented, not silently handled):**

- **Non-`&T` element ergonomics** — where `&T` is wrong for a body use (passing
  an element by value to a `T` callee, or non-`Copy` elements needing
  `.iter().cloned()` / `.into_iter()`), the choice needs the ownership pass. This
  slice handles the read/arithmetic case the fixture exercises; a body that
  demands owned elements is a follow-up.
- **Destructuring patterns** (`for (const [a, b] of pairs)`) — needs pattern
  lowering; a single-identifier binding only, else `UnsupportedError`.
- **Non-array iterables** — strings (chars), `Map`/`Set`, `.entries()`/index —
  await those data structures.
- **`break`/`continue`** — still deferred (shared control-flow slice).
- **Numeric refinement of the loop binding** — the `usize` pass retypes `let`
  bindings and params, not `for…of` patterns; a loop index used to index another
  array would not refine. No fixture needs it; documented.

**Out:** `for await…of` (async iteration) — arrives with `async`/`await`.

## Design

### HIR — one new statement kind

```ts
export type HirStmt =
  | … (let | return | expr | if | while | block)
  | { kind: "forIn"; pat: string; iter: HirExpr; body: HirStmt[] };
```

`iter` is the *already-borrowing* iterator expression (lowering sets it to
`<iterable>.iter()`, a `method` node), so the emitter renders
`for <pat> in <iter> <block(body)>` verbatim.

### Lowering (`lower.ts`)

`lowerForOf` replaces the seam throw:

```ts
function lowerForOf(stmt, analysis, scope): HirStmt {
  const decl = stmt.left;                    // VariableDeclaration `const val`
  const pat = decl.declarations[0].id.name;  // single identifier only
  const iter = { kind: "method",
                 receiver: lowerExpr(stmt.right, analysis),
                 name: "iter", args: [] };
  return { kind: "forIn", pat, iter, body: lowerBlock(stmt.body, analysis, scope) };
}
```

A non-`VariableDeclaration` left, or a non-single-`Identifier` binding, throws
`UnsupportedError` (destructuring/pattern deferred). `ForOfStatement` is added to
`ast.ts`. Scope threads unchanged (name-based per function).

### Emitter (`emitter.ts`)

One `emitStmt` case:
`case "forIn": return \`for ${stmt.pat} in ${emitExpr(stmt.iter)} ${block(stmt.body)}\`;`
— exhaustiveness over `HirStmt` preserved.

### Numeric pass (`numeric.ts`)

`flattenStmts` descends into a `forIn`'s `body`; `eachStmtExpr` visits its `iter`
(an index could sit in the iterable expression). The `pat` binding itself is not
retyped (documented limit above).

## Limits (documented, not silently handled)

- **Elements are `&T`.** Correct for read/arithmetic (the fixture); a body needing
  an owned element is deferred to the ownership-aware follow-up.
- **Single-identifier binding only** — destructuring throws `UnsupportedError`.
- **Arrays only** — other iterables await their data structures.
- **No `break`/`continue`; loop binding not numeric-refined** — as above.

## Verification

- **Unit (cargo-free):** `tests/for_of.test.ts` drives `emit(…)` and asserts the
  emitted `for val in arr.iter() { … }` shape and that the loop body nests
  (FOF1–FOF4), plus a green control.
- **Oracle (cargo-backed):** flip `02_control_flow/04_for_of_loop` to `SUPPORTED`
  (tier 1: COMPILES) and add a tier-2 differential — summing an array — asserting
  Rust stdout equals the TypeScript's (`6`).

## Workflow note

Full spec-first: docs → mock (HIR `forIn` + emitter land; `lower.ts` keeps a
`ForOfStatement` seam throwing `UnsupportedError` "for-of lowering pending", so
the specs are RED) → **RED** → real `lowerForOf` to GREEN → archive. `switch`,
`break`/`continue`, destructuring, and non-array iterables each get a **new**
series.
