# 033 — Value-position closures over arrays (the 027 gate)

> **Status: FIRST SLICE LANDED.** Specs: `packages/compiler/tests/closures.test.ts`.
> This is the "hard gate" the 025-plan and 029 catalog call out — the prerequisite
> for 027's array-iteration methods.

## Scope (first slice)

A single-parameter arrow passed to an array's `map`/`filter`/`forEach` lowers to a
Rust iterator chain. First slice targets `Array<number>` (Copy elements), which
makes the `&`-destructuring patterns sound:

| TS | Rust |
|---|---|
| `xs.map(x => e)` | `xs.iter().map(\|&x\| e).collect::<Vec<_>>()` |
| `xs.filter(x => c)` | `xs.iter().filter(\|&&x\| c).copied().collect::<Vec<_>>()` |
| `xs.forEach(x => s)` | `for &x in xs.iter() { s }` |

## Mechanism

- **`iterMap` / `iterFilter` HIR exprs** (`hir.ts`) carry `{ receiver, param, body }`;
  the emitter renders the chain. `map`/`filter` are recognized in `lowerCall`'s
  method branch (before the generic method lowering) when the sole argument is an
  `ArrowFunctionExpression`.
- **`forEach` is a statement**, so it's recognized in `lowerStatement`'s
  `ExpressionStatement` case (`tryForEach`) and lowered to the existing `forIn`
  HIR statement with a `&param` pattern and a `receiver.iter()` iterator.
- **`arrowExprClosure`** extracts a single-param, expression-bodied (or single
  `return`) arrow's param + lowered body. `forEach` additionally accepts a block
  body (a sequence of statements).
- Captures fall out of Rust's closure capture (an outer `factor: number` is Copy,
  captured by copy) — spec-verified.

## The `&`/`&&`/`copied` patterns

`.iter()` yields `&T`. `map(|&x| …)` copies the element out (T: Copy). `filter`'s
predicate receives `&Item` = `&&T`, so `|&&x|` binds `x: T`; the surviving `&T`
items are then `.copied()` to owned `T` for `collect`. For a non-Copy element type
these fail loud at the oracle (`cargo`) — the first slice is numeric arrays.

## Deferred (fail-loud today)

- Index/array closure params (`map((x, i) => …)`), multi-statement `map`/`filter`
  bodies, non-Copy (e.g. `String`) elements (need `.cloned()` + move-aware binding).
- `reduce`/`find`/`some`/`every`/`flatMap` (029 Tier-1 iteration) — same closure
  machinery, follow-on slices.
- Closures in non-method value positions (a closure stored in a binding or passed
  to a user function — needs `Fn`/`FnMut` trait plumbing + capture analysis).
- `.collect()` into a non-`Vec` target (e.g. a `HashMap`).

## Feeds

This unblocks the 029 Tier-1 Array-iteration row (Dep: `cl`) and is the closure
prerequisite 027 (`tslib`) builds its native-vs-`tslib` iteration routing on.
