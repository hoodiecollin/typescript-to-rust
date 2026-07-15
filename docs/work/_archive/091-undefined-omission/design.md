# 091 — faithful `undefined`-omission on stringify — design

Epic **#59**, increment 2 (the second consumer of the series-090 `JsonValue`
world, though this increment touches the *static* struct path, not `JsonValue`
itself). Builds on series **045** (`JSON.stringify` fidelity / `stringifyJson`)
and **042/066** (the `Option<T>` nullability model).

## The residual

JS `JSON.stringify` treats an **`undefined`-valued object key** and a
**`null`-valued object key** differently:

```js
JSON.stringify({ a: 1, b: undefined }) // → '{"a":1}'        (undefined key OMITTED)
JSON.stringify({ a: 1, b: null })      // → '{"a":1,"b":null}' (null key KEPT)
JSON.stringify([1, undefined, 2])      // → '[1,null,2]'      (undefined in ARRAY → null)
```

The dialect collapses **both** `T | null` and `T | undefined` (and `x?: T`) to a
single, flavourless `Option<T>` at `lower.ts` `lowerType` (the `TSUnionType`
arm, ~line 11950) — a `None` carries no record of whether it came from `null` or
`undefined`. serde's default serialization renders every `None` as `null`, so a
struct field that was `undefined` wrongly stringifies as `"key":null` instead of
being omitted. This is the `045` fidelity gap flagged in the `090` design as a
later increment.

Arrays are **already correct**: `(T | undefined)[]` → `Vec<Option<T>>`, and serde
renders a `None` element as `null` — exactly JS's array behaviour. Only object
*keys* need omission.

## Decision (settled 2026-07-15 with Collin — do not re-litigate)

**Declared-type-driven provenance, recovered at struct-emit time.** Keep the
`Option<T>` runtime representation unchanged (no memory-model rewrite). Recover
the null-vs-undefined flavour from the field's **declared annotation** and, for
`undefined`-only fields, emit `#[serde(skip_serializing_if = "Option::is_none")]`
on the generated struct field so serde omits the key when the value is `None`.

### The omission rule

A struct field omits its key from JSON (`None` → absent) **iff its nullishness is
`undefined`-only**:

| Declared field            | `hasUndef` | `hasNull` | Omit? | `None` stringifies as |
|---------------------------|:----------:|:---------:|:-----:|-----------------------|
| `x: T` (non-nullish)      |     –      |     –     |  no   | (field is not `Option`) |
| `x?: T`                   |    yes     |    no     | **yes** | *(key omitted)*     |
| `x: T \| undefined`       |    yes     |    no     | **yes** | *(key omitted)*     |
| `x: T \| null`            |    no      |    yes    |  no   | `null`                |
| `x: T \| null \| undefined` |  yes     |    yes    |  no   | `null`                |
| `x?: T \| null`           |    yes     |    yes    |  no   | `null`                |

- `hasUndef` = the field is optional (`?`) **or** its annotation is / contains
  `TSUndefinedKeyword`.
- `hasNull` = its annotation is / contains `TSNullKeyword`.
- **Omit ⟺ `hasUndef && !hasNull`.** When both are present, **`null` wins**
  (Collin's call): the key is kept and serializes as `null`. This is the
  JS-faithful choice for the *common* shapes and is honest about the fact that a
  runtime `None` from a both-nullable field can't be disambiguated — we keep the
  key (never silently drop data).

An implicitly-`undefined` **class** field (declared `T`, never ctor-assigned nor
initialized → `source: "none"` → implicit `Option<T>`, `None` at construction) is
`undefined`-flavoured and **omits**.

### Why not a runtime 3-state value

A distinct `Null` / `Undefined` runtime enum would be fully faithful (it would
also fix `console.log` "null" vs "undefined" and `===`) but is a large
memory-model rewrite rippling through every series (generators, narrowing,
arithmetic, params). Out of scope for the stringify residual; the declared-type
approach is faithful for every modeled field and touches only field-lowering +
struct-emit.

## Implementation plan

No `crates/tslib` change — serde's `to_value` (the single funnel behind
`stringifyJson`, `JSON.stringify`→045 writer, and `toJsonValue`) already honours
`#[serde(skip_serializing_if)]`. The whole change is compiler-side.

1. **`hir.ts`** — add an optional `omitIfNone?: boolean` to `HirStruct.fields[]`
   (`{ name; ty; omitIfNone? }`).
2. **`lower.ts`** — a helper
   `fieldOmitsUndefined(annotation: TSType, optional: boolean): boolean`
   implementing the rule above. Set `omitIfNone` at the three struct-field build
   sites:
   - `lowerInterface` own fields (~3555) — `fieldOmitsUndefined(annotation, m.optional)`.
   - Inherited interface fields already carry `omitIfNone` (copied objects).
   - `planClassFields` (~7254) — carry `omitIfNone` on `ClassFieldPlan`; `true`
     for a `source: "none"` field, else `fieldOmitsUndefined(annotation, f.optional)`;
     thread through `lowerClass`'s `fields.map` (~3791).
3. **`emitter.ts`** `emitStruct` — when the struct actually derives serde
   (`derive` string contains `serde::Serialize`) **and** `field.omitIfNone`,
   prepend `#[serde(skip_serializing_if = "Option::is_none")]` above the field.
   Gate on the *derive presence* (not just `usesJson`) so a bare `#[serde(...)]`
   never lands on a non-serde struct (that would be an "unknown attribute"
   compile error).

## Fail-loud / out of scope

- Top-level `stringifyJson(undefined)` (JS returns the value `undefined`, not a
  string) — the dialect has no bare-`undefined` value surface; remains as-is.
- `console.log`/`===` null-vs-undefined distinction — explicitly *not* changed
  (that is the runtime-3-state path we rejected).

## Specs → `packages/compiler/tests/undefined-omission.test.ts` (UOM1–UOM10)

Differential (TS-via-Bun `stringifyJson` vs Rust) + emitted-Rust shape +
regressions. IDs map to `specs.md`.
