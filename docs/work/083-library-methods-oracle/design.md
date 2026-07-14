# 083 — Unified receiver-type resolution + the library-method catalog

> **Status: DESIGN (awaiting review). Issues #50 (broaden the oracle cut-over)
> + #49/#44 lineage, implements the tractable surface of the 029 catalog.**
> Direction settled with Collin 2026-07-14 (four forks answered):
> **(1)** scope = the **full 029 catalog** (tractable Tier-1/Tier-2 surface), not
> just a receiver-shape patch; **(2)** unify the scattered type resolvers behind a
> single **`receiverTypeOf`** helper (bindingTypes/structFields → oracle fallback);
> **(3)** the `&str`-as-Map-key fix is **borrow-based** (drop the extra `&`, no
> allocation); **(4)** array-callback element resolution (`elementTypeOf`) rides
> the same backbone. Spec-first: this `design.md` → RED `specs.md` per slice →
> impl → archive.

## Problem

Three unrelated facts collide into one class of bug — the hand-rolled-type-layer
debt #44 names:

1. **No general primitive-method dispatch.** A method call on a `number`/`string`
   receiver (`x.toString()`, `s.toUpperCase()`, `n.toFixed(2)`) has **no**
   resolver: `lowerCall` (`lower.ts`) falls through to a generic
   `{kind:"method"}` HIR node, which the emitter renders as a raw
   `receiver.name(..)` (`emitter.ts:1564`). So `this.count.toString()` emits Rust
   `.toString()` (should be `.to_string()`) and fails to compile — and so does the
   bare-identifier `x.toString()`. Only `padStart`/`padEnd` (tslib) and `.length`
   are wired. Most of the 029 String / Number-Math / Array-tail catalog is
   unimplemented.

2. **Receiver-type resolution is scattered and inconsistent.** Three resolvers
   each re-derive "what type is this receiver," with different reach:
   - `collectionOf` (`lower.ts`) — `bindingTypes` identifier lookup **then the
     082 oracle** (`collectionAtSpan`); resolves any receiver shape.
   - `isStringExpr` (`lower.ts:5377`) — `bindingTypes` (identifiers) **+
     `structFields`** (`this.field`/`local.field`); but **no oracle**, so a
     `getX()` receiver or a deeper chain is invisible.
   - `elementTypeOf` (`lower.ts`, array-callback element type) — `bindingTypes`
     **only**; a non-identifier array receiver throws `UnsupportedError`.

   The same receiver shape resolves in one place and not another. This is exactly
   the debt 082 started paying down on `collectionOf` — #50 finishes it.

3. **`&str`-as-Map-key fails.** A `string` **param** lowers to `&str`; a Map/Set
   lookup wraps the key with `refExpr(wrapKey(..))` → `&(&str)` = `&&str`, and
   `IndexMap<String,V>::get` wants `&Q where String: Borrow<Q>` — `String:
   Borrow<&str>` does not hold. The 082 specs sidestepped this with literal/owned
   keys.

## Decisions (the four forks)

- **Scope — the full 029 catalog.** This series implements the tractable
  Tier-1/Tier-2 method surface (String, Number/Math, the Array-access tail),
  every method routed through the new backbone. Genuinely-deferred catalog rows
  stay deferred (see *Out of scope*), but everything with a clean Rust target and
  a landed container is in.
- **Unify behind `receiverTypeOf`.** One resolver, three tiers, consumed by
  `collectionOf`, `isStringExpr`, `elementTypeOf`, and the new primitive-method
  dispatch. Retires the scattered lookups so the receiver-shape bug cannot recur.
- **`&str` key — borrow-based, no alloc.** At a Map/Set lookup, when the key
  expression is already a reference (`&str` param, or any borrowed place), pass it
  **directly** to `.get`/`.contains_key`/`.remove` instead of adding an outer `&`.
  Relies on `String: Borrow<str>`. No `.to_string()` allocation per lookup.
- **Arrays included.** `elementTypeOf` gets the same backbone, so
  `getRows().map(f)` / `this.items.filter(g)` resolve, not just identifier arrays.

## Model

### 1. `receiverTypeOf` — the single receiver-type resolver

A new function in `lower.ts`, the one place any pass asks "what is this
receiver's type":

```ts
/**
 * The RustType of an arbitrary receiver expression, or null. Three tiers,
 * cheapest first — the oracle is consulted only when the hand-rolled tables
 * miss, so every receiver they already resolve keeps its exact current path
 * (byte-for-byte, no oracle drift), and the oracle only ever turns a
 * previously-null answer into a resolution.
 */
function receiverTypeOf(expr: Expression, analysis: ModuleAnalysis): RustType | null {
  // Tier 1 — bare identifier → bindingTypes (the fast, pre-082 path).
  if (expr.type === "Identifier") {
    const t = analysis.bindingTypes.get(expr.name);
    if (t) return t;
  }
  // Tier 2 — `this.field` / `local.field` → structFields (no oracle needed).
  if (expr.type === "MemberExpression" && !expr.computed) {
    const t = memberFieldType(expr, analysis); // factored from isStringExpr
    if (t) return t;
  }
  // Tier 3 — any shape (getX(), a.b.c, index chains) → the 082 oracle.
  const span = expr as unknown as { start?: number; end?: number };
  if (analysis.typeOracle && span.start !== undefined && span.end !== undefined) {
    return analysis.typeOracle.typeAtSpan_rustType(span.start, span.end);
  }
  return null;
}
```

- `collectionOf` becomes a thin filter over `receiverTypeOf` (return it only when
  `kind` is `hashmap`/`set`) — its bespoke bindingTypes+oracle body is deleted.
- `isStringExpr` keeps its literal / template / binary-`+` cases but delegates its
  identifier + member cases to `receiverTypeOf(...)?.kind === "String"`, gaining
  the oracle tier for free (so `getName().toUpperCase()` now sees a string).
- `elementTypeOf` returns `receiverTypeOf(obj)` when it is a `vec` (falling back
  to today's `UnsupportedError` only when the backbone also misses).

**Precedence rationale (same as 082's):** hand-rolled tiers first → zero
regression for every receiver they already answer; the oracle only converts a
null into a resolution, never changes an existing answer, and is absent (→
identical old behavior) when no source is threaded.

### 2. Oracle extension — a primitive/array classifier

`type-oracle.ts` already classifies `StringLike`/`NumberLike`/`BooleanLike` and
Map/Set/struct via `rustTypeOf`. Slice this series needs a **general
`typeAtSpan → RustType`** surface (not just the collection filter), exposed as a
new oracle method (working name `typeAtSpan_rustType`) that reuses `rustTypeOf`
extended with:

- `NumberLike` (non-key) → `{kind:"f64"}` (already present).
- `StringLike` → `{kind:"String"}` (already present).
- `BooleanLike` → `{kind:"bool"}` (already present).
- `Array<T>` / `ReadonlyArray<T>` (alias `Array`, one type arg) → `{kind:"vec",
  elem}` (recurse) — new, so `elementTypeOf`'s oracle tier works.
- everything unmodeled → null (fail-loud fallback preserved).

Still `noLib` (annotation-derived types only). A method receiver whose type is an
**inferred** return (`getX()` with no return annotation) resolves only under the
lib tier — that is #48's job (series 048/lib), explicitly out of scope here; it
stays fail-loud until then, never miscompiled.

### 3. The primitive-method dispatch — `tryPrimitiveMethod`

A new resolver in `lower.ts`, sibling to `tryMapSetMethod`/`tryTslibMethod`,
called from `lowerCall` **before** the generic method fallthrough:

```ts
function tryPrimitiveMethod(
  methodName: string, m: MemberExpression, call: CallExpression,
  analysis: ModuleAnalysis,
): HirExpr | null {
  const recv = receiverTypeOf(m.object, analysis);
  if (recv?.kind === "String") return stringMethod(methodName, m, call, analysis);
  if (recv?.kind === "f64")    return numberMethod(methodName, m, call, analysis);
  return null; // not a primitive we model → fall through (fail-loud downstream)
}
```

Each of `stringMethod` / `numberMethod` is a **routing table** keyed on the JS
method name, returning either a native HIR shape (an emitter-recognized method /
`format!` / builtin) or a `tslib::fn` call, per the 029 Route column. The
`.length` property access (already wired) and the Array-tail methods route
through the same `receiverTypeOf` gate for their receiver shape.

**Routing follows the 029 principle verbatim:** native when the Rust semantics
match; `tslib::fn` only when a JS quirk must be reproduced; **never** a coercion
macro (type/ownership stays in the inference passes). No new macros — every row
below is `N` or a `tslib::fn`.

#### String routing table (this series)

| JS | Route | Rust target | Quirk note |
|---|---|---|---|
| `toString()` (no radix) | N | `.to_string()` (identity on `String`) | — |
| `toUpperCase`/`toLowerCase` | N | `.to_uppercase()`/`.to_lowercase()` | Unicode casing ≈ JS; documented divergence |
| `trim`/`trimStart`/`trimEnd` | N | `.trim()`/`.trim_start()`/`.trim_end()` | — |
| `includes`/`startsWith`/`endsWith` | N | `.contains()`/`.starts_with()`/`.ends_with()` | — |
| `repeat(n)` | N | `.repeat(n as usize)` (n via numeric pass) | — |
| `padStart`/`padEnd` | Tf | `tslib::string::pad_start/pad_end` | **already landed** |
| `replace`/`replaceAll` | Tf | `tslib::string::replace_first`/`.replace(..)` | `replace` = first match only |
| `split` | N/Tf | `.split(sep).collect()`; empty-sep + limit → `tslib` | UTF-16 vs char at empty sep |
| `slice`/`substring`/`charAt` | Tf | `tslib::string::*` | UTF-16 code unit vs Rust char/byte |

#### Number / Math routing table (this series)

| JS | Route | Rust target | Quirk note |
|---|---|---|---|
| `n.toString()` (no radix) | N | `.to_string()` (needs the number formatting fn — see below) | JS number→string formatting |
| `Math.floor/ceil/round/abs` | N | `f64::floor/ceil/round/abs` | `round`: JS half-up vs Rust half-away — note/`tslib` if a fixture demands |
| `Math.min/max` (binary) | N | `f64::min/max` | variadic → a later `min!`/`max!` macro slice |
| `n.toFixed(d)` | Tf | `tslib::number::to_fixed` | formatting + rounding quirk |
| `n.toString(radix)` | Tf | `tslib::number::to_radix` | radix formatting |
| `Number.parseInt/parseFloat` | Tf | `tslib::number::parse_int/parse_float` | radix, trailing-garbage tolerance |

> **`String()`/number→string fidelity caveat.** JS `String(1)` is `"1"` but
> `String(1.5)` is `"1.5"` and integers never show `.0`, whereas Rust
> `1_f64.to_string()` is `"1"` and `1.5_f64.to_string()` is `"1.5"` — mostly
> aligned, but large/small magnitudes and `-0` diverge. Number→string that must
> be JS-faithful routes to a `tslib::number::to_js_string` **Tf** helper; the
> plain `.to_string()` native path is used only where the differential proves
> equality. Each Number row ships with a quirk-observing differential spec.

### 4. `&str`-key borrow fix

At the Map/Set lookup lowering (the `wrapKey(.., forLookup=true)` +
`refExpr(..)` sites in `lower.ts`), when the key type is `String` **and** the key
expression already lowers to a reference (a `string` param → `&str`, or another
borrowed place), emit the key **without** the outer `&`:

```
m.get(k)              // k: &str          — was m.get(&k) → &&str (E0277)
m.contains_key(k)     // k: &str
```

Detection: the lowering knows a param's declared type (`analysis` param tables);
a `string` param is `&str`. The rule is "don't double-borrow an already-borrowed
key," implemented by a small `keyRefMode(expr, keyTy, analysis)` that returns
`"bare"` for an already-`&str` key vs `"ref"` for an owned/literal/orderedFloat/
structKey key (unchanged). Owned `String` keys, string literals, `orderedFloat`
and `structKey` keys keep their current `&`-wrapped path exactly.

## Integration seam

- `receiverTypeOf` + `memberFieldType` (factored out of `isStringExpr`) added to
  `lower.ts`; `collectionOf`/`isStringExpr`/`elementTypeOf` rewritten to consume
  it. Pure refactor for every currently-resolving receiver (regression-guarded).
- `typeAtSpan_rustType` added to `TypeOracle` (`type-oracle.ts`), reusing
  `rustTypeOf` + the new `Array` arm.
- `tryPrimitiveMethod` + `stringMethod`/`numberMethod` tables in `lower.ts`,
  called from `lowerCall` before the generic method fallthrough.
- new `tslib` fns: `string::replace_first`, `string::str_slice/substring/char_at`,
  `number::to_fixed/to_radix/to_js_string/parse_int/parse_float` (each its own
  file section under `crates/tslib/src/`), wired through the existing tslib import
  machinery (027). `pad_start`/`pad_end` already exist.
- `keyRefMode` + call-site change at the Map/Set lookup lowering.

## Impl decomposition (each spec-first, own RED specs)

1. **Backbone + `.toString()`.** `receiverTypeOf`, `memberFieldType`,
   `typeAtSpan_rustType` (+ `Array` arm), the `collectionOf`/`isStringExpr`/
   `elementTypeOf` rewrites, and the smallest method table entry
   (`toString()` → `.to_string()`) proving the pipeline end-to-end for
   `this.field`/`getX()`/identifier receivers. Regression specs: every existing
   collection/string/array-callback receiver emits byte-for-byte as before.
2. **`&str`-key borrow fix.** `keyRefMode` + the lookup-site change; specs with a
   `string`-param key over a `Map`/`Set` (the case 082 sidestepped).
3. **Inferred / method-return receiver resolution (lift `noLib` for receivers).**
   Resolve receivers whose type is *only* knowable by inference — un-annotated
   `getX()` returns, and receivers whose type is inferred *through* a built-in
   method signature (`a.trim().toUpperCase()`, `arr.join("").split("")`). Tier-3
   of `receiverTypeOf` (the oracle path) drops the annotation-only restriction for
   the receiver-classification query; the classifier still maps only to types we
   already model, so anything unmodeled remains null → fail-loud. **This slice is
   the resolution path for #48** (string concat undetected when both operands are
   method calls) — #48 becomes a driver/spec source, not separate work.
4. **String methods — native rows.** `toUpperCase/toLowerCase`, `trim*`,
   `includes/startsWith/endsWith`, `repeat`. Differential per method.
5. **String methods — tslib rows.** `replace/replaceAll`, `split` (empty-sep +
   limit), `slice/substring/charAt` (UTF-16 quirk differentials).
6. **Number/Math — native rows.** `Math.floor/ceil/round/abs`, `min/max` binary,
   plain `.toString()` where differential-equal.
7. **Number/Math — tslib rows.** `toFixed`, `toString(radix)`, `parseInt/
   parseFloat`, `to_js_string` fidelity. Quirk differentials each.
8. **Array-access tail** (if not already landed): `join`, `concat`, `reverse`,
   `splice`. Each rides `receiverTypeOf`/`elementTypeOf`.

Slices 1–2 are the #50 core (backbone + `&str` key). Slice 3 lifts the `noLib`
receiver restriction (subsumes #48). Slices 4–8 are the 029 catalog build-out on
that backbone. Each ships independently and green.

## Fail-loud residuals (unchanged posture — never a miscompile)

- **Unmodeled receiver types** (union, `any`, a class instance method we don't
  model) → `receiverTypeOf` null → generic fallthrough → today's fail-loud. (Note:
  inferred / method-return receivers are **no longer** in this bucket — slice 3
  resolves them; only genuinely-unmodeled *shapes* stay rejected.)
- **Deferred catalog rows** (see below) stay `DialectError`/cargo-loud.
- **`round` half-rounding, UTF-16 string indexing, number→string magnitude
  edges** — each routed to `tslib` with a quirk-observing differential, or
  documented as an accepted divergence per 029's open question; never silently
  wrong.

## Out of scope (deferred catalog rows — unchanged)

`find` (blocked on **066-undefined-model impl**, not on decision — the `Option<T>`
return model is already designed; #7 closed, #42 resolved-with-design),
`Object.entries/assign`, `JSON.stringify/parse` (serde), `Math.random` (RNG dep +
determinism),
`flatMap/flat(n)` deep, variadic `Math.min/max` macro, iterators/`Symbol.iterator`
(025), and all Tier-3 (`RegExp`, `Date`, `Proxy`, `structuredClone`). These keep
their current status; 083 does not touch them.

## Specs sketch (→ `specs.md`)

- **RT (backbone):** `this.count.toString()`, `getName().toUpperCase()`, a
  `local.field` string method, an identifier string method — all differential-
  match where before they failed; byte-for-byte regression on an identifier
  collection/string receiver and the no-source path.
- **KEY:** `m.get(k)` / `m.has(k)` / `m.delete(k)` with `k: string` param over a
  `Map<string,V>`/`Set<string>` — differential-matches (was fail-loud).
- **STR/NUM/ARR:** one differential per catalog method, quirk-observing for every
  `Tf` row (proving fidelity, per 029's spec rule).
