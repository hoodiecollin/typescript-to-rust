# 118 — Union-type residuals (graduate #82) — design

Follow-up to series 093 (union types → Rust `enum`, epic #63, archived). 093 §9
left a fail-loud tail; issue **#82** is its home. Collin's dialect decision
(2026-07-24) for this series:

- **Graduate to real support:** (d) fielded union as a Map/Set key, (f) two named
  structs with no shared discriminant, (c) mixed literal + object union (the "G"
  shape).
- **Keep fail-loud, tail-message to #59:** (a) recursive/self-referential unions,
  (b) generic unions (type-parameters × unions). These need the boxed
  recursive-value / generics infrastructure that epic **#59** owns; this series only
  replaces their generic `UnsupportedError` with a precise message + a
  message-matched pin.
- **Harden (already promised, never implemented):** (e) narrowing a discriminated
  union on a **non-discriminant** field is today a *silent* mis-lowering (falls
  back to ordinary member access → invalid Rust → cargo-loud). Make it
  transpiler-loud with the message 093 §9 promised.

This maps onto the 093 pin table (`_archive/093-union-types/specs.md:90-99`):
UN-FL3 → (d), UN-FL4 → (e), UN-FL6 → (c) all graduate; UN-FL1 → (a), UN-FL2 → (b)
stay loud with better messages.

---

## Ground truth this builds on (verified against code 2026-07-24)

Pure classifiers + naming live in `packages/compiler/src/unions.ts`. The pre-pass
`collectUnions` + the `register*` functions + the construction coercions live in
`packages/compiler/src/lower/unions.ts`. Type lowering (`lowerType`'s `TSUnionType`
case), the Map/Set key policy (`lowerMapKeyType` / `collectHashEqStructs` /
`isTypeHashEq`), and `discriminatedScrutinee` live in
`packages/compiler/src/lower/types.ts`. The `switch`/if-ladder → `match`
recognizers live in `packages/compiler/src/lower/narrowing.ts`. `emitUnionEnum`
(which simply joins `e.derives`) lives in `packages/compiler/src/emitter.ts:802`.
`HirUnionEnum.narrow` is currently `"typeof" | "in"`; unit variants carrying a
`display` already emit as a bare path and round-trip through `emitDisplayArms`.

Key facts that shape the design:

- Every registered union adds its name to `analysis.structs` **and** its enum to
  `analysis.unionEnums`, but **never** to `analysis.structFields`. So the existing
  `collectHashEqStructs.consider(ty)` sees a union key as a struct with *no fields*
  and throws the generic `struct '<name>' … has a non-Hash+Eq field`. **No union
  enum derives `Hash`/`Eq` today** — only `PartialEq`. So even a *fieldless*
  literal union is not usable as a key yet (contra the 093 doc's aspirational
  claim).
- `discriminatedScrutinee` returns `null` on a wrong-field access (`info.discField
  !== property`); the caller silently falls back. The promised
  "narrow on the discriminant `<field>`" message does **not** exist in source.
- The mixed literal+object throw fires only on the **named-alias** path
  (`lower/unions.ts:120`); an *inline* mixed union is silently skipped and fails
  loud later at `lowerType`'s catch-all.

---

## (d) Fielded union as a Map/Set key — `Hash + Eq` derives

**Shape.** `Map<Dir, V>` / `Set<Dir>` where `Dir` is any registered union whose
every variant payload is `Hash + Eq` eligible: a fieldless literal union
(`"n"|"s"`, `0|1`), a discriminated/non-discriminated/named union whose fields are
all `Hash+Eq` (`String`, `bool`, integer, nested Hash+Eq struct, `Vec`/`Option`
thereof). An **f64 payload** anywhere (a `number` field, a primitive union's
`Num(f64)`) stays fail-loud — same first-slice boundary structs already draw
(074's `OrderedFloat` treatment is not extended to enum payloads here).

**Mechanism.**
1. Teach `isTypeHashEq` (`lower/types.ts:182`) to resolve a **union** name: when
   `ty.kind === "struct"` and `analysis.unionEnums.has(ty.name)`, a union is
   eligible iff every variant's every field type — and every `newtype` inner —
   is `isTypeHashEq` (recurse; fieldless variants are trivially eligible). This
   needs the `unionEnums` map threaded in alongside `structFields`.
2. In `collectHashEqStructs.consider`, branch on a union name *before* the struct
   logic: if eligible, mutate the enum's `derives` to add `"Hash"` and `"Eq"`
   (idempotent; `PartialEq` already present so `Eq` is sound), and return. If not
   eligible, throw a union-tailored message:
   `union '<name>' used as a Map key / Set element has a variant payload that is
   not Hash+Eq (e.g. an f64/number field)`.
3. The emitter needs **no change** — it joins whatever `derives` holds. Literal
   unions currently derive `["Clone","Copy","Debug","PartialEq"]`; we append
   `Hash`,`Eq`. Fielded unions derive `["Clone","Debug","PartialEq"]`; same append.

**Why mutate derives rather than compute at registration.** Hash/Eq is only
*needed* when the union is a key; deriving them unconditionally would (a) force the
eligibility check on every union whether or not it is a key, and (b) fail to model
the f64 case cleanly. Keying off `collectHashEqStructs` (which already walks
`bindingTypes` for keys) keeps the cost where the requirement is.

---

## (f) Two named structs, no shared discriminant — `in`-narrowed newtype enum

**Shape.** `type FooBar = Foo | Bar` where `Foo`/`Bar` are named interfaces/structs
with **no** common literal discriminant but a **distinguishing field** (a field
present in exactly one of them). This is case E (`in`-narrowing) with **named
newtype variants** instead of inline struct variants — the union of D's payload
model and E's narrow.

Emitted enum:
```rust
enum FooBar { Foo(Foo), Bar(Bar) }
```
narrowed by `"onlyInFoo" in x`.

**Mechanism.**
1. New classifier `classifyNamedNonDiscriminatedUnion(members, resolve)` in
   `unions.ts`: every member a bare `TSTypeReference` resolving to props;
   `findDiscriminant` returns null (else it is D); require each variant to own at
   least one field absent from every other variant (so `in`-narrowing is
   unambiguous) — otherwise return null (stay fail-loud). Anon name
   `anonNamedNonDiscUnionName(names)` hashing the sorted interface-name set (a
   distinct prefix from D's `anonNamedUnionName` so the two never collide).
2. New `registerNamedNonDiscriminatedUnion` in `lower/unions.ts`: newtype variants
   `{ name: Foo, newtype: {struct Foo} }`, `narrow:"in"`, `derives
   ["Clone","Debug","PartialEq"]`, **no** `discField`. Wire into `collectUnions`
   both the alias loop and `walkUnionTypes`, tried **after**
   `classifyNamedDiscriminatedUnion` (D wins when a discriminant exists) and after
   `classifyNonDiscriminatedUnion`? — order: literal → disc → named-disc → prim →
   **named-non-disc** → non-disc. (Named refs are disjoint from inline objects, so
   relative order with E is immaterial; place it right after D.)
3. `lowerType`'s union case: add a named-non-disc branch, `structs`-gated by
   `anonNamedNonDiscUnionName` (same registration-gate pattern as D/F).
4. **Construction.** `coerceScalarToUnion` already builds `FooBar::Foo(foo)` from a
   `Foo`-typed identifier (newtype-inner match) — free. For an **object literal**
   `const x: FooBar = { onlyInFoo: 1 }`, extend `coerceObjectToUnion`'s
   `narrow:"in"` branch: when the matched variant is a **newtype** variant, resolve
   the object's field set against the *inner struct's* fields (`analysis.structFields`)
   and build `FooBar::Foo(Foo{…})` via `lowerTyped(obj, variant.newtype)`.
5. **Narrowing.** `recognizeInIfLadder` already binds a newtype variant through
   `buildDiscArm`'s newtype path (binds the whole inner struct under `objName`,
   `sh.field` reads resolve). The one gap: `variantByUniqueField` looks at
   `v.fields`, which is empty for a newtype variant. Extend it to resolve the field
   through `v.newtype`'s struct fields (via `analysis.structFields`) so `"onlyInFoo"
   in x` selects `Foo`. Thread `analysis` in.

---

## (c) Mixed literal + object union (G) — single-level mixed `match`

**Shape (v1 scope).** `L1 | L2 | … | O1 | O2 | …` where the `Li` are string/number
literals and the `Oi` are inline objects that **share a `.kind`-style literal
discriminant among themselves** (case-C rules apply to the object part). Example:
```ts
type State = "loading" | "error" | { kind: "done"; result: number };
```

**Insight that makes this tractable.** 093 called G "irregular two-level
narrowing." It is only irregular in the *test shape* — value-equality for the
literal part (`x === "loading"`), field-equality for the object part (`x.kind ===
"done"`). The **match itself is single-level**: literal members become **unit
variants**, object members become **struct variants**, all in one enum, and an
equality if-ladder mixing both test shapes lowers to one flat `match`. We support
that ladder; the `typeof`-split form (`if (typeof x === "string") …`, treating `x`
as a bare string inside the branch) stays fail-loud.

Emitted enum:
```rust
enum State { Loading, Error, Done { result: f64 } }
```

**Mechanism.**
1. New classifier `classifyMixedLiteralObjectUnion(members)` in `unions.ts`:
   partition into literal members and inline-object members; require ≥1 of each
   (else it is A/B or C); the object part must classify as discriminated
   (`findDiscriminant` over the object members alone, or a single object with a
   discriminant field). Returns `{ literals: LiteralMember[], discField, objects:
   DiscObjectMember[] }`, else null (stay fail-loud — e.g. object part with no
   discriminant). Anon name `anonMixedUnionName` over literal sigs + object sigs.
2. New `registerMixedUnion` in `lower/unions.ts`: unit variants for the literals
   (name = `sanitizeVariantIdent`, `display` = the literal, collision ordinals like
   `literalVariants`), struct variants for the objects (like
   `registerDiscriminatedUnion`, `discValue` set), `narrow:"mixed"` (new tag),
   `discField` = the object discriminant, `derives ["Clone","Debug","PartialEq"]`
   (a struct field → no `Copy`), `displayImpl:false`.
3. **Extend `HirUnionEnum.narrow` to `"typeof" | "in" | "mixed"`.**
4. `lowerType` union case: add a mixed branch, `structs`-gated by `anonMixedUnionName`.
   **Replace** the current mixed-alias throw (`lower/unions.ts:120`) with real
   registration; keep a *narrower* throw for a mixed union whose object part lacks a
   discriminant (`… mixes literal and object members and the object part has no
   shared discriminant — give the objects a shared \`kind\`/\`type\` field`).
5. **Construction.** String/number literal in a `State` slot → unit variant via
   `coerceLiteralToUnion` (matches `variant.display`; unit variants carry it) —
   free. Object literal → the discriminated branch of `coerceObjectToUnion`
   (`info.discField` set; unit variants have no `discValue` so they are naturally
   skipped) — free.
6. **Narrowing.** New `recognizeMixedIfLadder` in `narrowing.ts`, wired into
   `lowerIf` ahead of the disc/typeof/in recognizers. Each rung is one of:
   - `x === "loading"` (value-equality against the *union binding itself*) → the
     unit variant whose `display` matches (new `mixedLitEqTest` helper; note the LHS
     is the identifier `x`, **not** `x.kind`).
   - `x.kind === "done"` → the object struct variant (reuse `discEqTest` semantics
     over the object discriminant + `buildDiscArm`).
   - a trailing `else` covering the one remaining variant (bind it if it is an
     object variant; bare arm if a literal). Reuse the covered/uncovered logic.
   A `switch` analog is out of v1 scope (a mixed union cannot be `switch`ed cleanly
   in TS — you would `switch(x)` on the literals but the objects have no scalar
   form). If-ladder only.

---

## (e) Non-discriminant narrow → transpiler-loud

**Today.** `discriminatedScrutinee` returns `null` when the accessed property is not
the discriminant; `recognizeUnionIfLadder`/`lowerSwitch` fall back to ordinary
member-access lowering, which emits `enum_val.radius` — invalid Rust → cargo-loud,
not a clean transpiler error.

**Mechanism.** Add a companion `discriminatedNarrowMismatch(disc, analysis)` used by
`discEqTest` and the `switch` scrutinee path: when `disc` is `<id>.<prop>`, `<id>`
resolves to a discriminated-union binding (`info.discField` present), and `<prop> !==
info.discField`, throw:
`narrow on the discriminant '<discField>' of union '<name>', not '<prop>'`.
Keep `discriminatedScrutinee` itself pure (returns null → legitimate non-union
member access still falls through); the loud check is a separate, explicitly-gated
step so we never throw on a plain struct field access. Confirm the only callers are
the narrowing recognizers before wiring.

---

## (a) recursive + (b) generic — retained fail-loud, tailored to #59

Not graduated (Collin's decision) — these need epic #59's boxed recursive-value
model and generics×unions work. This series only upgrades the message + adds a
message-matched pin so the boundary is honest and self-documenting.

- **(a) recursive.** In `collectUnions`' alias loop, detect a self-referential
  member field: any object member field annotation that is a `TSTypeReference`
  (or `TSArrayType`/`Array<…>` thereof) to `decl.id.name`. Throw:
  `recursive/self-referential union '<name>' needs the boxed recursive-value model
  — tracked in #59`.
- **(b) generic.** A union alias carrying `typeParameters`, or a union whose members
  are bare in-scope type-parameter refs. Throw:
  `generic union '<name>' (type parameters × unions) is not modeled — tracked in
  #59`.

Both are detected *before* the classifier cascade so the precise message wins over
the generic catch-all.

---

## Post-implementation notes (discovered during the build)

- **Ownership fix (latent bug).** The ownership clone pass's `buildStructTable`
  (`derives.ts`) omitted union enums, so a non-Copy union value used as a Map key /
  Set element (or held as a struct field) was never seen as cloneable-movable and
  the required clone at `m.insert(k, …)` (before a later `m.get(&k)`) was skipped →
  `E0382`. Fixed by flattening each union variant's fields + newtype inner into a
  synthetic field list in `buildStructTable`. Fielded (non-Copy) union keys now
  clone-when-live like struct keys; literal unions are `Copy`, so they never needed it.
- **Fielded (object) union keys diverge from JS.** JS `Map` keys objects by
  **reference**; Rust `IndexMap` keys **structurally**. This is the same divergence
  struct keys (061/074) already ship, and is the *intended* semantics for a typed
  key. A faithful differential therefore uses the *same* key value for `set` + `get`
  (reference-equal in JS and structurally-equal in Rust). Literal/primitive union
  keys have no divergence.
- **Narrowing requires the explicit `else` form.** Like 093's E / discriminated
  ladders, mixed (G) and named-non-disc (f) narrowing recognize
  `if (…) … else if (…) … else …`, not the early-return form
  `if (…) return …; return …;` (the trailing statement isn't part of the ladder).
  Consistent with the existing dialect; not newly imposed here.
- **Construction-coercion residuals (orthogonal, deferred).** An inline object /
  string literal is not coerced to a union variant in two positions: an
  `Option<union>` **call argument** (`f(x)` where `f(p: State | undefined)`), and a
  **mixed-union array element** (`const a: State[] = ["loading", { … }]`). Use a
  typed binding (`const d: State = { … }`) at these sites. A broader
  construction-coercion sweep is a follow-up, not part of #82.

## Retained fail-loud boundary (still loud after 118)

- Recursive / self-referential unions (a) — message → #59.
- Generic unions (b) — message → #59.
- A mixed literal+object union whose **object part has no shared discriminant**.
- A mixed union consumed via the **`typeof`-split** form (using `x` as a bare
  string inside a `typeof x === "string"` branch) — if-ladder equality form only.
- Two named structs with **no distinguishing field** (both share every field) —
  `in`-narrowing is ambiguous.
- A union key/element with an **f64 payload** (a `number` field, a primitive
  union's `Num`) — the 074 `OrderedFloat` treatment is not extended to enum
  payloads here.
- `instanceof`-narrowing of a named-struct union — `in`-narrowing only.

---

## Implementation slicing (design is whole; land staged)

Order chosen so each slice is independently green:

1. **(e) hardening** — smallest, isolated to `types.ts` + `narrowing.ts` + one pin.
2. **(a)/(b) messages** — `collectUnions` detectors + two message pins.
3. **(d) Map/Set key** — `isTypeHashEq` union-awareness + `collectHashEqStructs`
   branch + derive mutation.
4. **(f) named-non-disc** — new classifier/register + `lowerType` branch +
   `coerceObjectToUnion`/`variantByUniqueField` newtype resolution.
5. **(c) mixed G** — new classifier/register + `narrow:"mixed"` +
   `recognizeMixedIfLadder` + replace the alias throw.

Specs (differentials + updated pins) in
`packages/compiler/tests/union-residuals.test.ts` — see `specs.md`. The obsolete
093 pins UN-FL3/FL4/FL6 flip from `toThrow()` to differentials (or move to the new
file); UN-FL1/FL2 gain message matchers.
