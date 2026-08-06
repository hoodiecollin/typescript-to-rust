/**
 * Specs for series 091 — faithful `undefined`-omission on stringify (epic #59,
 * increment 2). JS `JSON.stringify` omits an `undefined`-valued object key but
 * keeps a `null`-valued one; the dialect collapses `T | null` and `T | undefined`
 * to a flavourless `Option<T>`, so serde used to render every `None` as `null`.
 *
 * Fix (compiler-side only, no tslib change): recover the null-vs-undefined
 * flavour from the declared annotation and emit
 * `#[serde(skip_serializing_if = "Option::is_none")]` on `undefined`-only fields
 * so serde omits the key. `null`-bearing fields keep the key (null wins).
 *
 * Differential (TS-via-Bun `stringifyJson` === Rust) + emitted-Rust shape.
 * IDs map to series 091 (UOM1–UOM10).
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

const S = `import { stringifyJson } from "@ttr/std";\n`;

defineDifferential("undefined-omission", [
  {
    name: "UOM1 optional (`?`) key, value absent → omitted",
    src: `${S}interface Rec { a: number; b?: number }
const p: Rec = { a: 1 };
console.log(stringifyJson(p));`,
    expected: '{"a":1}',
    extra: ({ rust }) =>
      expect(rust).toContain('#[serde(skip_serializing_if = "Option::is_none")]'),
  },
  {
    name: "UOM2 `T | undefined` key, value undefined → omitted",
    src: `${S}interface Rec { a: number; b: number | undefined }
const p: Rec = { a: 1, b: undefined };
console.log(stringifyJson(p));`,
    expected: '{"a":1}',
  },
  {
    name: "UOM3 optional key present → serialized (regression)",
    src: `${S}interface Rec { a: number; b?: number }
const p: Rec = { a: 1, b: 2 };
console.log(stringifyJson(p));`,
    expected: '{"a":1,"b":2}',
  },
  {
    name: "UOM4 `T | null` key, value null → kept as null",
    src: `${S}interface Rec { a: number; b: number | null }
const p: Rec = { a: 1, b: null };
console.log(stringifyJson(p));`,
    expected: '{"a":1,"b":null}',
    extra: ({ rust }) =>
      // The `b` field is a bare Option — no omission attr (null-bearing keeps the key).
      expect(rust).not.toContain('#[serde(skip_serializing_if = "Option::is_none")]'),
  },
  {
    name: "UOM5 `T | null | undefined`, value null → null wins (kept)",
    src: `${S}interface Rec { a: number; b: number | null | undefined }
const p: Rec = { a: 1, b: null };
console.log(stringifyJson(p));`,
    expected: '{"a":1,"b":null}',
  },
  {
    name: "UOM6 omission inside array elements",
    src: `${S}interface Rec { a: number; b?: number }
const xs: Rec[] = [{ a: 1 }, { a: 2, b: 3 }];
console.log(stringifyJson(xs));`,
    expected: '[{"a":1},{"a":2,"b":3}]',
  },
  {
    name: "UOM7 omission in a nested struct field",
    src: `${S}interface Inner { x: number; y?: number }
interface Outer { inner: Inner }
const o: Outer = { inner: { x: 1 } };
console.log(stringifyJson(o));`,
    expected: '{"inner":{"x":1}}',
  },
  {
    name: "UOM8 toJsonValue<Rec> then stringify also omits (090 boundary)",
    src: `import { stringifyJson, toJsonValue } from "@ttr/std";
interface Rec { a: number; b?: number }
const v = toJsonValue<Rec>({ a: 1 });
console.log(stringifyJson(v));`,
    expected: '{"a":1}',
  },
  {
    name: "UOM9 parse-then-stringify round-trips an absent optional",
    src: `import { parseJson, stringifyJson } from "@ttr/std";
interface Rec { a: number; b?: number }
const r = parseJson<Rec>('{"a":1}');
if (r.ok) { console.log(stringifyJson(r.value)); }`,
    expected: '{"a":1}',
  },
  {
    name: "UOM10 mixed struct: `?` omitted, `| null` kept",
    src: `${S}interface M { a: number; opt?: number; nul: number | null }
const p: M = { a: 1, nul: null };
console.log(stringifyJson(p));`,
    expected: '{"a":1,"nul":null}',
    extra: ({ rust }) => {
      const attrs = rust.match(
        /#\[serde\(skip_serializing_if = "Option::is_none"\)\]/g,
      );
      expect(attrs?.length ?? 0).toBe(1); // exactly one omission attr (on `opt`)
    },
  },
]);

// A sanity compile check that the omission attr rides only on serde-derived structs.
test("UOM-shape omission attr appears above the optional field", () => {
  const rust = compile(
    `${S}interface Rec { a: number; b?: number }
const p: Rec = { a: 1 };
console.log(stringifyJson(p));`,
  );
  expect(rust).toMatch(
    /#\[serde\(skip_serializing_if = "Option::is_none"\)\]\s*\n\s*b: Option<f64>,/,
  );
});
