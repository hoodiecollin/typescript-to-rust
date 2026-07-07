# 043 — `Object.entries` (for-of destructuring + stored/indexed) (plan)

Decision (Collin, 2026-07-06): support **both** the idiomatic `for-of`
destructuring form **and** the stored/indexed form.

`Object.entries(m)` over an `IndexMap<K, V>` yields `Array<[K, V]>` in insertion
order → Rust `Vec<(K, V)>`.

## Consumption forms

1. **for-of destructuring** (idiomatic; primary):
   ```ts
   for (const [k, v] of Object.entries(m)) { … }
   ```
   → `for (k, v) in &m { … }` — a direct borrowed iteration over the `IndexMap`
   (no intermediate `Vec`), `k: &String`, `v: &V`. This is recognized as a special
   case in `lowerForOf` when the right is `Object.entries(x)` and the left is an
   array pattern `[k, v]`. It also needs generic **array-pattern for-of** so that
   `for (const [k, v] of es)` over a stored `Vec<(K,V)>` binding lowers to
   `for (k, v) in &es`.

2. **stored + indexed**:
   ```ts
   const es = Object.entries(m);   // Vec<(String, V)>
   es[i][0]; es[i][1];             // → es[i].0 ; es[i].1
   es.length;                      // → es.len()
   ```
   `Object.entries(m)` as a value → `m.iter().map(|(k, v)| (k.clone(), v.clone()))
   .collect::<Vec<_>>()`. A **pair-index** `es[i][0]` / `es[i][1]` lowers to tuple
   field access `.0` / `.1`. This is gated on knowing `es[i]` is a pair: lowering
   tracks the set of bindings whose initializer is `Object.entries(...)`
   (`entriesBindings`), and a computed member `base[0|1]` where `base` is
   `entriesBinding[idx]` lowers to a `tupleField` HIR node. A non-0/1 literal
   index into a pair is fail-loud.

## HIR / emitter

- `{ kind: "objectEntries"; map }` → the `.iter().map(...).collect()` chain.
- `{ kind: "tupleField"; tuple; index: 0 | 1 }` → `<tuple>.0` / `<tuple>.1`.
- `lowerForOf`: array-pattern left → a `forIn` whose `pat` is `(k, v)` and whose
  `iter` is `&<map>` (entries special case) or `&<vec>` (stored entries).

## Slices

- **043a** — for-of destructuring (array-pattern `for-of`, entries special case).
- **043b** — stored `Object.entries` value + pair-index tuple access + `.length`.

## Fail-loud residuals
- A pair index other than `[0]`/`[1]`; destructuring with ≠2 elements; nested
  destructuring patterns.
