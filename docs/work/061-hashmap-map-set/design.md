# 061 — HashMap operations & `Map` / `Set` classes

> **Status: DESIGN (decided, awaiting impl).** Graduates the fail-loud deferral in
> issue #21. Builds on 010 (`Record` literals/lookup), 031 (index-assign→`.insert`),
> 041 (`IndexMap` backing + `Object.keys`/`values`), 042 (`Option`). Dialect-shape
> decisions made with Collin 2026-07-09.

## Settled by precedent (not a fork)

**Backing type is `indexmap`.** Series 041 adopted `IndexMap` uniformly for
`Record`/object because JS iterates in **insertion order** (`std::HashMap` doesn't),
and `indexmap` is already a dependency (`.scratch/Cargo.toml`, `crates/tslib`).
So `Map<K,V>` → `IndexMap<K,V>` and `Set<T>` → `IndexSet<T>` follow for consistency
and JS-order fidelity.

## Decisions

- **Fork 1 — key/element types: `String` + integer + struct + scalar `f64`.**
  Scalar `f64` keys/elements use **`ordered_float::OrderedFloat<f64>`** — faithful to
  JS `Map`/`Set` **SameValueZero** semantics (`NaN == NaN`, `-0`/`+0` collapse), so
  it is a *correct* translation, not a divergence. Struct keys use a gated
  `#[derive(Hash, PartialEq, Eq)]`. A **struct with an `f64` field** used as a key is
  **fail-loud here** — the dual-representation conflict (a float field needed as raw
  `f64` for arithmetic *and* as a hashable key) is tracked as its **own standalone
  issue**, not solved in this series.
- **Fork 2 — graduate all three:** Record query ops + variable keys, the `Map<K,V>`
  class, and the `Set<T>` class.

## Fork 1 — key / element type policy

Rust map keys / set elements require `Hash + Eq`.

| TS key/elem | Rust | eligibility |
|---|---|---|
| `string` | `String` | always ✓ |
| integer-valued `number` | `i64` / `usize` (via `numeric.ts`) | ✓ |
| fractional / `f64` `number` | `OrderedFloat<f64>` | ✓ (faithful to JS SameValueZero) |
| struct, all fields `Eq` | struct + gated derive | ✓ |
| struct with an `f64` field | — | **fail-loud** → its own standalone issue |

### Scalar `f64` keys via `OrderedFloat` (`ordered-float` dependency)

`f64` lacks `Hash`/`Eq` (`NaN != NaN`; `-0.0`/`0.0` share equality but differ in
bits). `ordered_float::OrderedFloat<f64>` supplies `Hash + Eq + Ord` and — crucially
— **matches JS `Map` SameValueZero exactly**: its `PartialEq` treats `NaN == NaN`,
and its `Hash` canonicalizes `-0.0`→`0.0` and NaN. So a number-keyed `Map` (incl.
`NaN` keys) and a `Set<number>` that dedupes `NaN` translate faithfully. We use
`OrderedFloat`, **not** `NotNan`, precisely because JS permits `NaN` as a key.

- `Map<number, V>` with any fractional key → `IndexMap<OrderedFloat<f64>, V>`;
  `Set<number>` → `IndexSet<OrderedFloat<f64>>`.
- Key sites wrap: `m.insert(OrderedFloat(k), v)`, `m.get(&OrderedFloat(k))`,
  `s.insert(OrderedFloat(x))`. Iteration unwraps `k.0` (`into_inner`) back to `f64`.
- Add `ordered-float` to `.scratch/Cargo.toml` (curated-crate precedent:
  `indexmap`/`serde`/`tokio`/`bumpalo`); emitter import `use ordered_float::OrderedFloat;`.
- A `number` key is `i64`/`usize` when integer-inference proves it integral (cheaper,
  no wrapper); it falls to `OrderedFloat` only when it is genuinely fractional/`f64`.

### Struct-key derive (extends `derives.ts`)

`derives.ts` already foresees `Hash`+`Eq` ("struct map keys"). Add a **gated
predicate**: a struct used as a map key / set element derives `Hash, PartialEq, Eq`
(all three — `Eq` requires `PartialEq`), **gated on every field being `Hash+Eq`
eligible** (scalars except `f64`, `String`, `bool`, `i64`, `usize`, nested eligible
structs). A single `f64` field makes the struct ineligible → the map/set usage is
fail-loud, pointing at the key type. This is independent of 047's `===`-gated
`PartialEq` (a struct may be a key without ever being `===`-compared), so the
derive predicate unions both triggers.

## Fork 2 — API surface

### Record query ops + variable keys

- `k in obj` → `obj.contains_key(&k)`.
- `delete obj[k]` → `obj.shift_remove(&k)` (order-preserving).
- **Variable/non-literal keys** — `obj[someVar]` **read** lowers to
  `obj.get(&some_var).cloned()` returning `Option` (JS `V | undefined`; the
  042-correct path). A statically-known-present literal read may keep the existing
  index form; a variable read must be `Option`.

### `Map<K,V>` class → `IndexMap`

| TS | Rust |
|---|---|
| `new Map<K,V>()` | `IndexMap::<K,V>::new()` |
| `m.set(k, v)` | `m.insert(k, v)` |
| `m.get(k)` | `m.get(&k).cloned()` → `Option` |
| `m.has(k)` | `m.contains_key(&k)` |
| `m.delete(k)` | `m.shift_remove(&k)` |
| `m.size` | `m.len()` |
| `for (const [k, v] of m)` | `for (k, v) in &m` |

The `Map` type annotation lowers to the existing `hashmap` `RustType` (backing
`IndexMap`); construction adds a `mapNew`/`mapBuild` path alongside 041's record
literal.

### `Set<T>` class → `IndexSet`

| TS | Rust |
|---|---|
| `new Set<T>()` | `IndexSet::<T>::new()` |
| `s.add(x)` | `s.insert(x)` |
| `s.has(x)` | `s.contains(&x)` |
| `s.delete(x)` | `s.shift_remove(&x)` |
| `s.size` | `s.len()` |
| `for (const x of s)` | `for x in &s` |

Add a `set` `RustType` (`IndexSet<T>`) + emitter import (`use indexmap::IndexSet;`,
mirroring the existing `IndexMap` import at `emitter.ts:171`).

## Fail-loud residuals

- **Struct key/element with an `f64` field** — deferred to its **own standalone
  issue** (the dual-representation conflict), *not* a permanent rejection.
- A key type that is neither scalar-eligible, `String`, `OrderedFloat<f64>`, nor an
  eligible (all-`Eq`) struct.
- `WeakMap`/`WeakSet` (unmodeled).

## Impl sequence

1. `set` `RustType` + `IndexSet` import; `Map`/`Set` type-annotation lowering.
2. `Map` construction + methods (`set`/`get`/`has`/`delete`/`size`/iter).
3. `Set` construction + methods.
4. Record query ops (`in`, `delete`) + variable-key `Option` reads.
5. Integer-key refinement (reuse `numeric.ts`); scalar `f64` keys → `OrderedFloat`
   wrapping (`ordered-float` dep, import, key-site wrap, iteration unwrap).
6. Struct-key gated `Hash, PartialEq, Eq` derive + eligibility; struct-with-`f64`-field
   key fail-loud (→ separate issue).
7. RED specs → GREEN (differential; iteration order matches JS via IndexMap/Set).

## Specs sketch

- `Map<string, number>`: set/get/has/delete/size; `.get` → `Option`; iteration order.
- `Map<number, V>` with integer keys → `i64`; with fractional keys →
  `OrderedFloat<f64>` (`NaN`/`-0` key behavior matches JS SameValueZero).
- `Set<number>` dedupes `NaN` (one element), collapses `-0`/`+0`.
- Struct key (`Map<Key, V>`, `Key { id: i64 }`) → gated derive; `Point{x:f64}` key →
  `UnsupportedError` (tracked as its own issue).
- `Set<string>`: add/has/delete/size/iter.
- `k in obj`, `delete obj[k]`, `obj[var]` variable read → `Option`.

## Open sub-details (impl, not dialect forks)

- Whether literal-key record reads migrate to `.get`-Option uniformly or keep index
  for proven-present keys (a nullability-consistency call, coordinate with 042).
- `shift_remove` vs `swap_remove` — use `shift_remove` everywhere to preserve JS
  insertion order (order-fidelity is the whole reason for IndexMap).
