# 082 — TypeOracle specs (slice 1: `collectionOf` cut-over)

Each spec differential-matches (compile → `cargo run` → TS-via-Bun) and/or pins
the refined emitted shape. IDs map to `tests/type-oracle.test.ts`. The through-
line: a `Map`/`Set` receiver that is **not a bare identifier** — `this.field`, a
field of a local, or a `getX()` call — lowers to its `IndexMap`/`IndexSet` ops
via the tsc oracle, where before it fell through to an invalid `.set`/raw `.get`.

## Positive — receiver shapes `collectionOf` couldn't resolve

- **ORAC1 `this.field` Map — read + mutate.** A `class` with `cache: Map<string,
  number>`; a method does `this.cache.set(k, v)` and another reads
  `this.cache.get(k) ?? -1`, `this.cache.has(x)`, `this.cache.size`.
  Differential-matches. Emits `self.cache.insert(…)`, `self.cache.get(&k)
  .cloned()`, `.contains_key(…)`, `.len()`; the mutating method is `&mut self`.
- **ORAC2 `this.field` Set — read + mutate.** `tags: Set<number>`;
  `this.tags.add(n)`, `this.tags.has(n)`. Differential-matches. Emits
  `IndexSet<OrderedFloat<f64>>`, `.insert(OrderedFloat(n))`, `.contains(…)`.
- **ORAC3 `getX()` call receiver.** `this.getCache().get(k)` where `getCache():
  Map<string, number>` (seeded via a method, since the dialect's constructor is
  pure field-init). Differential-matches — a CallExpression receiver is
  categorically beyond a name-keyed table.
- **ORAC4 field-of-local receiver.** A free `lookup(store: Store)` doing
  `store.cache.get("a")` — `store.cache` is a field of a local (parameter)
  binding, a MemberExpression `bindingTypes` can't key on. Differential-matches.

## Regression — nothing the `bindingTypes` path already handled changes

- **ORAC5 bare-identifier Map receiver is byte-for-byte unchanged.** The same
  fixture as an existing 061 map spec emits identical Rust whether or not source
  is threaded (oracle present but not consulted — `bindingTypes` answers first).
- **ORAC6 non-map `this.field` receiver is untouched.** `this.count + 1` (a
  `number` field) lowers as before; the oracle returns null (not a map/set), so
  no `IndexMap`/`IndexSet` routing appears.
- **ORAC7 no-source path.** `lower(program)` with no source still lowers a
  bare-identifier map exactly as today (oracle null → `bindingTypes` only).

## Fail-loud / bounded (unchanged posture — behavior, not a separate spec)

- **Unmodeled key type falls back, not miscompiled.** A Map/Set whose key/elem
  `rustTypeOf` can't map yields null from `collectionAtSpan` → the caller's
  existing fail-loud stands (never a wrong emit). This is the fallback contract
  the ORAC5–7 regression specs already pin from the other direction.

## Known adjacent gaps surfaced (follow-ups, not slice 1)

- `this.field` **method calls beyond collections** are still receiver-shape
  limited — e.g. `this.count.toString()` emits `.toString()` (not `.to_string()`)
  because that resolver, like the old `collectionOf`, keys on identifiers. Same
  class as this series; a later oracle cut-over. Filed as a follow-up.
- A **`&str`-param used as a Map key** (`get(k)` where `k: string` → `&str`) is
  not coerced to `String` (`String: Borrow<&str>` fails). Pre-existing,
  receiver-shape-independent; the specs use literal / owned-`String` keys.
