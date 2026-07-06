# 032 — Nested / inferred struct literals (gap B)

> **Status: LANDED.** Closes gap B from series 030. Specs:
> `packages/compiler/tests/struct-literals.test.ts`.

## The gap

A struct object literal was only recognized at the **top level** of a
struct-typed binding (`lowerVarDecl` special-cased `ty.kind === "struct"` +
`ObjectExpression`). An *inline nested* literal or a struct literal *inside a
collection* fell through to `lowerExpr`, hit the bare-`ObjectExpression` branch,
and failed loud:

```ts
const l: Line = { start: { x: 0, y: 0 }, end: { x: 3, y: 4 } }; // inner {x,y} rejected
const pts: Array<Point> = [{ x: 1, y: 2 }];                      // element {x,y} rejected
```

The top-level literal knew its target type (`Line`); the inner literals had no
annotation, and lowering had no struct field-type table to consult.

## The fix

1. **`analysis.structFields`** — a `Map<structName, {name, ty}[]>` of each
   declared struct's (interface / non-error class, incl. parameter properties)
   field types. Built by a lenient pre-pass `collectStructFields` in `lower()`
   after analysis (it needs `lowerType`, so it can't live in `analyzeModule`).
2. **`lowerTyped(expr, ty, analysis)`** — lower an initializer *against a declared
   target type*, the single place that turns a literal into the right Rust shape
   by context:
   - `struct` + object literal → a `structLit`, **recursing** into each field
     via its declared type (looked up in `structFields`);
   - `hashmap` + object literal → `HashMap::from([…])`;
   - `vec` + array literal → `vec![…]` with each element lowered against `elem`;
   - anything else → a plain `lowerExpr`.
3. `lowerVarDecl` now calls `lowerTyped(init, ty, analysis)`; `lowerStructLiteral`
   uses it for each field value. Recursion falls out — a two-level nest and a
   `Vec<struct>` of literals both work.

## Specs (all differential — compile + stdout match)

- Inline nested struct literal (`Line { start: Point { … } }`) → `3`.
- Two-level nest (`Path → Seg → Point`) → `5`.
- Struct literals inside an `Array<Point>` element → `4`.

## Deferred

- A struct literal in a **function-argument** position (no binding annotation to
  drive `lowerTyped`) — needs the callee's param types threaded to the arg. A
  call-site follow-up; today still fail-loud.
- Optional / readonly fields, `interface extends` — unchanged (011 deferrals).
