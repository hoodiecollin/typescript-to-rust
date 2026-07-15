# 084 — `@t2r/std` std-shim, Tier A — specs

Spec prefix **STD**. Differential (TS-via-Bun vs Rust-run stdout) + shape
(emitted-Rust substring) + fail-loud (throws with the redirect message). All
programs `import { … } from "@t2r/std"`; the harness resolves the workspace
package under Bun. Test file: `packages/compiler/tests/std-shim.test.ts`.

## `stringifyJson` (reuses the 045 writer, behind the shim)

- **STD1** — an integer prints without a decimal: `stringifyJson(5)` → `5`
  (differential; emits `tslib::json::stringify`).
- **STD2** — an array: `stringifyJson([1, 2, 3])` → `[1,2,3]`.
- **STD3** — a record in insertion order: `{ "a": 1, "b": 2 }` → `{"a":1,"b":2}`.
- **STD4** — a struct in declaration order: `Point{x,y}` → `{"x":1,"y":2}`.
- **STD5** — a fractional number keeps decimals: `stringifyJson(1.5)` → `1.5`.
- **STD6** — an aliased import (`import { stringifyJson as sj }`) still routes
  (recognition is by specifier, not name): `sj(5)` → `5`.

## `parseJson<T>` (→ `ParseResult<T>`)

- **STD7** — parse into a struct, read on the ok branch:
  `const r = parseJson<Point>('{"x":3,"y":4}'); if (r.ok) console.log(r.value.x, r.value.y);`
  → `3 4` (differential; emits `ParseResult::<Point>::parse`).
- **STD8** — parse into an array type: `parseJson<Array<number>>("[10,20,30]")`,
  read `r.value[1]` on ok → `20`.
- **STD9** — the error branch: `const r = parseJson<Point>("not json"); if (!r.ok) console.log("bad");`
  → `bad` (differential — both TS and Rust take the error branch, no throw).
- **STD10** — `.ok` is a plain boolean usable in the condition; the value is only
  read under the proven-ok branch (accessor is consuming) → differential round
  trip `parseJson<Point>(stringifyJson(p))` reconstructs `p`.

## Fail-loud (forbid bare JSON + redirect)

- **STD11** — bare `JSON.stringify(x)` → throws `UnsupportedError` mentioning
  `stringifyJson` and `@t2r/std`.
- **STD12** — bare `JSON.parse(s)` (untyped) → throws mentioning `parseJson` and
  `@t2r/std`.
- **STD13** — `const p: Point = JSON.parse(s)` (the old 045 annotation-driven
  form) → throws mentioning `parseJson` (the 045 path is gone).
- **STD14** — `parseJson(s)` with **no** type argument → throws mentioning a
  modeled type argument.
- **STD15** — an `@t2r/std` import of an unknown name
  (`import { nope } from "@t2r/std"`) → throws mentioning it is not exported by
  `@t2r/std`.
- **STD16** — an import from any other bare specifier
  (`import { x } from "lodash"`) → throws mentioning only `@t2r/std` is
  recognized.

## Migrated 045 specs

The 045 `json.test.ts` (JSN1–JSN8) is retired: JSN1–JSN5 → STD1–STD5 (via
`stringifyJson`); JSN6–JSN7 → STD7–STD8 (via `parseJson<T>`); JSN8 (untyped
`Value` round-trip) is dropped — the untyped `Value` surface is removed with bare
`JSON.parse`. The bare-`JSON.*` fail-loud is newly asserted (STD11–STD13).
