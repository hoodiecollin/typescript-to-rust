# 015 — Arrow functions: a top-level `const f = (…) => …` → a free `fn`

## Problem

TypeScript's arrow function is a second way to write a function. A module-scope
`const sub = (a, b) => …` binds a callable to a name; used only as a named,
top-level definition it is semantically a plain function — no `this` rebinding
matters, and (in the fixture) it captures nothing. Rust's closest idiomatic form
is a free `fn`, not a closure `let sub = |a, b| …`: a free `fn` participates in
the existing ownership analysis, call-site borrow adaptation, and fallibility
exactly as a `function` declaration does, and needs no capture reasoning. The
`03_functions/02_arrow.ts` fixture is the smallest case (still `test.todo`):

```ts
const sub = (a: number, b: number): number => {
  return a - b;
};
```

The target compiles and behaves (verified with `cargo`):

```rust
fn sub(a: f64, b: f64) -> f64 {
    return a - b;
}
```

## Scope (decided 2026-07-02)

**In:** a **top-level `const` bound to a non-`async` arrow function** — the only
arrow shape that maps soundly to a free `fn`. Both body forms:

- **Block body** (`=> { … }`) → the fn body verbatim.
- **Expression body** (`=> expr`) → a one-statement body `{ return expr; }` (a
  trivial desugar; the canonical arrow form).

The mechanism is a **normalization**, not a new IR node: before analysis,
`lower()` rewrites each qualifying `const f = <arrow>` top-level statement into a
synthetic `FunctionDeclaration` (id = the binding name, params/returnType/async
from the arrow, body = the block or the desugared `return`). Everything
downstream — `analyzeModule` (ownership, mutability, fallibility, `asyncFns`),
`lowerFunction`, the emitter — then treats it **identically** to a `function`
declaration. No HIR change, no emitter change, no analysis-shape change.

**Deferred — own later series (documented, fail-loud, not silently handled):**

- **A `let`/`var`-bound arrow** — a reassignable function binding is a variable
  holding a callable, not a definition; it needs a closure/`fn`-pointer local, not
  a free `fn`. Only `const` normalizes; a `let`/`var` arrow stays an expression
  and is rejected (`lowerExpr` default).
- **An arrow in value position** — passed as an argument, returned, nested inside
  another function/arrow body, or in any expression that is not a top-level
  `const` initializer. These are local closures (capture, `Fn`/`FnMut` traits) —
  a separate concern. Rejected fail-loud.
- **An `async` arrow** (`const f = async () => …`) — rides the async-arrow
  deferral noted in series 014; rejected (only non-`async` arrows normalize).
- **A capturing top-level arrow** — an arrow that references a `main`-local
  binding (top-level `const x` lowers to a `let` inside `main`, not a module
  `const`) would emit a free `fn` referencing an out-of-scope name. No fixture
  captures; a capturing arrow is caught by the cargo oracle (an
  undefined-name error), not silently mistranslated. A lowering-time capture
  check is a later refinement (belongs with the closure series).
- **Multiple declarators** (`const f = …, g = …`) — only a single-declarator
  `const` normalizes; anything else stays an expression and is rejected.

**Out:** closures as first-class values, `this`-capturing arrows, generics on
arrows, destructuring/rest params (the same gap as `function` declarations).

## Design

### AST (`ast.ts`)

Add `ArrowFunctionExpression` and add it to the `Expression` union. Verified
against the parser: `(a, b) => { … }` parses with `async`, `params:
Identifier[]` (same shape as a `FunctionDeclaration`'s), `returnType?`, `body`
either a `BlockStatement` or an `Expression`, and `expression: boolean` (true iff
the body is an expression).

```ts
export interface ArrowFunctionExpression extends Span {
  type: "ArrowFunctionExpression";
  async: boolean;
  params: Identifier[];
  returnType?: TSTypeAnnotation | null;
  body: BlockStatement | Expression;
  expression: boolean;
}
```

### HIR / Emitter / Analysis — unchanged

A normalized arrow *is* a `FunctionDeclaration`. `HirFn`, the emitter, and the
`ModuleAnalysis` shape are untouched. This is the point of normalizing rather
than adding an IR node.

### Lowering (`lower.ts`) — the normalization

- New `normalizeArrows(program): Program` — maps `program.body`, rewriting each
  qualifying top-level statement:
  - `VariableDeclaration`, `kind === "const"`, exactly one declarator, whose
    `init` is a **non-`async`** `ArrowFunctionExpression`
  - → a synthetic `FunctionDeclaration`: `id` = the declarator's identifier,
    `params`/`returnType`/`async` from the arrow, `body` = the arrow's
    `BlockStatement` as-is, or `{ return <expr>; }` for an expression body.
  - Every other statement passes through unchanged.
- `lower()` runs `validate(program)` first (unchanged — the same type nodes),
  then `const normalized = normalizeArrows(program)`, then feeds `normalized` to
  `analyzeModule` and the item loop. Because normalization precedes analysis, a
  normalized arrow's parameter ownership and call-site borrows are inferred, and
  calls to it adapt their arguments, exactly as for a `function`.

A non-normalized arrow (async, `let`/`var`, value position, nested) remains an
`ArrowFunctionExpression` and reaches `lowerExpr`'s `default` → `UnsupportedError`
— the existing fail-loud path, now the documented deferral boundary.

## Limits (documented, not silently handled)

- **Only a single-declarator top-level `const` non-`async` arrow normalizes.**
  Every other arrow shape is rejected.
- **No capture analysis.** A top-level arrow that references a `main`-local
  binding is caught by cargo, not by the gate (a later refinement).
- **Expression-body arrows require a return annotation** to type-check (the same
  annotation requirement as `function` declarations; enforced by the oracle, a
  validator concern).

## Verification

- **Unit (cargo-free):** `tests/arrow.test.ts` drives `emit(…)` — a block-body
  arrow → a free `fn` (ARROW1), an expression-body arrow → `{ return expr; }`
  (ARROW2), a normalized arrow called from the script with argument adaptation
  (ARROW3), a non-arrow program unchanged (ARROW4, green control), and three
  fail-loud rejections — an `async` arrow (ARROW5), a `let`-bound arrow (ARROW6),
  and a nested/local arrow (ARROW7).
- **Oracle (cargo-backed):** flip `03_functions/02_arrow` to `SUPPORTED` (tier 1:
  COMPILES, as a library — one free `fn`). Add a tier-2 differential: a block-body
  arrow and an expression-body arrow, both called from `main`, asserting Rust
  stdout equals the TypeScript's (`7\n9`).

## Workflow note

Full spec-first: docs → scaffold (the `ArrowFunctionExpression` AST node and a
`normalizeArrows` **seam** — it detects a qualifying arrow and throws
`UnsupportedError` "arrow normalization pending", wired into `lower()` — so specs
are **RED**) → **RED** → replace the seam with the real synthesis to **GREEN** →
archive. Closures as values, `async`/`let` arrows, and capture analysis each get a
**new** series.
