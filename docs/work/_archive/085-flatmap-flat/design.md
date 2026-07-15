# 085 — `flatMap` (U[] callback) + literal-constant `flat(k)`

Issue **#60** (deferral-graduation, `codegen`, `has-design` — spike done 2026-07-14).
Rides the library-method backbone shipped in **083** (`receiverTypeOf` /
`elementTypeOf` / `arrayTailMethod`) and the **029** catalog (#51). The hard
residual — dynamic/recursive value shapes — stays deferred to epic **#59**.

## Scope (spike-decided — Collin: both tractable forms)

Exactly two forms graduate from fail-loud:

1. **`flatMap(f)` with a uniform `U[]`-returning callback** →
   `recv.iter().flat_map(f).collect::<Vec<_>>()`. The key change is a **one-level
   callback-return element unwrap** in the map-family element typing: `flatMap`'s
   *result* element type is the callback's return **element** type
   (`f: T => U[]` ⇒ result `Vec<U>`, not `Vec<Vec<U>>`). This is achieved by
   letting the callback-body typer (`typeCbBody`) type an **array-literal body**
   as `Vec<U>` (all elements uniform), so the lifted `__cb` returns `Vec<U>` and
   Rust's `flat_map` flattens one level.

2. **`flat(k)` for a literal-constant `k`** on a uniformly `k`-deep-nested array
   (`T[][][]`) → `k` chained one-level flattens over the existing depth-1
   `tslib::array::flat`. `flat(2)` on `Vec<Vec<Vec<T>>>` → `flat(flat(x))`.
   Requires a **numeric-literal** arg and walks the receiver's nested `vec`
   element type exactly `k` levels — fail-loud if the receiver isn't nested that
   deep.

## Stays fail-loud → epic #59 (reject-specs only, no impl)

- `flatMap` with a `U | U[]` union-returning callback (heterogeneous union — the
  #59 recursive/dynamic value root).
- dynamic-depth `flat(n)` where `n` is a variable / non-literal.
- `flat(Infinity)`.
- jagged / irregularly-nested arrays.

Each rejects at compile time (`UnsupportedError`) or at cargo (never a wrong
value), with a message pointing at the fail-loud residual.

## How it rides the existing backbone

### `flatMap` — the one-level callback-return element unwrap

The map/filter path in `lowerCall` already lifts an arrow body to a top-level
`__cb_<method>_<n>` fn via `liftCallback`, whose return type is computed by
`typeCbBody` (the bounded expression typer). For `map`, a scalar body types to a
scalar `U`; the shim then `.map(cb).collect::<Vec<_>>()` yields `Vec<U>`.

`flatMap`'s callback returns an **array** `[…]` (a `{ kind: "array" }` HIR node).
Two additions:

- **`typeCbBody` gains an `"array"` case**: type every element, require them
  uniform (fail-loud on empty or heterogeneous), and return `{ kind: "vec", elem
  }`. So the lifted `__cb_flatMap_n` has `ret: Vec<U>`.
- **`lowerCall` gains a `flatMap` branch** mirroring `map` (same `elementTypeOf`
  input element type, same `liftCallback`, `arity: 1`, **no** index param) that
  emits a new `iterFlatMap` HIR node.

The emit is `recv.iter().flat_map(|p| cb(<elem>${forwarded})).collect::<Vec<_>>()`.
Because Rust's `Iterator::flat_map` flattens the returned `IntoIterator` one
level, `Vec<U>` per element → `Vec<U>` overall — exactly the JS `U[]` result.
The `collect::<Vec<_>>()` uses `_` inference, so no explicit result-element
naming is needed.

`iterFlatMap` reuses `iterMap`'s field shape (`receiver`, `cbName`, `elemParam`,
`forwarded`, `elemMode`) minus `indexParam`; it registers in the same passes
(`ownership`, `numeric`, `rc`, `bitwise`, `alias-escape`) alongside `iterMap`.

**Union callback (`U | U[]`) stays fail-loud**: a body that is a
`ConditionalExpression` returning a scalar in one branch and an array in the
other makes `typeCbBody`'s array case see a non-array branch — the uniform-type
check rejects (heterogeneous). This is exactly #59's dynamic-value root.

### `flat(k)` — the k-level receiver walk

`arrayTailMethod` already claims depth-1 `flat()` on a `Vec<Vec<T>>` receiver.
Extended:

- **`flat()` (0 args)** — unchanged: one `tslib::array::flat(&recv)`.
- **`flat(k)` where `k` is an integer literal ≥ 1** — walk the receiver element
  type `k` levels: at each level the current element must be `{ kind: "vec" }`
  (else fail-loud — the receiver isn't nested that deep). Emit `k` nested
  `tslib::array::flat(...)` calls: `flat(2)` → `tslib::array::flat(&tslib::
  array::flat(&recv))`. `flat(1)` collapses to the depth-1 form.
- **`flat(n)` non-literal / `flat(Infinity)`** — not claimed → falls through to
  the generic method fallthrough → cargo-loud (`Vec` has no `.flat` method).

`tslib::array::flat` is unchanged (each level is one depth-1 flatten); the
k-level composition lives entirely in the emitter chain, so no new runtime code.

## Files touched

- `packages/compiler/src/lower.ts` — `typeCbBody` array case; `flatMap` branch in
  `lowerCall`; `flat(k)` walk in `arrayTailMethod`.
- `packages/compiler/src/hir.ts` — `iterFlatMap` node.
- `packages/compiler/src/emitter.ts` — `iterFlatMap` emit.
- `packages/compiler/src/{ownership,numeric,rc,bitwise,alias-escape}.ts` —
  register `iterFlatMap` alongside `iterMap`.
- `packages/compiler/tests/flatmap-flat.test.ts` — the new BDD specs (085-*).
- `packages/compiler/tests/library-methods-array.test.ts` — update ARR-FL1/FL2
  (flatMap + `flat(2)` now ship; the fail-loud boundary moves to union callback /
  dynamic n).

## Non-goals (explicit)

- No `JsonValue` / recursive-value model (that is #59).
- No `flat` on a jagged array, `flat(Infinity)`, dynamic `flat(n)`, or a union
  callback — all reject.
- No `flatMap` index param `(x, i)` (map-only in 057; flatMap keeps single-param).
</content>
