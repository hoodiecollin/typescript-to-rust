/**
 * Specs for series 090 — the dynamic/recursive value model (`JsonValue`),
 * increment 1: the JSON boundary (issue #59). An opt-in, named, dynamically
 * checked type reached only by importing `JsonValue` from `@ttr/std` — it does
 * NOT reopen `any`. Builds on series 084 (`ParseResult<T>` + the shim lane):
 * `parseJsonValue` lowers to `ParseResult::<tslib::json::JsonValue>::parse`, and
 * a `serde(transparent)` newtype means the Bun-run wrapper and the Rust value
 * observe the identical tree, so every non-fail-loud spec differential-matches.
 *
 * Differential (TS-via-Bun vs Rust) + shape (emitted-Rust substring) + fail-loud
 * (runtime panic via `expectFail`, or compile-time reject via plain `test`).
 * IDs map to docs/work/090-json-value/specs.md (JSV1–20).
 */

import { describe, expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";
import { DialectError } from "../src/errors";
import { UnsupportedError } from "../src/errors";

const IMPORT = `import { parseJsonValue, fromJsonValue, toJsonValue, stringifyJson, JsonValue } from "@ttr/std";\n`;
const P = `import { parseJsonValue } from "@ttr/std";\n`;

defineDifferential("json-value", [
  // ── Dynamic parse + coercion ──────────────────────────────────────────────
  {
    name: "JSV1 parse an object, coerce a field",
    src: `${P}const r = parseJsonValue('{"n":5}');
if (r.ok) { console.log(r.value.get("n").asNumber()); }`,
    expected: "5",
    extra: ({ rust }) =>
      expect(rust).toContain("ParseResult::<tslib::json::JsonValue>::parse"),
  },
  {
    name: "JSV2 parse a string scalar",
    src: `${P}const r = parseJsonValue('"hi"');
if (r.ok) { console.log(r.value.asString()); }`,
    expected: "hi",
  },
  {
    name: "JSV3 parse a bool scalar",
    src: `${P}const r = parseJsonValue('true');
if (r.ok) { console.log(r.value.asBool()); }`,
    expected: "true",
  },
  {
    name: "JSV4 the error branch on invalid JSON (no throw)",
    src: `${P}const r = parseJsonValue('nope');
if (!r.ok) { console.log('bad'); }`,
    expected: "bad",
  },

  // ── Navigation ────────────────────────────────────────────────────────────
  {
    name: "JSV5 nested object navigation",
    src: `${P}const r = parseJsonValue('{"a":{"b":7}}');
if (r.ok) { console.log(r.value.get("a").get("b").asNumber()); }`,
    expected: "7",
  },
  {
    name: "JSV6 array indexing",
    src: `${P}const r = parseJsonValue('[10,20,30]');
if (r.ok) { console.log(r.value.at(1).asNumber()); }`,
    expected: "20",
    extra: ({ rust }) => expect(rust).toContain(".at("),
  },
  {
    name: "JSV7 absent key yields Null (no throw)",
    src: `${P}const r = parseJsonValue('{"a":1}');
if (r.ok) { console.log(r.value.get("missing").isNull()); }`,
    expected: "true",
  },
  {
    name: "JSV8 out-of-bounds index yields Null",
    src: `${P}const r = parseJsonValue('[1,2]');
if (r.ok) { console.log(r.value.at(9).isNull()); }`,
    expected: "true",
  },
  {
    name: "JSV9 .length on an array (property → method)",
    src: `${P}const r = parseJsonValue('[1,2,3,4]');
if (r.ok) { console.log(r.value.length); }`,
    expected: "4",
    extra: ({ rust }) => expect(rust).toContain(".length()"),
  },

  // ── Type guards ───────────────────────────────────────────────────────────
  {
    name: "JSV10 guards discriminate shape",
    src: `${P}const r = parseJsonValue('{"x":1}');
if (r.ok) {
  console.log(r.value.isObject());
  console.log(r.value.isArray());
  console.log(r.value.get("x").isNumber());
}`,
    expected: "true\nfalse\ntrue",
  },
  {
    name: "JSV11 heterogeneous array elements navigated by guard",
    src: `${P}const r = parseJsonValue('[1,"two",true]');
if (r.ok) {
  for (let i = 0; i < r.value.length; i = i + 1) {
    const e = r.value.at(i);
    console.log(e.isNumber(), e.isString(), e.isBool());
  }
}`,
    expected: "true false false\nfalse true false\nfalse false true",
  },

  // ── Static ⇄ dynamic boundary ─────────────────────────────────────────────
  {
    name: "JSV12 fromJsonValue<T> into a modeled struct",
    src: `${IMPORT}interface Point { x: number; y: number; }
const r = parseJsonValue('{"pt":{"x":3,"y":4}}');
if (r.ok) {
  const p = fromJsonValue<Point>(r.value.get("pt"));
  if (p.ok) { console.log(p.value.x); }
}`,
    expected: "3",
    extra: ({ rust }) =>
      expect(rust).toContain("ParseResult::<Point>::from_value"),
  },
  {
    name: "JSV13 toJsonValue<T> from a modeled struct, then stringify",
    src: `${IMPORT}interface Point { x: number; y: number; }
const v = toJsonValue<Point>({ x: 1, y: 2 });
console.log(stringifyJson(v));`,
    expected: '{"x":1,"y":2}',
    extra: ({ rust }) => expect(rust).toContain("serde_json::to_value"),
  },
  {
    name: "JSV14 stringifyJson on a parsed JsonValue round-trips",
    src: `${IMPORT}const r = parseJsonValue('{"a":1,"b":[2,3]}');
if (r.ok) { console.log(stringifyJson(r.value)); }`,
    expected: '{"a":1,"b":[2,3]}',
  },

  // ── Fail-loud (runtime) ───────────────────────────────────────────────────
  {
    name: "JSV15 coercion mismatch is fail-loud (runtime panic)",
    src: `${P}const r = parseJsonValue('"hi"');
if (r.ok) { console.log(r.value.asNumber()); }`,
    expectFail: true,
    extra: ({ result }) => expect(result.stderr).toContain("asNumber"),
  },
  {
    name: "JSV16 navigating into a non-container is fail-loud (runtime panic)",
    src: `${P}const r = parseJsonValue('5');
if (r.ok) { console.log(r.value.get("k").isNull()); }`,
    expectFail: true,
    extra: ({ result }) => expect(result.stderr).toContain("get"),
  },
]);

// ── Fail-loud (compile-time) — these never reach cargo ──────────────────────
describe("090 fail-loud residuals (compile-time)", () => {
  test("JSV17 an unknown accessor on a JsonValue binding → UnsupportedError", () => {
    const src = `${P}const r = parseJsonValue('5');
if (r.ok) { console.log(r.value.floor()); }`;
    expect(() => compile(src)).toThrow(UnsupportedError);
    // The message enumerates the available accessors.
    expect(() => compile(src)).toThrow(/get.*at.*asNumber|asNumber.*isObject/);
  });

  test("JSV18 JsonValue used as a map/set key → fail-loud (not hashable)", () => {
    const src = `import { JsonValue } from "@ttr/std";
const s = new Set<JsonValue>();
console.log(s.size);`;
    expect(() => compile(src)).toThrow();
  });

  test("JSV19 bare JSON.parse redirect names both paths", () => {
    let msg = "";
    try {
      compile(`const v = JSON.parse("[1,2,3]");`);
    } catch (e) {
      msg = String(e);
    }
    expect(msg).toContain("parseJsonValue"); // dynamic path
    expect(msg).toContain("parseJson<"); // modeled path
  });

  test("JSV20 the `any` wall is untouched (regression)", () => {
    expect(() => compile(`const x: any = 5;\nconsole.log(x);`)).toThrow(
      DialectError,
    );
  });
});
