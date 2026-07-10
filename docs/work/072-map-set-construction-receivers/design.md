# 072 — Map/Set non-empty construction + `this.field` / field receivers

> **Status: DESIGN COMPLETE (2026-07-10). Impl pending.** Graduates the two 061
> deferrals, issue **#37**. Dialect calls made with Collin 2026-07-10
> (`needs-user-input` cleared). The `localVar.field` **borrow/ownership tail** is split
> to **#45** and stays fail-loud in the interim. Struct-`f64`-field keys remain **#30**.
>
> Spec-first: this `design.md` → mock → RED `specs.md` → impl → archive.

## Problem

Series 061 shipped `Map`/`Set` (`IndexMap`/`IndexSet`) but modeled only:

- **Empty construction** — `new Map<K,V>()` / `new Set<T>()`. A non-empty initializer
  argument is fail-loud (`lower.ts:6704`).
- **Identifier receivers** — method routing (`m.set`→`.insert`, `s.add`→`.insert`, `.size`
  →`.len()`, `in`/`delete`) resolves the receiver's type only when it is a **plain
  identifier**, via `collectionOf` bailing on any non-`Identifier` (`lower.ts:3045`).

#37 graduates both. The key-type policy (String / integer / `OrderedFloat<f64>` / gated
struct; struct-with-`f64`-field → #30) is **unchanged** from 061 and reused throughout.

## Two seams

### Seam 1 — non-empty construction

`new Map([[k,v],…])` (array of 2-tuples) and `new Set([…])` (flat array). The Rust idiom
is already reachable: the emitter uses `IndexMap::from([(k,v),…])` for record literals
(`emitter.ts:909`); `IndexSet::from([…])` mirrors it.

**Fork A — initializer surface (decided: A2, variable/array-expression accepted).**

- **Array literal of pairs/elements** → `IndexMap::from([(wrap(k), v), …])` /
  `IndexSet::from([wrap(x), …])`.
- **A variable / array-typed expression** — `new Map(entries)` / `new Set(items)` where the
  argument has array type → `entries.into_iter().map(|(k,v)| (wrap(k), v)).collect::<IndexMap<_,_>>()`
  (a plain `.collect()` when no key-wrap is needed) / `items.into_iter().map(wrap).collect::<IndexSet<_>>()`.
- **Still fail-loud:** an iterator/other-`Map`/`Object.entries()` argument, spreads, and any
  non-array expression.

**Fork B — type arguments with an initializer (decided: B1, infer; fail-loud if ambiguous).**

- Explicit `<K,V>` / `<T>` is honored when written.
- When **absent**, infer from the initializer: from a literal, the first pair/element
  (reusing existing element/numeric inference — integral `number`→`i64`, fractional→
  `OrderedFloat<f64>`, `string`→`String`, struct, …); from a **typed** variable/param, its
  declared element type in `bindingTypes`.
- **Fail-loud when inference can't resolve a consistent type** — an empty literal
  `new Map([])` with no type args, an untyped variable, or inconsistent element types.

**Key-wrapping** reuses `wrapKey` (061): applied inline per element for a literal, and
inside the `.map(|(k,v)| …)` closure for the variable path.

**JS-fidelity (spec targets):**
- `new Map([[1,'a'],[1,'b']])` — JS keeps the **last** value at the **first** key position;
  `IndexMap::from`/`from_iter` inserts sequentially → last value wins, position preserved.
  Faithful.
- `new Set([1,1,2])` — JS dedupes; `IndexSet::from` keeps first occurrence. Faithful.

### Seam 2 — field receivers

The type facts already exist: `structFields` records `class C { entries: Map<K,V> }` as a
`hashmap` field type (`lower.ts:4421`); `currentClass` is tracked during method lowering.
The *only* gap is `collectionOf` (`lower.ts:3041`) refusing non-identifier receivers.

**Fork C — receiver shapes (decided: C2, `this.field` + `localVar.field`).**

Extend `collectionOf` to resolve two more receiver shapes, both consulting `structFields`:

| Receiver | Resolve the owning struct via | Then the field type via |
|---|---|---|
| `m` (identifier) | — (`bindingTypes.get(m)`) | *(existing)* |
| `this.field` | `analysis.currentClass` | `structFields.get(currentClass)` |
| `localVar.field` | `bindingTypes.get(localVar)` → `{kind:"struct",name}` | `structFields.get(name)` |

Because `.size`, `k in obj`, and `delete obj[k]` also funnel through `collectionOf`, this
single extension fixes method routing **and** those uniformly, for all three receiver shapes.

**Still fail-loud (both under C2):** a call-result receiver (`getMap().set(…)`), a nested
projection (`this.inner.entries.set(…)`), an array-element receiver (`arr[0].add(…)`).

**`&mut self` classification.** A method that calls a mutating map/set method
(`.set`/`.add`/`.delete`) on `this.field` mutates `self` — it must be classified
`&mut self`. Wire map/set mutating-method calls on `this.field` into the `mutatingMethods`
fixpoint (`analysis.ts`) so the receiver is emitted `&mut self` and `self.field` is a
mutable place.

## Decision — the `localVar.field` borrow tail is #45, fail-loud here

`this.field` mutation is always sound: inside a `&mut self` method the exclusive borrow is
already held, so `self.field.insert(…)` needs no ownership reasoning. `localVar.field`
mutation needs a `&mut localVar.field`, which is sound **only when the owning local is
plainly owned with an exclusive borrow available**. When the owner is borrowed-across,
moved, `Rc`-shared (062), or captured, the mutation can conflict.

Per the 2026-07-10 call, #37 ships C2's **clean** cases (owned local, exclusive `&mut`); the
**borrow-conflict tail** is split to **#45** and **stays fail-loud** in the interim (a
`DialectError` at the site, never a miscompile — the 041/062 literal-first pattern). #45
resolves promote-vs-fail-loud and coordinates the promotion-trigger set with #35/#38.

## Mechanism (reuse map)

- **Construction** (`lower.ts:6695–6741`) — replace the `arguments.length > 0` fail-loud
  with initializer lowering. Extend the `mapNew`/`setNew` HIR (or add an `init?: HirExpr`)
  to carry the lowered initializer; emit `IndexMap::<K,V>::from([...])` /
  `IndexSet::<T>::from([...])` for a literal, or the `.into_iter().map(…).collect()` form for
  a variable/expression. Type-arg inference falls back to element inference (Fork B).
- **Key-wrap** — reuse `wrapKey` (061) at each key site / inside the collect closure.
- **`collectionOf`** (`lower.ts:3041`) — add the `this.field` and `localVar.field` branches
  above. Single choke point; `tryMapSetMethod`, `.size`, `in`, `delete` all benefit.
- **Mutation classification** — extend `mutatingMethods` to see map/set mutators on
  `this.field`.
- Reuse: 061 key policy (`lowerMapKeyType`, `wrapKey`, `OrderedFloat`, struct-derive gating),
  `structFields`, `currentClass`, `bindingTypes`, array/tuple lowering.

## Fail-loud residuals

- **`localVar.field` mutation with a non-exclusive owner** (borrowed/moved/`Rc`-shared/
  captured) — interim fail-loud → **#45**.
- **Non-array initializer** — iterator, other-`Map`, `Object.entries()`, spread → fail-loud.
- **Un-inferable type args** — empty literal / untyped variable with no `<K,V>`/`<T>`.
- **Non-name/non-`this.field` receivers** — `getMap().set(…)`, `this.inner.m.set(…)`,
  `arr[0].add(…)`.
- **Struct key/element with an `f64` field** — **#30** (unchanged).
- `WeakMap`/`WeakSet` — unmodeled.

## Impl sequence

1. Non-empty construction — literal path (`from([...])`) with per-key `wrapKey`; type-arg
   inference from the literal (Fork B).
2. Variable/array-expression construction — `.into_iter().map(…).collect()` with in-closure
   key-wrap (Fork A2).
3. `collectionOf` extension — `this.field` branch (currentClass → structFields).
4. `collectionOf` extension — `localVar.field` branch (bindingTypes → structFields); clean
   cases only; borrow-conflict owners fail loud (→ #45).
5. `mutatingMethods` wiring for `this.field` map/set mutators (→ `&mut self`).
6. RED `specs.md` → GREEN (differential; construction + field-receiver routing match JS,
   incl. dup-key/dup-element and insertion-order fidelity).

## Specs sketch

- `new Map([["a",1],["b",2]])` (no type args) → `IndexMap::<String,f64>::from([...])`;
  differential-matches; dup-key `[[1,'a'],[1,'b']]` keeps last value / first position.
- `new Set([1,1,2])` → `IndexSet::from([...])`, one `1`; `new Set(["a","b"])`.
- `new Map(entries)` where `entries: [number,string][]` → `.into_iter().map(...).collect()`.
- `new Set(items)` where `items: string[]` → `.into_iter().collect::<IndexSet<_>>()`.
- `new Map<number,V>([...])` fractional keys → `OrderedFloat` wrapping (061 policy).
- Class field map: `class C { m = new Map<string,number>(); add(k,v){ this.m.set(k,v) } }`
  → `self.m.insert(k, v)`, method `&mut self`; `this.m.size`/`this.m.has(k)`/`this.m.delete(k)`.
- `const c = new C(); c.m.get("k")` (owned local) → `c.m.get(&…).cloned()`.
- `new Map([])` no type args → **fail-loud** (un-inferable).
- `localVar.field.set(...)` where `localVar` is shared/aliased → **fail-loud** (→ #45).
- Empty `new Map<K,V>()` / identifier receiver — **byte-for-byte unchanged** (regression).

## Open sub-details (impl, not dialect forks)

- Whether the initializer rides on the existing `mapNew`/`setNew` node (`init?`) or a new
  `mapFrom`/`setFrom` node.
- Tuple-typed variable initializers for `Map` (`[K,V][]`) depend on `TSTupleType` element
  typing — if not modeled, the `Map` variable path may fail loud where the `Set` (`T[]`)
  path succeeds; confirm at impl.
- Exactly which `localVar.field` owners count as "plainly owned, exclusive `&mut` available"
  vs. routed to #45 — the clean/deferred boundary (coordinate with #45's classification).
- `IndexMap::from` vs `::from_iter` vs a `.insert` loop for the literal path (order/dup
  semantics identical; pick the clearest emit).
