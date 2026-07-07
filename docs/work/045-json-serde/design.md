# 045 — `JSON.parse` / `JSON.stringify` (serde + Value) (plan)

Decision (Collin, 2026-07-06): **serde-based**, with an untyped
`serde_json::Value` fallback for annotation-less `JSON.parse`. Depends on the
Option model (042, for `null`) and the `IndexMap` records (041, field order).

`serde_json` is pinned in the scratch crate. Generated structs derive
`Serialize`/`Deserialize` **on demand** (the `derives.ts` gated pattern), same as
`Clone`/`Debug`.

## `JSON.stringify(v)`

serde_json serializes an `f64` as `1.0`; JS wants `1`. So stringify routes to a
`tslib::json::stringify` fidelity wrapper that serializes via serde and then
applies JS number formatting (integers without a trailing `.0`, matching
`Number.prototype.toString`). Object key order is insertion order (records are
`IndexMap`; enable indexmap's `serde` feature). Supported value types: primitives,
`Vec`, `IndexMap` records, and derive-eligible structs, recursively.

```
JSON.stringify(x)  →  tslib::json::stringify(&x)   // -> String, JS number rules
```
`JSON.stringify(x, null, 2)` (pretty) → a pretty variant; extra args beyond the
value are fail-loud in the first slice except the pretty-print `(v, null, n)`.

## `JSON.parse(s)`

- **annotation-driven** (idiomatic, primary): `const x: T = JSON.parse(s)` →
  `serde_json::from_str::<T>(&s)` where `T` derives `Deserialize`. Fallible →
  `?`-propagated (the enclosing scope becomes `Result`, existing fallibility
  machinery). The target type is taken from the binding/param/return annotation.
- **untyped fallback**: `JSON.parse(s)` with no inferable target →
  `serde_json::from_str::<serde_json::Value>(&s)`. Consumption is via the `Value`
  API — a parallel dynamic surface: `v["k"]`, `v[i]`, `.as_f64()`/`.as_str()`
  when the TS reads a field/element. A minimal `Value` access mapping is provided;
  anything beyond it is fail-loud.

## HIR / emitter
- `{ kind: "jsonStringify"; value; pretty?: HirExpr }` → the `tslib` call.
- `{ kind: "jsonParse"; source; target: RustType | null }` → `from_str::<T>` /
  `from_str::<Value>`, wrapped in `try` (fallible).
- serde derive: extend `structDeriveClause` with `Serialize`/`Deserialize`, gated
  on a module actually using JSON on that struct (a `usesJson` scan), so non-JSON
  programs don't pull serde derives.

## `tslib::json`
```
stringify<T: Serialize>(v: &T) -> String     // JS number formatting
stringify_pretty<T: Serialize>(v: &T, indent: usize) -> String
```
Parity tests assert `stringify(&1.0) == "1"`, `stringify(&vec![1.0,2.0]) == "[1,2]"`,
nested struct/record output, and round-trip `parse`.

## Slices
- **045a** — `JSON.stringify` (serde + tslib number fidelity) for primitives/
  arrays/records/structs.
- **045b** — `JSON.parse` annotation-driven (`from_str::<T>`), fallible.
- **045c** — untyped `JSON.parse` → `serde_json::Value` + minimal access mapping.

## Fail-loud residuals
- `stringify` with a replacer function; `Value` access beyond the minimal
  field/index/as-primitive mapping.
