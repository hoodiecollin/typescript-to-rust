# 082 — TypeOracle: tsc-checker-backed type resolution, coupled with oxc

> **Status: COMPLETE & ARCHIVED (2026-07-14). Issue #49 closed. Graduates spike
> #44.** Direction settled with Collin 2026-07-13 after the `044-type-layer-spike`
> findings: **adopt, coupled + incremental, on TypeScript v5.9.3; first cut-over
> `collectionOf`; `noLib`.** Slice 1 shipped: `type-oracle.ts`, source threading
> through `emit`/`lower`, `collectionOf` bindingTypes-first-then-oracle fallback,
> and the `mutatesThis` extension — 7/7 `ORAC` specs green, full suite no
> regressions. The later tiers all subsequently shipped: **lib tier for inferred
> returns → #48** and **broaden cut-overs (`this.field` beyond collections) → #50**,
> both landed via series 083 (`receiver-oracle`, `receiverTypeOf` 3-tier resolver).
> The sole remaining #44 thread — swap v5.9.3 → the tsgo **v7 native** checker
> behind the same `typeAtSpan` boundary — is externally blocked (no v7 compiler
> API yet) and tracked as its own issue.
> Spec-first: this `design.md` → RED `specs.md` → impl → archive.

## Problem

The front end is `oxc-parser` (syntax only). `collectionOf` (`lower.ts:3144`) —
the resolver that answers "is this receiver a `Map`/`Set`, and of what key/elem" —
is four lines: `if (obj.type !== "Identifier") return null;` then a
`bindingTypes` name lookup. So a Map/Set method (`.get`/`.set`/`.has`/`.delete`,
`.add`) only lowers to its `IndexMap`/`IndexSet` form when the receiver is a
**bare identifier**. `this.field`, `local.field`, and `getX()` receivers fall
out → they miscompile-guard to a generic method call and fail. This is #37
Fork C, and the canonical symptom of the whole hand-rolled-type-layer debt.

The spike (`docs/work/044-type-layer-spike/`) proved a real TS checker resolves
**any** receiver shape via `getTypeAtLocation`, that oxc and tsc spans align
natively (both UTF-16 — no translation), and that a `noLib` program answers
annotation-derived types in ~1 ms.

## Model — a `TypeOracle` coupling module

A new `type-oracle.ts`. One `ts.Program` built **once per compiled source**
(not per query) over a single in-memory file, `noLib` (slice 1 needs only
annotation-derived types). It exposes the coupling primitive and a narrow,
purpose-built resolver:

```ts
interface TypeOracle {
  /** tsc node whose [getStart,getEnd] === the oxc [start,end], or null. */
  typeAtSpan(start: number, end: number): ts.Type | null;
  /** Map/Set RustType for a receiver span, or null if not a map/set. */
  collectionAtSpan(start: number, end: number): RustType | null;
}
```

`collectionAtSpan` is the slice-1 surface `collectionOf` calls. It:

1. `typeAtSpan(start, end)` → a `ts.Type`.
2. Reads the type's symbol name. `Map`/`ReadonlyMap` → build `{kind:"hashmap",
   key, value}`; `Set`/`ReadonlySet` → `{kind:"set", elem}`. Anything else →
   null.
3. Translates each tsc type argument to a `RustType` via a **small, bounded**
   `rustTypeOfTscType` (see below).

### `rustTypeOfTscType` — the bounded tsc-`Type` → `RustType` mapper

Slice 1 handles exactly what a Map/Set key/elem can be in the accepted dialect:

- `string` → `String` (as a **key**, still `String`; as elem, `String`).
- `number` → `f64`; **as a Map key or Set elem**, `{kind:"orderedFloat"}` (the
  existing `wrapKey` contract keys on `key.kind==="orderedFloat"`).
- `boolean` → `bool`.
- a **struct/class/enum name** in `analysis.structs` → `{kind:"struct",name}`.
- nested `Map`/`Set`/`Array` → recurse.
- anything else (union, `any`, function, unmodeled) → **fail-loud is deferred**:
  return null from `collectionAtSpan` so the caller falls back (see fallback),
  rather than emitting a wrong key type.

This mapper is deliberately NOT a general tsc→RustType port; it is the minimal
translation the Map/Set cut-over needs. `lowerType` (AST→RustType) remains the
system's primary type lowerer; the oracle mapper is a sibling for the one place
that has a tsc `Type` instead of an annotation node.

## Integration seam

`lower(program)` today receives no source, so the oracle can't be built. Thread
source **optionally**, preserving every existing call site:

- `emit(program, source?)` → `lower(program, source?)`.
- `ModuleAnalysis` gains `typeOracle: TypeOracle | null` (built in `lower` when
  `source` is provided, else null).
- `collectionOf(obj, analysis)` becomes: **try the current `Identifier`→
  `bindingTypes` lookup first**; only when it returns null (and the oracle is
  present) consult `analysis.typeOracle.collectionAtSpan(obj.start, obj.end)`.
  Oracle-null (no source) → byte-for-byte today's behavior.

### Why bindingTypes-first, oracle-only-as-fallback (not oracle-first)

- **Byte-for-byte regression safety** — every receiver `bindingTypes` already
  resolves (bare identifiers) takes the *identical* path it does today; the
  oracle is never consulted for them, so their emit cannot drift. The oracle
  ONLY ever turns a *previously-null* result (a `this.field` / `getX()`
  receiver) into a resolution — it never changes an existing answer.
- **Zero regressions when source is absent** — every existing `lower(parse(src)
  .program)` test call site keeps working unchanged (oracle null → old path).
- **Fail-loud preserved** — an unmodeled key/elem type yields null from the
  oracle → the downstream fail-loud stands, never a wrong emit.
- The `bindingTypes` path stays primary until a later slice retires it wholesale
  (out of scope here).

### Extraction detail (from the spike, noLib)

Under `noLib`, `Map`/`Set` are unresolved lib types, so `type.symbol` and
`checker.getTypeArguments(type)` are empty. The name and args come through the
**alias** view instead: `type.aliasSymbol?.name` (`"Map"`/`"Set"`) and
`type.aliasTypeArguments` (the `[K, V]` / `[T]` tsc types, classified by
`ts.TypeFlags.StringLike`/`NumberLike`/`BooleanLike`). User-declared
class/interface types resolve normally (`type.symbol.name` in `analysis.structs`
→ a `struct`), since they're in-file.

### Second cut-over required for a *usable* Map field — `mutatesThis`

Making a `this.field` Map resolvable exposed a second gap: `mutatesThis`
(`analysis.ts`, the `&self` vs `&mut self` decision) only detected a **direct
field write** `this.x = …`, not a **mutating method call on a `this.field`**
(`this.cache.set(…)`). Before 082 no resolved `this.field` collection existed, so
this was never exercised. Without it, a method that mutates a Map field emits
`fn seed(&self)` and `self.cache.insert(…)` fails to borrow mutably.

Slice 1 extends `mutatesThis` to also mark a method mutating when its body calls
a `MUTATING_METHODS` method on a `this.field` receiver — syntactic and
field-shape-only, mirroring how `mutableBindings` already marks a **local**
receiver `mut` on the same method names. Correct in general (mutating a field
through any method needs `&mut self`), not Map-specific.

## Operational note (from the spike — must carry into impl)

Bun's bare specifier `"typescript"` resolves to a **v7.0.2 native shim with no
compiler API**. `type-oracle.ts` must import the real v5.9.3 API by the
workspace path (`node_modules/typescript/lib/typescript.js`) or via a configured
alias — NOT `from "typescript"`. Pin this in one place in `type-oracle.ts`.

## Fail-loud residuals (unchanged by this series)

- Non-Map/Set receiver types → null (fall back), exactly as today.
- Map/Set with an **unmodeled key/elem type** (union, function, `any`) → null →
  fallback → today's fail-loud on the downstream emit. Not weakened.
- `noLib` means **method-return inference** (e.g. `getX()` where the return type
  is *inferred*, not annotated) resolves only when the annotation is present. An
  un-annotated inferred Map return is a later (lib-tier) slice — see #48 driver.

## Impl decomposition (each spec-first)

1. **Oracle + `collectionAtSpan` + `collectionOf` cut-over.** `type-oracle.ts`
   (program build, `typeAtSpan`, `collectionAtSpan`, `rustTypeOf`), the
   `emit`/`lower`/`ModuleAnalysis` source threading, `collectionOf`
   bindingTypes-first-then-oracle fallback, and the `mutatesThis` extension for a
   mutating call on a `this.field` receiver. Differential specs for `this.field`
   / `field-of-local` / `getX()` Map+Set receivers; regression specs that
   identifier receivers, non-map receivers, and the no-source path are unchanged.
2. *(later)* lazy **lib** tier for inferred (un-annotated) return types → drives
   #48 concat (method-return string detection). Own series.
3. *(later)* broaden cut-overs beyond `collectionOf` (nullability, numeric
   inference) as separate graduations.

## Specs sketch (→ `specs.md`)

- `class C { m: Map<string, number>; f(k){ return this.m.get(k) } }` — a
  `this.field` Map receiver differential-matches + emits `IndexMap` ops
  (`.get(&…).cloned()` etc.), where today it fails.
- a `local.field`-typed Map (`const o = this; o.m.get(k)` or a field of a local
  struct) receiver — differential-matches.
- `getX(): Map<…>` call receiver — `this.getMap().get(k)` differential-matches.
- a `Set<number>` `this.field` receiver → `OrderedFloat` elem, `IndexSet` ops.
- **Regression:** a bare-identifier Map receiver emits **byte-for-byte** as
  before (oracle path and fallback path agree).
- **Regression:** a non-map receiver (`this.count.toString()`) is unchanged.
- **No-source path:** `lower(program)` with no source still lowers a
  bare-identifier map exactly as today (fallback proven).
