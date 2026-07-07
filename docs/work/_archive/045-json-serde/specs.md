# 045 — specs

Differential specs in `packages/compiler/tests/json.test.ts` + tslib parity.

## 045a — JSON.stringify (serde + tslib number fidelity)
- **JSN1** `JSON.stringify(5)` → `5` (integer, not `5.0`).
- **JSN2** `JSON.stringify([1, 2, 3])` → `[1,2,3]`.
- **JSN3** `JSON.stringify(record)` → `{"a":1,"b":2}` in insertion order.
- **JSN4** `JSON.stringify(struct)` → object with fields in declaration order.
- **JSN5** a fractional number keeps its decimals (`1.5` → `1.5`).

## 045b — JSON.parse (annotation-driven)
- **JSN6** `const xs: Array<number> = JSON.parse("[1,2,3]")` → `from_str::<Vec<f64>>`;
  `xs[0]` reads back.
- **JSN7** `const p: Point = JSON.parse(s)` deserializes into a struct (derives
  `Deserialize`); a field reads back.

## 045c — untyped parse → Value (round-trip)
- **JSN8** `JSON.stringify(JSON.parse(s))` round-trips a JSON string (untyped
  `serde_json::Value`), normalized to compact form.

## tslib parity (`crates/tslib/tests/parity.rs`)
- `stringify(&1.0) == "1"`, `stringify(&vec![1.0,2.0]) == "[1,2]"`,
  `stringify(&1.5) == "1.5"`, nested object order preserved.
