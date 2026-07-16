# 097 — destructuring (graduate the binding fail-loud residuals)

Fifth item in the "everyday-stuff" campaign (unions ✅ · ternary ✅ · template
literals ✅ · `++`/`--` ✅ · **destructuring** · then string methods). See the
campaign memory `093-union-types-campaign`.

## Not greenfield — a deferral-graduation

Binding destructuring is **already partly shipped** (series 067, riding 051a/075):

- `const { x, y } = point` over a **named-struct** source → `let Point { x, y } = point;`
- `const [a, b] = [1, 2]` over a **fixed-arity array literal** → `let (a, b) = (1, 2);`
- `const [a, b] = await Promise.all([…])` (051a join tuple), `const [a, b] = g()`
  (generator prefix-pull), `const { value, done } = it.next()` (075).

`dialect.md:179` ("Destructuring binding … Not yet") is **stale** — it predates 067.

This series graduates the remaining fail-loud residuals below. Everything routes
through `lowerVarDecl` (`lower.ts:7151`, returns `HirStmt[]`).

## Decisions (Collin, 2026-07-16)

1. **Array-destructure over a Vec/Array variable → Option-typed** (full #42/#66
   undefined model): `const [a, b] = arr` (`arr: T[]`) → `a: Option<T>`, `b:
   Option<T>`, out-of-bounds element → `None` (JS `undefined`).
2. **Scope**: graduate **array rest** `[head, ...tail]` **and object rest**
   `{ x, ...rest }` (via anonymous-struct synthesis), plus **renamed object
   fields** `{ x: px }`.

The undefined model this leans on is **already shipped** (066): `console.log` of an
`Option` → `fmt_opt` (None → `undefined`); `x ?? d` → `unwrap_or`; `if (x !==
undefined)` / `if (x)` → `if let Some` narrowing; `x!` → `.unwrap()`; un-narrowed
arithmetic on an `Option` → clean fail-loud. So an Option-typed element binding
flows through all of it for free.

## The residuals this series graduates

| Shape | Example | Lowers to |
|-------|---------|-----------|
| **A. Array over a Vec variable** | `const [a, b] = arr` | `let (a, b) = (arr.get(0).cloned(), arr.get(1).cloned());` — each `Option<T>` |
| **B. Renamed object field** | `const { x: px, y } = p` | `let P { x: px, y } = p;` |
| **C. Array rest** | `const [a, ...tail] = arr` | `let (a, tail) = (arr.get(0).cloned(), arr.get(1..).map(<[T]>::to_vec).unwrap_or_default());` |
| **D. Object rest** | `const { x, ...rest } = obj` | synth `__anonymous_struct_<hash>` + `let (x, rest) = (obj.x.clone(), __anonymous_struct_<hash> { y: obj.y.clone(), … });` |

Every new shape reduces to either a **struct pattern** (`let P { … } = src;`, shape
B — the existing 067 path with a widened field renderer) or a **tuple let** (`let
(n0, n1, …) = (e0, e1, …);`, shapes A/C/D — the existing `names` emission path from
051a/067). No new statement kind; one new expr building-block usage (`raw` +
`method` chains) and one new synthesized-item registry.

## Mechanism

### Identifier-source-only (keeps each shape a single `let`)

Shapes A/C/D read the source **once per binding slot**, so the source must be a
plain **identifier** (side-effect-free, cheap to re-read) — a non-identifier source
(a call, a complex expr) is a clean fail-loud residual (`… over a non-identifier
source (bind the source to a variable first)`, `requireIdentifierSource`). This
keeps every new shape a single `let` statement (no source-temp / `flatMap` needed;
`lowerVarDecl` still returns one `HirStmt` per declarator via `.map`).

### A. Array over a Vec variable (Option-typed)

In the `ArrayPattern` branch, **after** the generator / join / array-literal cases
(all of which stay unchanged), the current fail-loud `throw` (`lower.ts:7243`) is
replaced by the Vec path:

- Resolve the element type: `receiverTypeOf(source, analysis)` must be `vec(elem)`
  — else fail-loud `array-destructuring over a source whose element type is unknown`.
- Build one tuple slot per **non-rest** name `i`:
  `<src>.get(i).cloned()` as nested `method` nodes with a `raw` `"i"` index arg and
  a trailing `.cloned()` (→ `Option<T>`, `None` on OOB).
- Emit `let (a, b) = ( … );` via the `names` path; register
  `bindingTypes[name] = option(elem)` for each element name so downstream narrowing
  / `??` / fail-loud recognize them.

### C. Array rest (`[a, ...tail]`)

A `RestElement` is now **accepted** (only in tail position — a non-tail rest is a TS
error upstream). Leading names lower as in A (`Option<T>`). The rest name lowers to:

`<src>.get(<lead>..).map(<[T]>::to_vec).unwrap_or_default()`  → `Vec<T>`

(`get(n..)` returns `Option<&[T]>`; `None` when the source is shorter than the
leading count → `unwrap_or_default()` → empty vec, matching JS `[]`). Register
`bindingTypes[tail] = vec(elem)`. `<[T]>::to_vec` renders the element type via
`emitType`, carried in a `raw` arg.

### B. Renamed object fields (`{ x: px }`)

The `ObjectPattern` named-struct branch already forbids a renamed field
(`key.name !== value.name` → fail-loud, `lower.ts:7338`). Widen it: a renamed field
is allowed; the pat renderer emits `key: value` (Rust struct-pattern renaming is
native — `let P { x: px, y } = p;`). Shorthand still emits the bare field. Computed
keys and non-identifier values stay fail-loud. **BD1–BD4 emit unchanged** (all
shorthand → `P { x, y }`).

### D. Object rest (`{ x, ...rest }`) — anonymous struct synthesis

The object-rest fail-loud (`lower.ts:7331`) is replaced by:

1. Require a **named-struct source** (`sourceStructName`) — else fail-loud
   `object-rest over a non-named-struct source`. Look up its fields in
   `structFields`.
2. Partition: **kept** properties (shorthand or renamed identifiers) vs the single
   `RestElement`. The rest fields = source fields minus kept keys, in source order.
3. **Synthesize** an anonymous struct, modeled on the 093 anon-union precedent
   (`unions.ts` `fnv1a` + sorted canonical signature):
   - name `__anonymous_struct_<fnv1a("f0:T0|f1:T1|…" sorted)>` — structurally
     identical rests dedupe to one definition.
   - `HirStruct { kind:"struct", name, fields: restFields }` (field types from
     `structFields`), registered idempotently in a new
     `analysis.restStructs: Map<string, HirStruct>`; `name` added to
     `analysis.structs` and `analysis.structFields`. Derives via the standard
     `structDeriveClause` (Clone/Debug/PartialEq like any plain data struct — no
     Display).
4. Lower to a tuple let `let (<kept…>, rest) = (<src>.<kept>.clone()…,
   __anonymous_struct_<hash> { <restField>: <src>.<restField>.clone(), … });`.
   Field values are ordinary `member` reads through `lowerExpr`, so the
   ownership/rc pass inserts `.clone()` when the source stays live (mirrors the
   067 whole-source clone). Register `bindingTypes[rest] = struct(name)` and each
   kept name from `structFields`.

### Emission wiring

`items.push(...analysis.restStructs.values())` beside the existing
`analysis.litStructs` / `analysis.unionEnums` drains (`lower.ts:~400`). Each is a
`HirStruct` → the existing `emitStruct` path (derives + fields). First anonymous
**struct** synthesis in the codebase (074 struct-keys are newtypes; 093 are enums).

## Fail-loud residuals (v1)

- **Default values** — `const { x = 1 } = obj`, `const [a = 0] = arr` (an
  `AssignmentPattern` in a pattern). Needs undefined-defaulting semantics; residual.
- **Nested patterns** — `const { a: { b } } = obj`, `const [[a], b] = m`.
- **Object rest over a non-named-struct source** (anonymous object / map).
- **Array over a source with an unresolved element type.**
- **Destructuring *assignment*** — `[a, b] = [b, a]` (an `AssignmentExpression`
  with a pattern LHS, not a binding — a different code path).
- **Reassigned destructured binding needing `mut`** — the tuple-let `names` path
  carries no per-element `mut`; a later reassignment of a destructured name is a
  residual (rare in practice).
- **Non-identifier source** (`const [a, b] = getPair()`) for shapes A/C/D — bind
  the source to a variable first.
- **Rest parameter** `(...args: T[])` (variadic — distinct from a rest *binding*).

## Files touched

- `packages/compiler/src/lower.ts` — `requireIdentifierSource`/`vecElemOption`/
  `vecRest`/`synthRestStruct` helpers; Vec-array Option path + array-rest (A/C);
  renamed-field pat + object-rest anon-struct synth (B/D); `restStructs` drain; a
  `RestElement` guard in `lowerParam` (rest params stay fail-loud).
- `packages/compiler/src/analysis.ts` — `restStructs: Map<string, HirStruct>` on
  `ModuleAnalysis` (+ init).
- `packages/compiler/src/validate.ts` — allowlist `RestElement`.
- `packages/compiler/tests/destructuring.test.ts` — specs (see `specs.md`).
- `docs/dialect.md` — Variables/bindings rows + node-vocabulary `RestElement`.
- Obsolete pins flipped: `binding-destructure` BD5/BD6/BD10, `object-entries` ENT6
  (now-supported shapes); `generator-consumption-tail` GD2 (message change).

No new HIR node, no emitter change beyond draining the new registry (reuses
`structLit`, `method`, `raw`, `names` tuple-let, `emitStruct`).
