# 090 — dynamic/recursive value model (`JsonValue`), increment 1 — design

Epic **#59** (the shared root behind several deferred residuals). Increment 1 only:
the **JSON boundary** — untyped parse → a dynamic value, an explicit
navigation/coercion surface, stringify back, and the static⇄dynamic crossings.
Builds directly on series **084** (the `@ttr/std` shim lane + `ParseResult<T>`).

## What this is

The dialect statically types every value and **forbids `any`** (a hard
`DialectError` at `validate.ts:232`) and heterogeneous unions (`lower.ts:11607`).
Several deferred residuals share one missing capability: a value whose
shape/depth isn't statically known. This series adds that capability as an
**opt-in, named, dynamically-checked type** — it does **not** reopen `any`. The
`any` wall stays exactly where it is; a program reaches the dynamic world only by
explicitly importing `JsonValue` from `@ttr/std` and crossing a labelled boundary.

```ts
import { parseJsonValue, fromJsonValue, JsonValue } from "@ttr/std";

const r = parseJsonValue(input);            // ParseResult<JsonValue>
if (r.ok) {
  const v = r.value;                        // JsonValue
  if (v.isObject() && v.get("age").isNumber()) {
    console.log(v.get("name").asString(), v.get("age").asNumber());
  }
}
```

## Decided parameters (settled 2026-07-15 — do not re-litigate)

- **Representation: `serde_json::Value`, re-exported through `tslib` as a
  serde-transparent newtype.** `serde_json` is already a `tslib` dep with
  `preserve_order` on (object key order matches JS insertion order). We wrap it in
  a newtype so we can hang **inherent** accessor methods on it without colliding
  with `serde_json::Value`'s own `.get`/`.as_f64`/… :

  ```rust
  #[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
  #[serde(transparent)]
  pub struct JsonValue(pub serde_json::Value);
  ```

  `#[serde(transparent)]` makes it deserialize/serialize exactly as the inner
  `Value`, so it drops straight into the 084 `ParseResult<T>` and `stringify`
  machinery with no special-casing.
- **Opt-in surface: an `@ttr/std` type + functions.** The type `JsonValue` and the
  functions `parseJsonValue` / `fromJsonValue` / `toJsonValue` are recognized by
  the reserved specifier (never a name heuristic). Recognition is extended to a
  **type-position** intrinsic for the first time (084 recognized only call
  intrinsics).
- **First increment: parse + navigate + stringify** (the JSON boundary). The
  jagged-`flat`/`flat(Infinity)`/`flatMap`-`U|U[]` residuals (`lower.ts:9282`,
  `:9963`) and faithful `undefined`-omission provenance (`json.rs`) are **later
  increments** that consume this same `JsonValue` — explicitly out of scope here.
- **Access surface: explicit accessors** (methods on `JsonValue`). Operations are
  dynamically checked; converting to/from a static `T` is an explicit function
  call. No transparent `v.key` / `v[i]`.
- **Coercion mismatch is fail-loud** (throw in TS / `panic!`+`.expect` in Rust),
  differential-matched. The safe path is guarding with `.isNumber()` / `.isString()`
  / `.isArray()` / … first. Absent object keys and out-of-bounds indices are **not**
  errors — they yield a `Null` `JsonValue` (so `.isNull()` distinguishes and
  chaining `v.get("a").get("b")` is safe); navigating *into a non-container*
  (`.get` on a number, `.at` on an object) **is** fail-loud.

## The access surface (increment 1)

Methods on a `JsonValue` binding:

| TS (accessor)     | Rust (inherent method)     | Semantics |
|-------------------|----------------------------|-----------|
| `.get(key)`       | `.get(key: &str)`          | object → member (`Null` if absent); non-object → panic |
| `.at(i)`          | `.at(i: f64)`              | array → element (`Null` if OOB); non-array → panic |
| `.asNumber()`     | `.as_number()`             | number → `f64`; else panic |
| `.asString()`     | `.as_string()`             | string → `String`; else panic |
| `.asBool()`       | `.as_bool()`               | bool → `bool`; else panic |
| `.isNull()`       | `.is_null()`               | `bool` |
| `.isNumber()`     | `.is_number()`             | `bool` |
| `.isString()`     | `.is_string()`             | `bool` |
| `.isBool()`       | `.is_bool()`               | `bool` |
| `.isArray()`      | `.is_array()`              | `bool` |
| `.isObject()`     | `.is_object()`             | `bool` |
| `.length`         | `.length()`                | array → element count `f64`; else panic. **Property** in TS → method call in Rust. |

Any other method on a `JsonValue` binding is fail-loud
(`.<m> on a JsonValue — only get/at/asNumber/asString/asBool/isNull/isNumber/isString/isBool/isArray/isObject/length are available`).

## The boundary functions

- **`parseJsonValue(s: string): ParseResult<JsonValue>`** — dynamic parse. Lowers
  to the **existing 084 parse HIR** with `target = { kind: "jsonValue" }`:
  `tslib::json::ParseResult::<tslib::json::JsonValue>::parse(&s)`. Reuses the
  `ParseResult` `.ok`/`.value`/`.error` surface and `parseResultBindings` routing
  unchanged. (A distinct name — not `parseJson<JsonValue>` — because the TS
  reference must return a real wrapper *instance*, and type arguments are erased at
  runtime under Bun.)
- **`fromJsonValue<T>(v: JsonValue): ParseResult<T>`** — dynamic → static. New HIR
  `{ kind: "fromJsonValue", value, target }`; `target` validated by the existing
  `assertModeledParseTarget`. Emits
  `tslib::json::ParseResult::<T>::from_value(v.0)` (a new `from_value` ctor on
  `ParseResult`, mirroring `parse`, over `serde_json::from_value`).
- **`toJsonValue<T>(x: T): JsonValue`** — static → dynamic. New HIR
  `{ kind: "toJsonValue", value }`; emits
  `tslib::json::JsonValue(serde_json::to_value(&x).expect("toJsonValue"))`.
- **`stringifyJson(v)`** (084) accepts a `JsonValue` unchanged — the newtype is
  `Serialize`, so `tslib::json::stringify(&v)` just works. (TS reference: the
  wrapper's `toJSON()` returns the raw value, so `JSON.stringify(v)` matches.)

## Rust side — `crates/tslib/src/json.rs` (extend)

Add the `JsonValue` newtype + its inherent accessors (fail-loud panics with clear
messages), and a `ParseResult::from_value` constructor:

```rust
impl<T: serde::de::DeserializeOwned> ParseResult<T> {
    pub fn from_value(v: serde_json::Value) -> ParseResult<T> {
        match serde_json::from_value::<T>(v) {
            Ok(val) => ParseResult { ok: true,  value: Some(val), error: None },
            Err(e)  => ParseResult { ok: false, value: None, error: Some(e.to_string()) },
        }
    }
}
```

`get`/`at` return an **owned** `JsonValue` (clone out of the tree) so chaining and
binding are ownership-clean; `as_*` return owned scalars. `length` returns `f64`
(the dialect's `number`).

## TS side — `packages/std/index.ts` (reference-only, run under Bun)

A `JsonValue` class wrapping the raw parsed value, with methods mirroring the Rust
inherent methods exactly, and `toJSON()` so `stringifyJson` serializes the raw
tree. `parseJsonValue` wraps `new JsonValue(JSON.parse(s))` inside the same
`ParseResult` shape 084 uses (`{ ok, value }` / `{ ok, error }`).
`fromJsonValue<T>`/`toJsonValue<T>` mirror `from_value`/`to_value`. (The compiler
never compiles this body — it emits `tslib::json::…` directly; the body exists so
the Bun-run differential is faithful.)

Absent-key/OOB → a `JsonValue(null)`; non-container navigation and coercion
mismatch → `throw`, matching the Rust panics.

## Compiler wiring

- **Recognition** (`std-shim.ts`): add `parseJsonValue`, `fromJsonValue`,
  `toJsonValue`, and the **type** `JsonValue` to `STD_SHIM_EXPORTS`. Collect a
  local-alias → intrinsic map for the type position (a `stdShimTypes` binding,
  parallel to the value bindings) so `import { JsonValue as JV }` is honored.
- **`RustType`** (`hir.ts`): add `{ kind: "jsonValue" }` (a singleton). Cases:
  `emitType` → `tslib::json::JsonValue`; `sameRustType` (two `jsonValue` are same);
  `isCopyRustType` → `false`; `isHashable`/map-set-key eligibility → `false`
  (a dynamic value is not a modeled key). `assertModeledParseTarget` **accepts**
  `jsonValue` (serde-deserializable) so `fromJsonValue<JsonValue>` and nested
  `Array<JsonValue>`/`Record<string,JsonValue>` targets are legal.
- **`lowerType`**: a `TSTypeReference` whose name resolves to the `JsonValue` shim
  type → `{ kind: "jsonValue" }`.
- **Lowering** (`lower.ts`, `lowerStdShimCall`): route the three new intrinsics;
  record `JsonValue`-typed bindings in `bindingTypes` (so `const v = r.value` and
  `const w = v.get("k")` both carry the `jsonValue` type and their `.get`/`.asX`
  route to the accessor surface). Method access on a `jsonValue`-typed binding
  maps the accessor table above; `.length` routes as a **member→method**
  (property in TS, `.length()` in Rust). Unknown accessor → fail-loud.
- **Emitter**: `case "fromJsonValue"` / `case "toJsonValue"`; the accessor methods
  reuse the generic `case "method"` emit with the TS→Rust name map
  (`asNumber`→`as_number`, `isArray`→`is_array`, …).

## Fail-loud (unchanged walls + new redirects)

- **`any`** stays a hard `DialectError` (`validate.ts:232`) — untouched.
- **Bare `JSON.parse`** stays fail-loud; its redirect message gains a second arm:
  for a dynamic/unknown shape, use `parseJsonValue`; for a modeled shape,
  `parseJson<T>`.
- **Coercion mismatch / non-container navigation / unknown accessor** →
  fail-loud (above).
- The jagged-`flat`/`flatMap`-union residuals keep their current `→ #59` messages
  (this increment does not yet consume `JsonValue` there).

## dialect.md

Add a **JSON dynamic value** bullet to the "Semantic divergences" section:
`JsonValue` is an opt-in dynamic type; absent object keys / OOB indices yield a
`Null` value (JS `undefined`) rather than throwing, while coercion mismatch and
navigating into a non-container are fail-loud (JS would silently produce
`undefined`/`NaN`). Pin with a fixture.

## Scope boundary (explicitly out — later increments of #59)

- Jagged / dynamic-depth `flat(n)` / `flat(Infinity)`; `flatMap` `U|U[]` callbacks
  (they will produce/consume `JsonValue::Array`).
- Faithful `undefined`-omission on stringify (null-vs-undefined **provenance**).
- Object key enumeration (`.keys()`/`.entries()` over a dynamic object),
  `.push`/mutation of a dynamic array, deep-equality of `JsonValue`.
- Using `JsonValue` as a map/set key (not hashable).
