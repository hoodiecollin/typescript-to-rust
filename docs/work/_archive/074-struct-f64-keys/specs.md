# 074 specs — struct `Map`/`Set` keys with `f64` fields (SameValueZero key newtype)

Graduates the 061 struct-key `f64`-field residual (issue #30). A struct used as a
`Map` key / `Set` element that carries a **direct** `f64` field routes to a
synthesized SameValueZero **key newtype** `<Struct>Key(<Struct>)` with custom
`Hash`/`PartialEq`/`Eq` that wrap each `f64` leaf in `OrderedFloat` at hash/eq time.
The user struct is unchanged — raw `f64` fields (arithmetic untouched), its
`===`-faithful derived `PartialEq` (NaN≠NaN) intact; the newtype is the
collection's actual key (NaN=NaN, `-0`/`+0` collapse — JS `Map`'s SameValueZero on
the f64 fields).

Two oracles. JS `Map`/`Set` key on **object identity**, so a differential vs. Bun
only holds when the TS program reuses the *same* key binding — those specs use
`behaves` (Rust run == TS-via-Bun == expected). The structural SameValueZero win
(distinct-but-equal keys dedupe, `NaN` keys collide, `-0`/`+0` collapse) is the
documented divergence from JS object-identity keying and is pinned directly on the
Rust run (`rustBehaves`). IDs map to `struct-f64-keys.test.ts`.

## Set / get / has / delete / size

- **F64K1** `Map<Point, string>` set/get/has/delete/size over a **shared** `Point`
  binding — differential-matches Bun. Pins `struct PointKey(Point);`,
  `IndexMap::<PointKey, String>::new()`, `insert(PointKey(a…))`, and the
  lookup-clone `&PointKey(a.clone())`.

## The synthesized newtype

- **F64K2** the newtype carries custom SameValueZero impls: `use
  ordered_float::OrderedFloat;`, `impl PartialEq for PointKey` (`OrderedFloat(self.0.x)
  == OrderedFloat(o.0.x)`), `impl Eq for PointKey {}`, `impl std::hash::Hash for
  PointKey` (`OrderedFloat(self.0.x).hash(s)`). The user `Point` keeps its derived
  `#[derive(Clone, Debug, PartialEq)]` (NaN≠NaN).

## The SameValueZero win (Rust-only divergence)

- **F64K3** distinct-but-structurally-equal `Point`s dedupe to **one** key
  (`Set<Point>`), where JS keeps two (object identity).
- **F64K4** `NaN`-field keys collide (`NaN == NaN`) and `-0`/`+0` collapse →
  size 2 across four inserts.
- **F64K6** `p === q` on two `NaN`-field `Point`s is `false` (derived NaN≠NaN)
  **while** the two keys collide (size 1) — both semantics coexist (the newtype
  win). Pins `p == q` (Point's own derived `PartialEq`) alongside the newtype.

## Arithmetic on the raw field

- **F64K5** `a.x * 2`, `a.y + 1` after keying compile against the raw `f64` field
  (`a.x * 2.0`, no OrderedFloat unwrap) and differential-match.

## Iteration unwraps the newtype

- **F64K7** `for (const [k, v] of m)` over `Map<Point, V>` binds `k` to the
  unwrapped `Point` — `for (PointKey(k), v) in m.iter()` — differential-matches.
- **F64K8** `for (const p of s)` over `Set<Point>` — `for PointKey(p) in s.iter()`.

## Mixed fields

- **F64K9** a key struct with mixed `f64` + non-`f64` fields wraps only the `f64`
  leaves (`OrderedFloat(self.0.score)`) and uses plain `==`/`.hash()` for the rest
  (`self.0.label == o.0.label`, `self.0.label.hash(s)`).

## Regression + residual

- **F64K10** a key struct **without** any `f64` field keeps the 061 derive path
  (no newtype, `#[derive(Clone, Debug, PartialEq, Eq, Hash)]`, keyed on the struct
  itself) — regression guard.
- **F64K11** a key struct with an `f64` **nested inside a sub-struct field** stays
  **fail-loud** (the interim residual — the parent newtype can't reach the leaf
  through the sub-struct's own `===`-faithful `PartialEq`; a follow-up recurses).
- **F64K12** a key struct with an `f64` inside a `Vec`/`Option`/`set` field stays
  **fail-loud** — a single `OrderedFloat` wrap is unsound for a collection field
  (needs an element-wise wrap this slice doesn't emit). Only a *direct scalar* `f64`
  is graduated; `hasBuriedF64` catches the rest.

The 061 `map-set.test.ts` FL1 spec is retargeted: a struct key with a *direct
scalar* `f64` field is now graduated (synthesizes `PKey`), no longer fail-loud.
