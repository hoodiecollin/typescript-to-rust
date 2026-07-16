# 096 — `++` / `--` (`UpdateExpression`) → Rust `+= 1` / `-= 1`

Fourth item in the "everyday-stuff" campaign (unions ✅ · ternary ✅ · template
literals ✅ · **`++`/`--`** · then destructuring · string methods). See the campaign
memory `093-union-types-campaign`.

## Problem

Rust has no `++`/`--`. `UpdateExpression` is fail-loud today — not in `validate.ts`'s
allowlist. (Two existing `UpdateExpression` references, at `lower.ts:808` and `:10164`,
are **closure-capture** analysis only — they already count `x++` as a mutation of a
captured binding — not lowering.)

For-loops (`for (let i = 0; i < n; i++)`), standalone `x++;`, and the value-position
idioms `while (n-- > 0)`, `return x++`, `arr[i++]` all need this.

## Decision (Collin, 2026-07-16): **full value-position support**

Both statement position AND value position (postfix old-value / prefix new-value).

## AST shape

```
UpdateExpression { operator: "++" | "--", prefix: boolean, argument: Expression }
```

## Mechanism

### Statement position → the existing `assign` node (`x += 1`)

`x++`/`++x`/`x--`/`--x` in **statement position** (a standalone `ExpressionStatement`,
the `for` **update** slot, a closure block body) → the shipped `assign` HIR node
`{kind:"assign", op:"+="|"-=", target: lowerExpr(argument), value:{number 1}}`
→ emits `x += 1;`. Prefix/postfix collapse (identical effect discarded). **All target
kinds** work for free via the assign target — local (`x++`), field (`this.n++`,
`obj.n++`), index (`a[i]++`).

Routed by detecting `UpdateExpression` at the two statement sites:
- `lowerStmt`'s `ExpressionStatement` case (`lower.ts:~5196`) — covers `x++;` **and**
  the async/generator batch for-update path (which re-wraps the update as an
  `ExpressionStatement` via `exprStmt`, `lower.ts:~1921`).
- `lowerFor`'s update slot (`lower.ts:~5427`).

Both call `lowerUpdateAssign(u)`.

### Value position → a new `update` node (block-temp)

In an **expression** position (`lowerExpr`'s `case "UpdateExpression"`), an
**identifier** target lowers to a new HIR node:

```ts
| { kind: "update"; prefix: boolean; target: HirExpr; step: HirExpr }
```

- `target` — the lowered identifier.
- `step` — an embedded `assign` node (`op:"+="|"-=", target, value:{number 1}}`).
  Embedding a real `assign` (not a bare literal) lets the numeric pass reuse its
  existing usize/i64 counter logic (below).

Emitter (`emitExpr` `case "update"`):
- postfix `x++` → `{ let __upd = <target>; <step>; __upd }` (yields the **old** value)
- prefix `++x` → `{ <step>; <target> }` (yields the **new** value)

`target` is an identifier (Copy `f64`/int), so emitting it twice is side-effect-free.

A **non-identifier target in value position** (`arr[k]++` used as a value,
`obj.n++` used as a value) → **fail-loud** (`++/-- on a non-identifier target in a
value position — assign in a statement`). Statement position still supports those.
This covers every realistic value-position idiom — `while (n-- > 0)`, `return x++`,
`f(i++)`, and `arr[i++]` (whose *inner* `i++` is an identifier target).

## Numeric integer-counter interaction (`numeric.ts`)

The `+= 1` amount must be `1` for a usize/i64-promoted counter and `1.0` for an `f64`
(`x: f64 += 1` is a Rust type error). The numeric pass already types the `1` in an
`i += 1` assign (usize-context RHS of an assign whose target is a usize binding). Two
small additions extend that to the value form:

1. `eachExpr` (numeric's shared traversal, used by `usizeContextRoots`/`detectConflicts`/
   `applyTypes`) — `case "update": recurse into target + step`. Surfaces the embedded
   `assign` so its `1` is tagged in usize context.
2. `markContext` (the fixpoint's arithmetic-only descent) — descend into an `update`
   node's `target` so `arr[i++]` (the `update` node **is** the array index) adds `i`
   to the usize set.

Statement-position `i += 1` needs no numeric change (it is a plain `assign`).

## `let mut` marking (`analysis.ts`)

`mutableBindings` decides `let mut`. It currently keys only on `AssignmentExpression`
(`assignmentTarget`). Add an `UpdateExpression` branch so `x++` marks `x` mutable —
identifier → `mut x`; computed/non-computed member with an identifier object
(`a[i]++`, `obj.n++`) → `mut a`/`mut obj` (respecting the existing `aliased`/`self`
guards). `mutatesRoot` gets the same recognition so a scalar **param** mutated via
`x++` becomes a `mut` param.

## rc.ts

`case "update": recurse into target + step` (mirrors `assign`/`strConcat`), so an
rc-field read inside a value-position update still gets its `.borrow()`.

## Fail-loud residuals (v1)

- **Value-position `++`/`--` on a non-identifier target** (`(arr[k]++) + 1`,
  `use(obj.n++)`). Statement position supports field/index targets.
- BigInt/string `++` — a TS type error upstream, never reaches us.

## Files touched

- `packages/compiler/src/validate.ts` — allowlist `UpdateExpression`.
- `packages/compiler/src/hir.ts` — the `update` node.
- `packages/compiler/src/lower.ts` — `lowerUpdateAssign` + `lowerUpdateValue`;
  statement-site detection (ExpressionStatement, `lowerFor` update); `lowerExpr` case.
- `packages/compiler/src/emitter.ts` — `case "update"`.
- `packages/compiler/src/numeric.ts` — `eachExpr` + `markContext` `update` cases.
- `packages/compiler/src/rc.ts` — `case "update"`.
- `packages/compiler/src/analysis.ts` — `UpdateExpression` in `mutableBindings`/`mutatesRoot`.
- `packages/compiler/tests/update-expr.test.ts` — specs (see `specs.md`).
