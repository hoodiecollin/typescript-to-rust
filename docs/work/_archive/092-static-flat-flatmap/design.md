# 092 — static `flat`-depth + `flatMap` ternary `U | U[]` — design

Epic **#59**, increment 3. Graduates three of series **085**'s fail-loud
residuals **statically** — with **no `JsonValue`** — keeping results as idiomatic
typed `Vec<T>`.

## Decision (settled 2026-07-15 with Collin — "static now, JsonValue later")

The dialect **forbids heterogeneous arrays**, so a *genuinely* jagged /
dynamic-depth array can't be constructed outside the explicit `JsonValue` opt-in.
Every dialect array is uniformly nested (`T[][]…`), so its full depth is
statically known and every `flat`/`flatMap` shape below resolves to homogeneous
`Vec<T>` at compile time. A `JsonValue`-backed dynamic-array path is deferred to a
future increment, gated on a real use-case — not built speculatively.

## What graduates (085 residuals → supported)

1. **`flat(Infinity)`** (085 `FLATK-FL2`) — flatten *all* levels. The nesting
   depth `N` is the number of `vec` levels in the receiver's element type; emit
   `N` chained depth-1 flattens → the scalar leaf `Vec<T>`.
2. **Over-deep / no-op `flat(k)`** (085 `FLATK-FL3`) — JS `flat(k)` flattens
   `min(k, actual_depth)` levels (flattening an already-flat array is a **no-op**
   returning a shallow copy — never an error). Emit `min(k, N)` flattens; `0` →
   the receiver cloned (`.clone()`).
3. **`flatMap` with a ternary `cond ? U : U[]` callback** (085 `FM-FL1`) — both
   arms share the scalar element type `U`; JS `flatMap` flattens one level, so the
   result is homogeneous `U[]`. Lift the callback to a fn returning `Vec<U>`: a
   **scalar arm** is wrapped `vec![arm]`, an **array-literal arm** stays; the body
   is `if cond { return <Vec<U>>; } else { return <Vec<U>>; }`. `flat_map` then
   flattens to `Vec<U>`.

## What stays fail-loud (unchanged / deferred)

- **`flat(n)` with a runtime-variable `n`** (085 `FLATK-FL1`) — depth isn't a
  compile-time constant, so no static flatten count → falls through (cargo-loud).
- **Genuinely-heterogeneous array-literal return** (`x => [x, [x]]` — a real
  `(U | U[])[]`) and an **empty-array arm** (`x => cond ? [] : [x]`) — element type
  is genuinely dynamic/unknown → the `JsonValue`-deferred path. Fail-loud with a
  message pointing at epic #59.
- **`flatMap` ternary with genuinely different arm scalar types** (`cond ? "s" : [x]`)
  — no common `U` → fail-loud.

## Implementation plan

**`lower.ts` — `flat` route (`arrayTailMethod`, ~10118):**
- Replace `flatLiteralDepth` with `flatDepthArg(arg): number | null` returning the
  literal depth, `Infinity` for the `Infinity` global identifier, `1` for no arg,
  clamping a negative/fractional literal (`Math.max(0, Math.floor(v))`), and `null`
  for a runtime variable (fall through).
- Compute `N` by walking the element type's `vec` nesting. `effective = min(depth, N)`.
- `effective === 0` → `{kind:"method", receiver, name:"clone", args:[]}` (no-op copy).
- else emit `effective` chained `tslib::array::flat` calls (the existing loop, now
  bounded by `effective` not the raw request — no under-nested throw).

**`lower.ts` — `flatMap` lift (`liftCallback`, ~9591):**
- When `method === "flatMap"` and the arrow body is a `ConditionalExpression`,
  build the lifted fn via a new `liftFlatMapTernaryBody(cond, ctx, analysis)`:
  lower the test (`truthyCond`), normalize each arm (array-literal → keep and type
  its `vec` element `U`; scalar → `typeCbBody` gives `U`, wrap `{kind:"array",
  elements:[arm]}`), require `sameRustType(consU, altU)`, return
  `{ retType: {kind:"vec", elem:U}, fnBody: [{kind:"if", cond, conseq:[return],
  alt:[return]}] }`. Reuses `liftCallback`'s existing param / free-var / `elemMode`
  machinery (`classifyElementUse` and `freeVarsOf` already handle
  `ConditionalExpression`).
- Otherwise the existing single-expression path (`lowerExpr` + `typeCbBody` +
  `[{return}]`).

No `hir.ts`, `emitter.ts`, or `crates/tslib` change — the `if`-statement HIR and
`{kind:"array"}` (`vec![…]`) / `tslib::array::flat` already exist and emit
correctly. A fn whose whole body is `if c { return … } else { return … }` compiles
(both arms diverge).

## Specs — update `packages/compiler/tests/flatmap-flat.test.ts`

The three graduated residuals move from the fail-loud block into passing
differentials; `FLATK-FL1` (runtime depth) stays fail-loud; add fail-loud pins for
the deferred genuinely-heterogeneous / different-arm-type cases. IDs & rationale in
`specs.md`.
