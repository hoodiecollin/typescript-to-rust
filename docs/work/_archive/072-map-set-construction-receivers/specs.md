# 072 — Specs

Differential specs (compile → `cargo run` → compare stdout vs TS-via-Bun). IDs map
to `packages/compiler/tests/map-set-construction.test.ts`. The oracle is active
(source threaded), matching the way series 082 exercises `collectionOf`.

Series 082 already shipped **all of Seam 2** (field receivers + `&mut self`
classification) — `this.field`, `localVar.field`, and even `getX()` receivers route
through the tsc oracle (`ORAC1`–`ORAC4` in `type-oracle.test.ts`). So 072's
genuinely-new surface is **Seam 1: non-empty construction**; the field-receiver
specs below are GREEN-from-start characterization for the construction that seeds a
class-field map (they exercise construction, not the 082 routing).

## Seam 1 — non-empty construction

- **MAPC1** `new Map([["a",1],["b",2]])` (annotated binding, no type args) →
  `IndexMap::<String, f64>::from([...])`; differential-matches `2` / values.
- **MAPC2** dup-key `new Map([[1,'a'],[1,'b']])` — JS keeps the **last** value at the
  **first** key position; `IndexMap::from` inserts sequentially → last wins, position
  preserved. Faithful.
- **MAPC3** `new Map<number, string>([[1,"one"],[2.5,"half"]])` — fractional key →
  `OrderedFloat` wrapping (061 policy); reads match.
- **SETC1** `new Set([1,1,2])` → `IndexSet::from([...])`, dedupes to one `1`; size `2`.
- **SETC2** `new Set(["a","b","a"])` → `IndexSet::<String>::from([...])`, dedupes.
- **MAPVAR** `new Map(entries)` where `entries: [string, number][]` →
  `.into_iter().collect::<IndexMap<String, f64>>()`; differential-matches.
- **SETVAR** `new Set(items)` where `items: string[]` →
  `.into_iter().collect::<IndexSet<String>>()`; differential-matches.
- **SETVARN** `new Set(items)` where `items: number[]` → key-wrap in the map closure
  (`OrderedFloat`); dedupes numerically.

## Seam 1 — field-map construction (construction seeds a class field)

- **FLDC1** `class C { m: Map<string, number>; constructor() { this.m = new Map([["a",1]]); } }`
  — the field initializer is a non-empty construction; `this.m.get`/`.size` (082 routing)
  read the seeded entries.

## Fail-loud residuals (unchanged)

- **FLC1** `new Map([])` with no type args → **fail-loud** (un-inferable element type).
- **FLC2** `new Map(other)` where `other: Map<...>` (non-array arg) → **fail-loud**.
- **FLC3** empty `new Map<K,V>()` / bare-identifier receiver — **byte-for-byte
  unchanged** (regression; covered by 061/082).
