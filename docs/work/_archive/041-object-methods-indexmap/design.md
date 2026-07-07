# 041 — `Object.keys` / `values`, backed by `IndexMap` (plan)

Graduates the `Object.*` surface from the 029 catalog. Building it forces the
catalog's **insertion-order open question** (029 § Open questions), because
`Object.keys`/`values` are the first place map iteration order becomes
*observable* — records so far only did keyed lookup.

## Decision — adopt `IndexMap` for `Record`/object types

JS objects (and `Map`) iterate in **insertion order**; `std::collections::HashMap`
does not preserve it, so `console.log(Object.keys(obj))` would diverge from JS.
Per the ordering decision (2026-07-06, Collin), the `Record`/object backing type
becomes **`indexmap::IndexMap`** uniformly. `IndexMap` is a drop-in for the
read / index / `insert` usage the emitter already produces, and preserves
insertion order, so key/value order matches JS everywhere — not only where the
emitter could prove order is observed.

- Emitter: `HashMap<K, V>` → `IndexMap<K, V>`; `HashMap::from([…])` /
  `HashMap::new()` → `IndexMap::from` / `IndexMap::new`; the prelude import
  `use std::collections::HashMap;` → `use indexmap::IndexMap;`.
- `indexmap = "2"` is pinned in the scratch crate alongside tokio/tslib.
- The internal HIR tag stays `hashmap` (the map-literal/type node); only the
  emitted Rust changes. Existing records specs update their asserted type.
- Index-assign → `.insert()` (031 gap E) is unchanged: `IndexMap::insert` updates
  in place and keeps the key's original position, matching JS assignment.

## `Object.keys` / `Object.values` (Route N — native)

| JS | Rust |
|---|---|
| `Object.keys(m)` | `m.keys().cloned().collect::<Vec<_>>()` → `Vec<String>` |
| `Object.values(m)` | `m.values().cloned().collect::<Vec<_>>()` → `Vec<V>` |

Both iterate the `IndexMap` in insertion order, so `Object.keys(m)[i]` /
`Object.values(m)[i]` are deterministic and match JS. `Object.<anything else>`
(including `entries`/`assign`) is **fail-loud** here.

## Deferred (fail-loud residuals, tracked in the #26 follow-up)

- `Object.entries` — returns `Array<[K, V]>`; faithful consumption needs
  pair-*array* indexing (`e[0][1]`) over a Rust tuple, a distinct modeling step.
- `Object.assign` — merge + variadic sources + returns-the-target mutation.

## Differential proof

- A 3-key record: `Object.keys(m)` prints `a b c`, `Object.values(m)` prints
  `1 2 3` (insertion order — the whole point of `IndexMap`).
- Existing record lookup / index-assign specs stay green against `IndexMap`.
