# 114 — String enums → Rust enum

Issue **#77** (`deferral-graduation`, APPROVED by Collin). Graduate the fail-loud
`enum member initializer must be an integer literal (string enums unsupported)`
into real dialect support. Numeric enums ship today (series 025a → C-like Rust
`enum` with `Copy`/`PartialEq`); string enums are the sibling gap.

## Target lowering

```ts
enum Dir { North = "north", South = "south" }
const d: Dir = Dir.North;
if (d === Dir.North) { … }
console.log(`${d}`);            // "north"
```
lowers to a **fieldless** Rust enum with a `Display` round-trip — exactly the
series-093 literal-union machinery, driven from the member name + initializer:

```rust
#[derive(Clone, Copy, Debug, PartialEq)]
enum Dir { North, South }
impl std::fmt::Display for Dir {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self { Dir::North => write!(f, "north"), Dir::South => write!(f, "south") }
    }
}
```

The variant **name** comes from the TS member (`North`); the **display string**
comes from the initializer (`"north"`). This is the one structural difference from
093 literal unions, where the variant name is *derived from* the literal
(`sanitizeVariantIdent("north") → North`).

## Why forward-only (no `FromStr`/`TryFrom<&str>`)

The issue left reverse parsing open ("`FromStr` only if the program reads a string
back into the enum"). Investigation resolves it: **TS string enums have no reverse
mapping.** `E[0]` reverse lookup exists only for *numeric* enums; `E["north"]` is a
type error, and TS never constructs a string enum from a dynamic string. So faithful
TS semantics need **no** `FromStr`/`TryFrom<&str>`. Forward mapping (`Display`) is the
complete surface. This drops the map's flagged "net-new `FromStr` emitter machinery"
from scope entirely.

## Copy-ness (settled)

A fieldless enum is `Copy` **regardless of what `Display` prints** — variants carry no
`String`; `Display` synthesizes the text on demand. So string enums keep the same
`#[derive(Clone, Copy, Debug, PartialEq)]` as numeric enums and 093 literal unions.
(The exploration map's worry that "String-valued variants are not Copy" was reasoning
about a newtype-carrying variant; a string *enum* stores nothing.) No `isCopyType`
change is needed — the enum name is already registered Copy via `analysis.enums`.

## Design: extend `HirEnum` + `emitEnum` (option B), share the Display arm generator

Two options were on the table (from the subsystem map):

- **(A) Route string enums through `HirUnionEnum`/`emitUnionEnum`** — build variants
  with `name = memberIdent`, `display = initString`; register via the 093 path. Reuses
  the `Display` arm generator, but string enums use **`E.Variant` member access**, which
  `HirUnionEnum` does **not** wire (093 unions coerce *literals*, they don't member-access),
  and union enums are emitted from `analysis.unionEnums` on a **separate** item path — so
  (A) needs new member-access resolution + a change to `lowerEnum`'s call site to avoid
  double-emit.
- **(B) Extend `HirEnum` + `emitEnum`** — add an optional `display` to `HirEnum` variants
  and branch `emitEnum` to emit `Display`.

**Chosen: (B).** Verified during impl that it is strictly *less* invasive:
`analysis.enums` is collected **initializer-agnostic** (`analysis.ts:1483-1491` adds every
`TSEnumDeclaration` name), so `E.Variant` member access (`expressions.ts:2243`), `switch`
narrowing, `===`/`PartialEq`, `isCopyType` (fieldless ⇒ Copy, `analysis.ts:705-715`), and
the `items.push(lowerEnum(...))` emission path **all already work** for a `HirEnum` string
enum with **zero** new plumbing. The only net-new code is (1) accepting string-literal
initializers in `lowerEnum` and (2) emitting `Display` in `emitEnum`. To avoid duplicating
093's arm generator, extract a shared `emitDisplayArms(enumName, variants)` helper used by
both `emitEnum` (string enums) and `emitUnionEnum` (093 literal unions).

### The one seam that forks

`lower/classes.ts:188-208` inside `lowerEnum`. Today every member initializer must be a
numeric `Literal`; the returned `HirEnum` variant records only `{name, disc}` and discards
the source spelling. The fork:

1. **Classify the enum** by its initializers: all-numeric (or bare) → existing numeric
   path, `display` absent, unchanged output. All-string-literal → set `display = initString`,
   `disc = null`. **Mixed / heterogeneous** (some numeric, some string) → fail-loud (out of
   scope, same as today).
2. `HirEnum` gains `variants: { name; disc: number | null; display?: string | null }[]`.
   A string enum is detected in `emitEnum` by any variant carrying a `display`.

### Member access / equality / switch — already work (verified)

- `Dir.North` → `Dir::North`: `expressions.ts:2243-2252` gates on `analysis.enums.has(...)`
  — already true for string enums (initializer-agnostic collection). No change.
- `d === Dir.North` → `d == Dir::North`: `PartialEq` derive, no work.
- `switch (d) { case Dir.North: … }` → `match`: the numeric-enum `switch` path already
  handles `HirEnum`. No change.

### String-context usage

`` `${d}` `` (template interpolation) → the `Display` impl (`format!("{}", d)`). This is
the same lowering literal-union values already get, and it is the primary stringify path.
Direct `const s: string = Dir.North` is a **type error in TS** (enum not assignable to
string), so it never reaches us — no implicit coercion to model.

**`String(d)` is a shared pre-existing residual, out of scope here — filed as #99.**
Verified during impl:
`String(x)` over a **093 literal union** also emits invalid `String(x)` (E0423) today — the
`String(...)` call lowering doesn't recognize an enum/union receiver for *either* feature.
Fixing it belongs in a `String()`-coercion series that covers unions and enums together, not
a one-off enum branch that would leave 093 inconsistent. Template interpolation is the
covered stringify surface for 114.

## Scope

- **In:** all-string-literal enums → fieldless Copy `HirEnum` with a `Display` impl (via
  the shared `emitDisplayArms` generator, also used by 093 `emitUnionEnum`); member access,
  `===`/`!==`, `switch`/`if` narrowing, template-interpolation stringify. Differential specs
  (`string-enums.test.ts`).
- **Out (unchanged fail-loud, each its own follow-up if ever wanted):** `const enum`;
  heterogeneous/mixed numeric+string enums; computed / non-identifier member names; any
  `FromStr`/reverse construction (not a TS behavior); `String(x)` coercion (shared residual,
  #99).

## Results (2026-07-24)

Shipped. `string-enums.test.ts` **10/10** green. `HirEnum` variants gained an optional
`display`; `lowerEnum` classifies numeric / string / (fail-loud) mixed; `emitEnum` branches
to `#[derive(Clone, Copy, Debug, PartialEq)]` + a `Display` impl for string enums, reusing
the extracted `emitDisplayArms`/`emitDisplayImpl` helpers that `emitUnionEnum` now also
calls. Member access / `switch` / `===` / Copy-ness all ride the existing numeric-enum path
unchanged. Gaps found + filed: **#98** (switch-with-`return` over an enum), **#99**
(`String(x)` over enum/union).

## Risks

- **Name-collision sanitization:** a member named a Rust keyword raw-escapes via `rid`
  (`move` → `r#move`); `Self`/`crate`/`super` fail loud (can't be raw). Covered by SE7.
- **Empty enum / single variant:** degenerate but emits valid Rust.
