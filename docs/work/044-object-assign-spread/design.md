# 044 — `Object.assign` + object spread (plan)

Decision (Collin, 2026-07-06): support **both** `Object.assign(target, …sources)`
**and** object-spread `{ ...a, ...b, k: v }`.

Both operate on `IndexMap`-backed records (series 041). Later sources/spreads
override earlier keys; an overridden key keeps its original position
(`IndexMap::insert` semantics — matches JS).

## `Object.assign(target, ...sources)`

Mutates `target`, returns it. Two shapes:
- **statement / merge-into-fresh** `Object.assign({}, a, b)` — the common merge:
  a fresh `{}` target → `IndexMap::new()`, extended by each source. Evaluates to
  the merged map.
- **in-place** `Object.assign(a, b)` where `a` is an existing binding — extends
  `a` and evaluates to it.

Lowering → a `tslib::object::assign` helper so the "extend-then-return-target"
value semantics live in one audited place:
```
tslib::object::assign(target, [source1, source2, …])
```
`assign<K: Eq+Hash+Clone, V: Clone>(mut target: IndexMap<K,V>, sources: Vec<IndexMap<K,V>>) -> IndexMap<K,V>`
extends `target` with each source (cloned) and returns it. When the target is a
mutated existing binding used again, the ownership pass clones it in (existing
move→clone machinery).

## Object spread `{ ...a, ...b, k: v }`

A record literal containing `SpreadElement`s. Lowers to a fresh `IndexMap`
built by extending in source order, then inserting the explicit `k: v` entries
in position:
```
{ let mut o = IndexMap::new(); o.extend(a.clone()); o.extend(b.clone());
  o.insert("k".into(), v); o }
```
Emitted as a block-expression HIR (`mapSpread`) — a scoped `{ … o }` that
evaluates to the map. Explicit entries interleave with spreads in source order
(so a later explicit key overrides an earlier spread, matching JS).

## HIR / emitter
- `{ kind: "objectAssign"; target; sources: HirExpr[] }` → the `tslib` call.
- `{ kind: "mapSpread"; parts: ({spread: HirExpr} | {key,value})[] }` → the
  block-expression builder.

## Slices
- **044a** — `Object.assign` (fresh + in-place) via `tslib::object::assign`.
- **044b** — object spread literal `{ ...a, k: v }`.

## Fail-loud residuals
- Spreading a non-record (array spread into object, etc.); `Object.assign` with a
  non-record source.
