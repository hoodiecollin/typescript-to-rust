# 061 — specs (HashMap ops & `Map` / `Set` classes)

> **Status: SHIPPED.** Differential BDD specs live in
> `packages/compiler/tests/map-set.test.ts` (compile → cargo run → TS-via-Bun).
> IDs below map 1:1 to the test names.

## Map / Set / record query ops

- **MAP1** `Map<string, number>` — `set`/`get`/`has`/`delete`/`size`. `new Map<K,
  V>()` → `IndexMap::<String, f64>::new()`; `.set(k,v)` → `.insert(...)`; `.get(k)`
  → `.get(&k).cloned()` (`Option`, observed via `?? -1`); `.has` → `.contains_key`;
  `.delete` → `.shift_remove` (order-preserving); `.size` → `.len()`.
- **MAP2** `Map` iteration preserves JS insertion order — `for (const [k, v] of m)`
  → `for (k, v) in m.iter()` (backed by `IndexMap`).
- **MAP3** `Map<number, V>` — integer + fractional keys via `OrderedFloat<f64>`
  (faithful to JS SameValueZero); lookups wrap `&OrderedFloat(k)`.
- **SET1** `Set<string>` — `add`/`has`/`delete`/`size`/iter. `new Set<T>()` →
  `IndexSet::<String>::new()`; `.add` → `.insert`; `.has` → `.contains`.
- **SET2** `Set<number>` collapses `-0`/`+0` and dedupes `NaN` (SameValueZero) via
  `IndexSet<OrderedFloat<f64>>` (`NaN` → `f64::NAN`).
- **REC1** `k in obj` → `obj.contains_key(&k)`.
- **REC2** `delete obj[k]` → `obj.shift_remove(&k)` (needs `mut obj`).
- **REC3** a *variable*-key record read `obj[k]` → `obj.get(&k).cloned()` → `Option`
  (a literal-key read keeps the proven-present index form, series 010).
- **FL1** (fail-loud) a struct key with an `f64` field is rejected with a clean
  `UnsupportedError` — the dual-representation conflict is tracked as its own issue.

## Emitted-shape anchors

- `IndexMap::<K, V>::new()` / `IndexSet::<T>::new()` (turbofish so an un-annotated
  binding still infers); `use indexmap::{IndexMap, IndexSet};`,
  `use ordered_float::OrderedFloat;` gated on use.
- Struct `Map` keys / `Set` elements derive `Hash, PartialEq, Eq` (gated, series
  061); a struct with an `f64` field is fail-loud at collection time.
