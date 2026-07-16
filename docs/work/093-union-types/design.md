# 093 — Union types → Rust `enum` — design

**Status: APPROVED (2026-07-15, Collin). Proceeding to specs → impl.**

## Decisions settled (2026-07-15, with Collin)

- **Scope:** the comprehensive model — union kinds **A–G** (§1), nothing
  fail-loud that has a workable mapping. **One series** (093), staged internally
  1a–1e (§10).
- **Fork-N3 non-discriminated unions:** **supported** (not fail-loud).
- **Anonymous-union naming (Fork-N1):** drop the readable `NorthOrSouth` synthesis.
  An **anonymous** (no-`type`-alias) union's enum is named
  **`__anonymous_union_<hash>`**, where `<hash>` is a deterministic digest over the
  **canonically-ordered** member set — so two unions of the same member *set* in a
  different *order* hash identically and dedup to one enum (§2). Named `type X = …`
  aliases keep the name `X`.
- **Fork-N2 discriminant precedence:** `kind` > `type` > `tag` > `_type` >
  leftmost-in-first-member (§3).
- **Non-union `type` aliases:** **trivial synonyms only** — `type Id = number`,
  `type P = Point` resolve transparently to a *modeled* RHS type; tuple / mapped /
  conditional / function-type aliases stay fail-loud → a later series (§8).

The first algebraic layer in the type system. TypeScript union types
(`A | B | C`) become Rust `enum`s — the single most idiomatic TS→Rust mapping
there is (closed sum type → closed sum type), and the *only* heterogeneous shape
that needs **no** `Box<dyn>`/vtable (an `enum` is sized). This supersedes the
current blanket rejection in `lowerType` (`lower.ts:12060`, which today accepts
only the nullable `T | null | undefined → Option<T>` shape).

Per Collin (2026-07-15): build the **comprehensive** model — the hard cases
(anonymous/inline unions, non-ident-safe literals, primitive unions,
non-discriminated unions) are **designed in**, not fail-loud stubs. This doc
enumerates every case with its mapping, flags the genuinely-low-confidence forks
with recommendations, and states the honest residual fail-loud boundary that
remains.

---

## 1. The union taxonomy (what we accept, and its Rust shape)

Members are classified, then the union maps by the **member kinds present**.
`null`/`undefined` members are stripped first and re-wrap the whole result in
`Option<…>` (reuses the existing 042/091 nullable path — see §7).

| # | TS union | Rust | Notes |
|---|----------|------|-------|
| A | **String-literal** `"n" \| "s"` | fieldless `enum` + `Display` | Display round-trips to the *original* literal (§4). |
| B | **Numeric-literal** `1 \| 2 \| 3` | fieldless `enum` + `Display` | Display prints the number; `From`/match by value (§4). |
| C | **Discriminated object, inline members** `{kind:"circle",r} \| {kind:"square",s}` | `enum` with **struct variants** | Discriminant field consumed into the variant name (§3). *Crown jewel.* |
| D | **Discriminated object, named-interface members** `Circle \| Square` (each an `interface` w/ a shared literal discriminant) | `enum` with **newtype variants** `Circle(Circle)` | Preserves the nominal struct; variant = interface name (§3, medium-confidence). |
| E | **Non-discriminated object** `{a:number} \| {b:string}` | `enum` with **field-named variants** | No common literal field; narrowed via `in` (§3, lowest-confidence fork). |
| F | **Primitive / mixed-type** `string \| number`, `string \| Point` | synthetic `enum` with **newtype variants** | Narrowed via `typeof` (§6). |
| G | **Mixed literal + object** `"loading" \| {kind:"done",data}` | `enum`, per-member rule | Fieldless `Loading` + struct `Done{data}`; narrowed via `typeof`/`.kind` (§6). |

All emit `#[derive(Clone, Debug, PartialEq)]` by the same field-driven derive
logic structs already use (§7), so `===` is structural — the same JS-divergence
the dialect already documents for struct `===` (series 047), and *exactly* JS
behavior for the literal cases (A/B), where value-equality is identity.

---

## 2. Naming & canonicalization (named vs anonymous)

A Rust `enum` needs a name; a TS union often has none. Two paths:

- **Named alias** — `type Shape = A | B` → `enum Shape`. The `type` alias name
  is the enum name. (Requires modeling `TSTypeAliasDeclaration`, new — §8.)
- **Anonymous / inline** — `function f(x: {kind:"a"}|{kind:"b"})`, `const d: "x"|"y"`.
  The enum is named **`__anonymous_union_<hash>`** (settled with Collin). Naming is
  *not* about readability here — it's about **structural dedup**: identical union
  structures at different sites must unify to one Rust enum (TS unions are
  structural — values flow between two spellings of the same union). The hash IS
  the canonical dedup key and is collision-free by construction, so there is **no
  readable-name synthesis and no collision-suffix logic**.

**The canonical structural key (must be order-independent).** Each member is
normalized to a signature string, the member signatures are **sorted**, joined,
and hashed. Because members are sorted before hashing, `X | Y` and `Y | X` produce
the **same** key ⇒ the same enum. Member signatures:

| Member | Signature |
|--------|-----------|
| string literal `"north"` | `lit:s:north` |
| number literal `1`, `-2` | `lit:n:1`, `lit:n:-2` |
| primitive `string`/`number`/`boolean` | `prim:string` / `prim:number` / `prim:bool` |
| named struct/interface `Point` | `nom:Point` |
| inline object `{kind:"circle",r:number}` | `obj:{kind=lit:s:circle,r=prim:number}` (fields **sorted by name**) |

`key = sort(members.map(sig)).join("|")`; `hash = fnv1a(key)` (a small
deterministic digest — the codebase forbids `Math.random`/`Date`, so a pure
string hash; first 8 hex). `name = "__anonymous_union_" + hash`. The **emitted
enum's variant order is also canonical** (variants sorted by the same key) so two
orderings emit byte-identical Rust.

> A named `type` alias keeps its name `X` (nominal). Two *different* named aliases
> that are structurally the same union stay two distinct enums (nominal, not
> deduped) — cross-assignment between them is a documented residual (§9). Anonymous
> unions dedup by hash because they have no name to be nominal about.

---

## 3. Discriminant detection & variant fields

For object-member unions (C/D/E):

1. **Find the discriminant field** — a property present in **every** member whose
   type in each member is a **single string/number literal**, with **pairwise
   distinct** values across members. 
   - Exactly one qualifying field → the discriminant.
   - **Multiple** qualifying fields (Fork-N2) → prefer by conventional name order
     `kind` > `type` > `tag` > `_type`; if none conventional, take the
     **leftmost in the first member**. Documented; deterministic.
   - **Zero** qualifying fields → non-discriminated (case E).
2. **Variant name** = the discriminant literal value, sanitized to an ident (§4):
   `kind:"circle"` → `Circle`.
3. **Variant fields** = the member's fields **minus** the discriminant field:
   `{kind:"circle", r:number}` → `Circle { r: f64 }`. A member with only the
   discriminant (`{kind:"reset"}`) → a **unit** variant `Reset`.
4. **Named-interface members (D)** → newtype variant `Circle(Circle)`; the variant
   name is the interface name; the discriminant field stays inside the struct and
   the match binds the whole struct (`Shape::Circle(c) => c.r`).

**Non-discriminated (E)** — **supported** (settled). No discriminant, so variant
names are derived from the member's **sorted field-name set**, PascalCased:
`{a:number}` → variant `A`; `{name:string,age:number}` → `AgeName` (fields sorted
for order-independence). A collision (two members with the same field-name set but
different types) → append a stable ordinal (`A`, `A2`). Narrowed by `"a" in x` →
`if let X::A{..} = x`. Construction picks the variant by matching the literal's
field-name set to a variant. This is the weakest-readability case, but per Collin
"who cares what the name" — determinism > prettiness.

---

## 4. Literal → identifier sanitization + `Display` round-trip

Variant idents must be valid Rust; the *observable* string/number must stay
exact.

- **Sanitize** (Fork-N4, recommended): split the literal on non-alphanumeric runs,
  PascalCase the segments, join. `"has-dash"` → `HasDash`; `"with space"` →
  `WithSpace`; `"snake_case"` → `SnakeCase`. A leading digit → prefix `_`:
  `"123"` → `_123`. Empty string `""` → `Empty`. All-symbol `"+++"` → `Sym1`
  (positional, since no alnum survives). Numeric-literal `1` → `_1`, `-2` → `Neg2`.
- **Collision** (two distinct literals → same ident, e.g. `"has-dash"` &
  `"has_dash"` → `HasDash`) → append a stable ordinal: `HasDash`, `HasDash2`.
  Deterministic by member order. **Never fail-loud.**
- **`Display` round-trip** — the variant ident is *cosmetic*. Each fieldless
  variant carries the original literal string; the emitted
  `impl std::fmt::Display` maps `Dir::North => write!(f, "north")`,
  `T::_1 => write!(f, "1")`. So `console.log(d)` prints the exact source literal,
  and `switch (d) { case "has-dash": }` matches on that literal via the enum
  variant. Sanitization is invisible to the program's behavior.

---

## 5. Construction (value → variant coercion)

Like `Some`-wrapping for `Option`, a value flowing into a union-typed slot
(let-init, arg, return, field, array element, reassignment) coerces to the
variant:

- **String/number literal** `const d: Dir = "north"` → `Dir::North`.
- **Discriminated object literal** `{kind:"circle", r:2}` in a `Shape` slot →
  `Shape::Circle { r: 2.0 }` (match the `kind` value to the variant; drop `kind`).
- **Primitive value (F)** — a `string` into `string|number` → `StringOrNumber::Str(v)`;
  the compiler picks the variant by the value's static type.
- **Named-interface value (D)** — a `Circle` instance → `Shape::Circle(c)`.

Construction needs a per-enum **variant registry** (`analysis.unionEnums`,
name → variants + discriminant) built in the analysis pre-pass so a literal at any
site resolves to the right variant. An object literal whose `kind` value matches
**no** variant → fail-loud (a real type error).

---

## 6. Consumption (narrowing → `match`)

All reuse `lowerSwitch` (lower.ts:5718) / the 049 `instanceof`-ladder→`match`
machinery / `HirMatchArm` (hir.ts:1089):

- **`switch (x.kind)`** over a discriminated union → `match x { Shape::Circle{r} => … }`
  (variant patterns, not string-guarded arms — the scrutinee is the enum value
  `x`, not `x.kind`; we recognize `x.kind` where `x: <union>` and rewrite).
- **`if (x.kind === "circle") … else if …`** → an `if let` / `match` ladder (same
  shape as 049's error-ladder → match). A branch reading `x.r` binds `r` from the
  pattern.
- **`typeof x === "string"`** over a primitive/mixed union (F/G) → match on the
  `Str` variant.
- **`"a" in x`** over a non-discriminated union (E) → match on the field-named
  variant.
- **Exhaustiveness / JS parity** — Rust `match` must be exhaustive; a TS `switch`
  need not be. Mirror 049: append `_ => {}` when the source has no `default` and
  the arms don't cover all variants (JS silently completes on no-match). A
  value-position match with a missing arm and no default is fail-loud (can't
  synthesize a value) — narrow it fully.

Member access `x.kind` / `x.r` needs **no** lowering change on its own (§ agent
report item 6); the recognition lives in `lowerSwitch`/the narrowing path.

---

## 7. Ownership, derives, `null` composition

- **Ownership** — an `enum` is an owned value; it moves/clones/borrows exactly
  like a struct. The existing move/borrow analysis treats it as a nominal owned
  type (no new rules). A `match` on `&x` binds fields by ref. `Shape[]` → a plain
  `Vec<Shape>` (sized) — **no `Box<dyn>`**, unlike the interface/class trait path.
- **Derives** — reuse `structDeriveClause` logic per the union of all variant
  field types: `Clone` + `Debug` always; `PartialEq` when every field is
  `PartialEq`; `Copy` only if all-Copy (rare for enums with `String` fields).
  `Hash`/`Eq` (for Map/Set keys) only for all-fieldless (literal) unions — deferred
  otherwise (§9).
- **`null`/`undefined` members** — stripped before classification; the stripped
  result wraps in `Option`. `Shape | null` → `Option<Shape>`; `"a"|"b"|undefined`
  → `Option<Dir>`. Reuses the 042/091 nullable machinery unchanged. A both-spelling
  `… | null | undefined` warns via the existing 056 channel.

---

## 8. HIR + emitter + lowering plan

**New HIR node** `HirUnionEnum` (hir.ts, parallel to `HirErrorEnum`):
```ts
export interface HirUnionEnum {
  kind: "unionEnum";
  name: string;
  variants: {
    name: string;                                  // sanitized Rust ident
    shape: "unit" | "struct" | "tuple";
    fields: { name: string; ty: RustType }[];      // struct variants (C/E)
    elems: RustType[];                             // tuple/newtype variants (D/F)
    display: string | null;                        // original literal for round-trip (A/B)
  }[];
  displayImpl: boolean;                            // emit impl Display (A/B, and mixed G unit arms)
  derives: { clone: boolean; debug: boolean; partialEq: boolean; copy: boolean };
}
```
**New emitter** `emitUnionEnum` (emitter.ts, mirrors `emitErrorEnum` at :499):
```rust
#[derive(Clone, Debug, PartialEq)]
enum Shape { Circle { r: f64 }, Square { s: f64 } }
// + when displayImpl:
impl std::fmt::Display for Dir {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self { Dir::North => write!(f, "north"), Dir::South => write!(f, "south") }
    }
}
```

**RustType**: **no new variant.** Reference a union-enum by name as
`{kind:"struct", name}` — enums already register in `analysis.structs` and
`emitType` renders a bare name (per the agent report; same as numeric enums do).

**`lowerType`** (lower.ts:12060, `TSUnionType`): after the nullable-strip, if ≥1
real member remains and it's not the single-member `Option` case → classify (§1),
canonicalize a name (§2), register/ dedup the `HirUnionEnum` in
`analysis.unionEnums`, and return `{kind:"struct", name}`.

**`TSTypeAliasDeclaration`**: add to `MODELED` (validate.ts); collect union
aliases in `analyzeModule` (analysis.ts:1407) into `analysis.structs` +
`analysis.unionEnums`; a non-union alias (`type Id = number`) resolves as a
transparent synonym (lower its RHS) — or fail-loud if out of scope this series
(decision below).

**Registration**: synthesize all `HirUnionEnum`s into `items` in the main lower
loop (lower.ts:286), before trait synthesis.

---

## 9. Honest residual fail-loud boundary (still loud after this series)

Comprehensive ≠ infinite. These stay loud, each with a precise message → a
follow-up series:

- **Recursive / self-referential unions** (`type Tree = Leaf | {kind:"node", kids: Tree[]}`)
  — needs `Box` insertion for the recursive field. Fail-loud → a follow-up.
- **Generic unions** (`type Wrap<T> = {some:T} | {none:true}`) — generics × unions
  interaction. Fail-loud → a follow-up.
- **Union as a Map/Set key** when any variant has fields (no `Hash`/`Eq`). Fieldless
  literal unions *are* hashable and allowed as keys.
- **Union member that is itself an inline union / an array/Record with no name** in
  a position we can't canonicalize — fail-loud.
- **A `switch`/ladder that narrows on a non-discriminant field** of a discriminated
  union — fail-loud "narrow on the discriminant `<field>`".

---

## 10. Suggested implementation slicing (design is whole; impl lands staged)

The design is comprehensive; the *impl* is safest staged, each stage green before
the next (all under this one series, per the spec-first flow):

- **1a** — `type`-alias modeling + **string-literal** (A) & **numeric-literal** (B)
  unions: fieldless enum, sanitize, Display round-trip, `switch`/`===` → match.
- **1b** — **discriminated inline-object** unions (C): struct variants,
  construction coercion, discriminant detection, `switch(x.kind)` → variant match.
- **1c** — **anonymous/synthesized names** (§2) across A–C + non-ident-safe literal
  hardening (§4 collisions).
- **1d** — **named-interface members** (D), **primitive/mixed** (F/G) via `typeof`.
- **1e** — **non-discriminated** (E) via `in`, *or* the fail-loud alternative
  (pending the Fork-N3 decision).

---

## Forks — all resolved (see "Decisions settled" at top)

- **Fork-N1** (anonymous naming) → `__anonymous_union_<hash>`, order-independent
  canonical key (§2).
- **Fork-N2** (multi-candidate discriminant) → `kind`>`type`>`tag`>`_type`>leftmost.
- **Fork-N3** (non-discriminated) → supported, field-set-derived variant names (§3).
- **Fork-N4** (literal sanitization) → §4 scheme as written.
- **Slicing** → one series, staged 1a–1e (§10). Non-union aliases → trivial
  synonyms only (§8).
