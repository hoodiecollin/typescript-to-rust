# 074 — Struct keys with `f64` fields (newtype key + custom SameValueZero impls)

> **Status: SHIPPED (2026-07-14).** Graduates the 061 struct-key `f64`-field
> residual, issue **#30**. Dialect calls made with Collin 2026-07-10 (the issue's
> `needs @hoodiecollin input` flag cleared). Builds on 061 (`OrderedFloat` scalar
> keys), 047 (struct `===`), and `derives.ts`. Specs: `specs.md` →
> `packages/compiler/tests/struct-f64-keys.test.ts` (F64K1–F64K11).
>
> **Impl notes / deviations:**
> - **New `RustType` variant `{ kind: "structKey"; name }`** carries the newtype
>   through `emitType` / `wrapKey` uniformly; a new `HirStructKey` item holds the
>   synthesized `<Struct>Key(<Struct>)` + custom impls. Classification splits into
>   `analysis.hashEqStructs` (061, no f64) vs `analysis.structKeyStructs` (074,
>   direct f64) in `collectHashEqStructs`.
> - **Retarget, don't rethread.** `lowerType`/`lowerMapKeyType` keep returning the
>   plain `struct` (32+ callers, and the classification isn't known during
>   `collectBindingTypes`). A `retargetStructKey` walk rewrites `struct → structKey`
>   on `bindingTypes` (before body lowering, so `wrapKey` sees it), on the
>   `mapNew`/`setNew` construction nodes, on each `let` binding annotation, and on
>   item field / fn param+return types (a post-pass before the refine chain).
> - **Lookup-key clone.** `insert`/`add` move the key (`PointKey(a)`; the ownership
>   pass clones if live-after). `get`/`has`/`delete`/`in` build a throwaway
>   `&PointKey(k)` — the ownership pass can't reach inside the `&`, so `wrapKey`
>   clones an identifier key into the temporary (`&PointKey(k.clone())`; `forLookup`
>   flag). The caller keeps ownership.
> - **Iteration unwraps in the pattern**, no body rewrite: `for (PointKey(k), v) in
>   m.iter()` (Map) / `for PointKey(k) in s.iter()` (Set) bind `k: &Struct` via
>   Rust's ergonomic tuple-struct match, so `k.x` reads naturally.
> - **Scope narrowed to *scalar* `f64` fields.** The design scoped in `f64` inside a
>   `Vec`/`Option` directly on the key struct, but a single `OrderedFloat(<field>)`
>   wrap is unsound for a collection field (you can't wrap a `Vec<f64>` in one
>   `OrderedFloat` — it needs an element-wise wrap). Rather than emit miscompiling
>   impls, this first slice restricts `isDirectF64Leaf` to a bare scalar `f64` and
>   routes an `f64` reached through a `Vec`/`Option`/`set` (or a sub-struct) to
>   **fail-loud** via `hasBuriedF64` (F64K12). The element-wise / nested wrap is the
>   documented follow-up.
> - **`derives.ts`** learns the `structKey` kind (Clone/Debug via the wrapped
>   struct; custom PartialEq) so a struct holding a `Map<Point,V>` field still
>   derives correctly.

## Problem

A struct used as a `Map`/`Set` key needs `Hash + Eq`. 061 gates the struct-key
`#[derive(Hash, PartialEq, Eq)]` on **every field being `Hash+Eq` eligible**
(`isTypeHashEq`, `lower.ts:7005`), and an `f64` field is ineligible → **fail-loud**
(`lower.ts:7051`).

The conflict is not "hashing an f64" (solved: `OrderedFloat`, 061) — it's that the field
may *also* be used in **arithmetic** (`p.x * 2`, needs raw `f64`), and, more fundamentally,
**one Rust type cannot carry both equalities**:

- `f64`'s `PartialEq` is IEEE — `NaN ≠ NaN`, `-0 == +0` — which is **exactly JS `===`**.
  So a struct with an f64 field is already `===`-comparable via a *derived* `PartialEq`
  (`derives.ts:148`, 047).
- A `Map` key needs `Eq`, and `Eq` asserts **reflexivity** (`a == a`). A `NaN ≠ NaN`
  `PartialEq` is not reflexive, so `Eq` on top is unsound. A key must use **SameValueZero**
  (`NaN == NaN`, `-0`/`+0` collapse) to match JS `Map`.

A type has exactly one `PartialEq`, and `Eq` must reuse it — so `===`-faithful (NaN≠NaN)
and key-eligible (NaN=NaN reflexive) **cannot both hold on the same type**.

## Decisions (2026-07-10, with Collin)

### 1. Mechanism — custom impls, field stays raw `f64` (Q1)

The key traits are **custom** `impl Hash` / `impl PartialEq` / `impl Eq` that wrap each
`f64` leaf in `OrderedFloat` **only at hash/eq time**; the **stored field type stays raw
`f64`**, so all arithmetic (`p.x * 2.0`) is untouched. Reuses 061's `OrderedFloat` (proven
JS SameValueZero fidelity) and the established custom-impl emit path (025 `Drop`, 053 trait
impls, 059 getters). *Rejected:* changing the field type to `OrderedFloat<f64>` (ripples
unwrap through every arithmetic site).

### 2. The `===`/key conflict — newtype the key (Q2)

Rather than force one equality onto the struct, **synthesize a distinct newtype for the
key** so both semantics coexist:

- The user struct `Point` is **unchanged** — raw `f64` fields, its derived `===`-faithful
  `PartialEq` (NaN≠NaN) intact, `Clone`/`Debug` as before. It is **not** the key type.
- A synthesized **`struct PointKey(Point)`** is the map's actual key. It carries the custom
  **SameValueZero** `Hash`/`PartialEq`/`Eq` (mechanism 1), delegating to `self.0`'s fields
  with `OrderedFloat` wrapping; it derives `Clone`/`Debug` (via `Point`).
- `Map<Point, V>` → **`IndexMap<PointKey, V>`**; `Set<Point>` → `IndexSet<PointKey>`.

Consequence: **no divergence and no both-use fail-loud** — `===` on `Point` stays NaN≠NaN;
the key is NaN=NaN. The accepted cost is **wrap/unwrap at every Map/Set boundary**.

## Mechanism

### Detection & synthesis

- **Lift the gate** — `isTypeHashEq` (`lower.ts:7005`) no longer rejects `f64`; a struct
  used as a key with (transitive) `f64` fields is routed to **newtype synthesis** instead of
  the `lower.ts:7051` throw. A key struct **without** any `f64` field keeps the **existing
  061 path** (derive `Hash/PartialEq/Eq`, key type = the struct itself — unchanged).
- **Synthesize `<Struct>Key`** — one newtype per distinct f64-bearing key struct (reserved/
  collision-safe name). It wraps the struct (`struct <Struct>Key(<Struct>)`), a zero-cost
  newtype. Emit its custom `Hash`/`PartialEq`/`Eq` (below) + derive `Clone`/`Debug`.

### The custom impls (on the newtype)

```rust
struct PointKey(Point);
impl PartialEq for PointKey {
    fn eq(&self, o: &Self) -> bool {
        OrderedFloat(self.0.x) == OrderedFloat(o.0.x)
            && OrderedFloat(self.0.y) == OrderedFloat(o.0.y)   // non-f64 fields: plain ==
    }
}
impl Eq for PointKey {}
impl Hash for PointKey {
    fn hash<H: Hasher>(&self, s: &mut H) {
        OrderedFloat(self.0.x).hash(s);
        OrderedFloat(self.0.y).hash(s);                        // non-f64: field.hash(s)
    }
}
```

Non-`f64` fields use plain `==`/`.hash()`. The generator walks `self.0`'s fields, wrapping
each `f64` leaf (and `f64` inside `Vec`/`Option` directly on the key struct) in `OrderedFloat`.

### Boundary wrap / unwrap (the accepted cost)

Every Map/Set op on an f64-bearing-key collection wraps the key going in and unwraps coming
out (extend `wrapKey`, `lower.ts:3058`, with a struct-newtype case):

| TS | Rust |
|---|---|
| `m.set(p, v)` | `m.insert(PointKey(p), v)` |
| `m.get(p)` | `m.get(&PointKey(p)).cloned()` (lookup key constructed; clone `p` if live-after) |
| `m.has(p)` | `m.contains_key(&PointKey(p))` |
| `m.delete(p)` | `m.shift_remove(&PointKey(p))` |
| `for (const [k,v] of m)` | iterate `(&PointKey, &V)`, bind `k` to `&k.0` (unwrap) |
| `new Map<Point,V>()` | `IndexMap::<PointKey, V>::new()` |

`Set<Point>` mirrors it (`s.add(p)`→`s.insert(PointKey(p))`, iteration unwraps `x.0`).
Import `use ordered_float::OrderedFloat;` via the existing `usesKind(mod,"orderedFloat")`
trigger (`emitter.ts:180`).

### Reuse

`OrderedFloat`/`wrapKey` + `ordered-float` dep (061); custom-impl emit (025/053/059);
`HirStruct.fields` / `StructTable` for the field walk (`derives.ts`); `isTypeHashEq` recursion
(`lower.ts:7015`).

## Fail-loud residuals

- **`f64` reached through a collection or sub-struct field of the key** — the newtype
  impl wraps a *scalar* `f64` field in one `OrderedFloat(...)`; an `f64` inside a
  `Vec`/`Option`/`set` needs an element-wise wrap, and one buried in a sub-struct
  can't be reached through the sub-struct's own `===`-faithful (NaN≠NaN) `PartialEq`.
  **As shipped**, the first slice handles **direct scalar** `f64` fields only; a key
  struct with an `f64` inside a `Vec`/`Option`/`set` or a sub-struct field stays
  fail-loud in the interim (`hasBuriedF64`, F64K12) — never a miscompile. (The
  original design scoped `Vec`/`Option`-of-`f64` in; narrowed at impl — see the
  status note.)
- **`OrderedFloat` for a non-scalar exotic** (e.g. an `f64` map/set element that is itself a
  key) — governed by the same recursion boundary.
- Everything 061/047 already reject downstream — unchanged.

## Impl sequence

1. Lift the `isTypeHashEq` `f64` rejection; route f64-bearing key structs to newtype
   synthesis (keep the no-f64 key path on the 061 derive).
2. Synthesize the `<Struct>Key(<Struct>)` newtype HIR (name, wrapped struct, f64-leaf field
   map); mark it the key type for the collection.
3. Emit custom `Hash`/`PartialEq`/`Eq` (OrderedFloat-wrap f64 leaves) + `Clone`/`Debug`
   derive.
4. Lower `Map<Struct,V>`/`Set<Struct>` key type to the newtype; extend `wrapKey` + the
   iteration/`.keys()` sites to wrap/unwrap at every boundary.
5. RED `specs.md` → GREEN (differential — SameValueZero key behavior incl. `NaN`/`-0` keys,
   `===` on the struct still NaN≠NaN, arithmetic on the field unaffected).

## Specs sketch

- `Map<Point, V>` with `Point { x: number; y: number }` — set/get/has/delete/iter;
  `NaN`-field key dedupes (SameValueZero), `-0`/`+0` field collapse; differential-matches.
- Arithmetic on the field after keying: `p.x * 2` compiles (raw `f64`), differential-matches.
- `===` on `Point` with a `NaN` field → `false` (unchanged, derived NaN≠NaN) **while** the
  same `Point` is used as a key elsewhere with NaN=NaN — both hold (the newtype win).
- `Set<Point>` dedupes structurally-equal points (SameValueZero on f64 fields).
- Key struct **without** f64 (`Key { id: number /*integral*/ }`) → unchanged 061 derive path
  (no newtype) — regression guard.
- Nested `f64` inside a sub-struct field of a key → **fail-loud** (documented interim).

## Open sub-details (impl, not dialect forks)

- Newtype naming / collision-avoidance (reserved prefix vs `<Struct>Key`).
- `m.get(&PointKey(p))` lookup-key construction: clone `p` when live-after vs. move; whether
  a `Borrow`-based borrow avoids the temporary (likely not worth it first slice).
- Where newtype synthesis lives (a collection pass emitting an extra `HirItem` alongside the
  struct) and how iteration-site unwrap threads through `for-of` destructuring (coordinate
  with 064/067 patterns).
- Recursion strategy for the nested-`f64` graduation (generate a SameValueZero walk per
  struct type vs. a shared helper) — deferred with the residual above.
