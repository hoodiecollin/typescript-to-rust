# 090 — dynamic/recursive value model (`JsonValue`), increment 1 — specs

Spec prefix **JSV**. Differential (TS-via-Bun vs Rust-run stdout) + shape
(emitted-Rust substring) + fail-loud (throws with the redirect / accessor
message). Programs `import { parseJsonValue, fromJsonValue, toJsonValue,
JsonValue } from "@ttr/std"`. Test file:
`packages/compiler/tests/json-value.test.ts`.

The `serde(transparent)` newtype means the Bun-run wrapper and the Rust
`tslib::json::JsonValue` observe the identical tree, so every non-fail-loud spec
asserts `rust.stdout === runTs(src)`.

## Dynamic parse + coercion

- **JSV1** — parse an object, coerce a field:
  `const r = parseJsonValue('{"n":5}'); if (r.ok) console.log(r.value.get("n").asNumber());`
  → `5` (differential; emits `ParseResult::<tslib::json::JsonValue>::parse`).
- **JSV2** — parse a string scalar: `parseJsonValue('"hi"')`, `r.value.asString()`
  → `hi` (differential).
- **JSV3** — parse a bool scalar: `parseJsonValue('true')`, `r.value.asBool()`
  → `true` (differential).
- **JSV4** — the error branch on invalid JSON:
  `const r = parseJsonValue('nope'); if (!r.ok) console.log('bad');` → `bad`
  (differential — both take the error branch, no throw).

## Navigation

- **JSV5** — nested object navigation:
  `r.value.get("a").get("b").asNumber()` over `{"a":{"b":7}}` → `7` (differential).
- **JSV6** — array indexing: `r.value.at(1).asNumber()` over `[10,20,30]` → `20`
  (differential; emits `.at(`).
- **JSV7** — absent key yields Null (no throw):
  `r.value.get("missing").isNull()` over `{"a":1}` → `true` (differential —
  absent-key is a `Null` value, not an error).
- **JSV8** — out-of-bounds index yields Null: `r.value.at(9).isNull()` over
  `[1,2]` → `true` (differential).
- **JSV9** — `.length` on an array: `r.value.length` over `[1,2,3,4]` → `4`
  (differential; `.length` property → `.length()` method).

## Type guards

- **JSV10** — guards discriminate shape:
  over `{"x":1}` — `r.value.isObject()` → `true`, `r.value.isArray()` → `false`,
  `r.value.get("x").isNumber()` → `true` (differential; one program printing three
  booleans).
- **JSV11** — heterogeneous array elements navigated by guard:
  over `[1,"two",true]` — loop `at(i)`, print `isNumber()/isString()/isBool()`
  per element → `true false false` / `false true false` / `false false true`
  (differential — the heterogeneous case the static wall rejects, now reachable
  via the opt-in dynamic type).

## Static ⇄ dynamic boundary

- **JSV12** — `fromJsonValue<T>` into a modeled struct:
  navigate to a sub-object, then `const p = fromJsonValue<Point>(r.value.get("pt"));
  if (p.ok) console.log(p.value.x);` over `{"pt":{"x":3,"y":4}}` → `3`
  (differential; emits `ParseResult::<Point>::from_value`).
- **JSV13** — `toJsonValue<T>` from a modeled struct, then stringify:
  `const v = toJsonValue<Point>({x:1,y:2}); console.log(stringifyJson(v));`
  → `{"x":1,"y":2}` (differential; emits `serde_json::to_value`).
- **JSV14** — `stringifyJson` on a parsed `JsonValue` round-trips:
  `stringifyJson(parseJsonValue('{"a":1,"b":[2,3]}').value)` → `{"a":1,"b":[2,3]}`
  (differential; key order preserved via `preserve_order`).

## Fail-loud

- **JSV15** — coercion mismatch is fail-loud (differential *throw*): under Bun
  `r.value.asNumber()` on a string throws; the emitted Rust `panic!`s — assert the
  Rust run is a runtime error (not a silent value). (Harness: assert `rr.ok` is
  false / non-zero exit, message mentions `asNumber`.)
- **JSV16** — navigating into a non-container is fail-loud: `.get("k")` on a
  number value → error mentioning `get`/non-object.
- **JSV17** — an unknown accessor on a `JsonValue` binding
  (`r.value.floor()`) → compile-time `UnsupportedError` listing the available
  accessors.
- **JSV18** — `JsonValue` used as a map/set key → fail-loud (not hashable).
- **JSV19** — bare `JSON.parse` redirect message now names **both** paths:
  `parseJson<T>` (modeled) and `parseJsonValue` (dynamic).
- **JSV20** — the `any` wall is untouched: a bare `any` annotation still throws the
  `DialectError` (regression guard — the opt-in `JsonValue` did not reopen `any`).
