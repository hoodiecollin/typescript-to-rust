# 091 — `undefined`-omission on stringify — specs (UOM1–UOM10)

Differential = emitted Rust runs (via the `rust-oracle` crate) AND its stdout ===
the TS-via-Bun run === `expected`. Shape = emitted-Rust substring. All specs
import `stringifyJson` (and, where relevant, `parseJson`/`toJsonValue`) from
`@ttr/std`, which makes the module `usesJson` (so structs derive serde).

Reference: the TS `stringifyJson` is `JSON.stringify`, whose native
`undefined`-omission the Rust side must now match.

| ID | Intent | Source shape | Expected stdout |
|----|--------|--------------|-----------------|
| **UOM1** | optional (`?`) key, value absent → **omitted** | `interface Rec { a: number; b?: number }` · `{ a: 1 }` | `{"a":1}` |
| **UOM2** | `T \| undefined` key, value `undefined` → **omitted** | `b: number \| undefined` · `{ a: 1, b: undefined }` | `{"a":1}` |
| **UOM3** | optional key **present** → serialized (regression) | `b?: number` · `{ a: 1, b: 2 }` | `{"a":1,"b":2}` |
| **UOM4** | `T \| null` key, value `null` → **kept as `null`** | `b: number \| null` · `{ a: 1, b: null }` | `{"a":1,"b":null}` |
| **UOM5** | `T \| null \| undefined`, value `null` → **null wins** (kept) | `b: number \| null \| undefined` · `{ a: 1, b: null }` | `{"a":1,"b":null}` |
| **UOM6** | omission inside **array** elements | `Rec[]` · `[{ a: 1 }, { a: 2, b: 3 }]` | `[{"a":1},{"a":2,"b":3}]` |
| **UOM7** | omission in a **nested** struct field | `Outer { inner: Inner }`, `Inner { x: number; y?: number }` · `{ inner: { x: 1 } }` | `{"inner":{"x":1}}` |
| **UOM8** | `toJsonValue<Rec>` then stringify also omits (090 boundary) | `toJsonValue<Rec>({ a: 1 })` | `{"a":1}` |
| **UOM9** | parse-then-stringify round-trips an absent optional | `parseJson<Rec>('{"a":1}')` → `stringifyJson(value)` | `{"a":1}` |
| **UOM10** | mixed struct: `?` omitted, `\| null` kept (combined + shape) | `M { a: number; opt?: number; nul: number \| null }` · `{ a: 1, nul: null }` | `{"a":1,"nul":null}` |

## Shape assertions

- **UOM1** emitted Rust contains `#[serde(skip_serializing_if = "Option::is_none")]`
  (the `b` field carries the omission attr).
- **UOM4** the `b` field is a plain `Option<f64>` with **no** `skip_serializing_if`
  (null-bearing fields keep the key). Assert the attr count / that `nul` is bare.
- **UOM10** exactly one `skip_serializing_if` (on `opt`), none on `nul`.

## Known divergence (documented, not specced as passing)

A **both-nullable** field (`T | null | undefined`) whose key is *omitted from the
object literal* (or set to `undefined`) serializes as `null` on the Rust side
(null wins) but is *absent* on the JS side — the collapsed `Option` model can't
tell an omitted/`undefined` both-nullable field from an explicit `null` one.
"null wins" is the deliberate choice (never silently drop data); the residual
divergence is recorded in `docs/dialect.md`, not asserted green.

## Arrays are already faithful

`(T | undefined)[]` → `Vec<Option<T>>`; serde renders a `None` element as `null`,
matching JS (`[1, undefined, 2]` → `[1,null,2]`). No change; UOM6 exercises the
element-object path (the interesting case) rather than a bare `undefined` hole.
