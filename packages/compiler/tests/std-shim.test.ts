/**
 * Specs for series 084 — the `@ttr/std` std-shim, Tier A (`parseJson` /
 * `stringifyJson`). A third routing lane: blessed TS functions recognized by the
 * reserved import specifier `"@ttr/std"` and lowered to known Rust. `stringifyJson`
 * reuses the 045 `tslib::json::stringify` writer; `parseJson<T>` lowers to
 * `tslib::json::ParseResult::<T>::parse`. Bare `JSON.parse`/`JSON.stringify` are
 * fail-loud with a redirect. Differential (TS-via-Bun vs Rust) + shape + throws.
 * IDs → specs.md (STD1–STD16).
 */

import { describe, expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

const STR = `import { stringifyJson } from "@ttr/std";\n`;
const PARSE = `import { parseJson } from "@ttr/std";\n`;

defineDifferential("std-shim", [
  {
    name: "STD1 an integer prints without a decimal",
    src: `${STR}console.log(stringifyJson(5));`,
    expected: "5",
    extra: ({ rust }) => expect(rust).toContain("tslib::json::stringify"),
  },
  {
    name: "STD2 an array",
    src: `${STR}console.log(stringifyJson([1, 2, 3]));`,
    expected: "[1,2,3]",
  },
  {
    name: "STD3 a record in insertion order",
    src: `${STR}const o: Record<string, number> = { "a": 1, "b": 2 };
console.log(stringifyJson(o));`,
    expected: '{"a":1,"b":2}',
  },
  {
    name: "STD4 a struct in declaration order",
    src: `${STR}interface Point { x: number; y: number; }
const p: Point = { x: 1, y: 2 };
console.log(stringifyJson(p));`,
    expected: '{"x":1,"y":2}',
  },
  {
    name: "STD5 a fractional number keeps decimals",
    src: `${STR}console.log(stringifyJson(1.5));`,
    expected: "1.5",
  },
  {
    name: "STD6 an aliased import still routes (recognition by specifier)",
    src: `import { stringifyJson as sj } from "@ttr/std";
console.log(sj(5));`,
    expected: "5",
    extra: ({ rust }) => expect(rust).toContain("tslib::json::stringify"),
  },
  {
    name: "STD7 parse into a struct, read on the ok branch",
    src: `${PARSE}interface Point { x: number; y: number; }
const r = parseJson<Point>('{"x": 3, "y": 4}');
if (r.ok) { console.log(r.value.x, r.value.y); }`,
    expected: "3 4",
    extra: ({ rust }) => expect(rust).toContain("ParseResult::<Point>::parse"),
  },
  {
    name: "STD8 parse into an array type",
    src: `${PARSE}const r = parseJson<Array<number>>("[10, 20, 30]");
if (r.ok) { console.log(r.value[1]); }`,
    expected: "20",
  },
  {
    name: "STD9 the error branch (no throw)",
    src: `${PARSE}interface Point { x: number; y: number; }
const r = parseJson<Point>("not json");
if (!r.ok) { console.log("bad"); }`,
    expected: "bad",
  },
  {
    name: "STD10 round-trips through stringifyJson",
    src: `import { parseJson, stringifyJson } from "@ttr/std";
interface Point { x: number; y: number; }
const p: Point = { x: 7, y: 9 };
const r = parseJson<Point>(stringifyJson(p));
if (r.ok) { console.log(r.value.x, r.value.y); }`,
    expected: "7 9",
  },
]);

describe("084 fail-loud: forbid bare JSON + redirect", () => {
  test("STD11 bare JSON.stringify → redirect to stringifyJson", () => {
    expect(() => compile(`console.log(JSON.stringify(5));`)).toThrow(
      /stringifyJson.*@ttr\/std|@ttr\/std.*stringifyJson/,
    );
  });

  test("STD12 bare JSON.parse (untyped) → redirect to parseJson", () => {
    expect(() => compile(`const v = JSON.parse("[1,2,3]");`)).toThrow(
      /parseJson.*@ttr\/std|@ttr\/std.*parseJson/,
    );
  });

  test("STD13 annotation-driven JSON.parse (old 045 form) → redirect", () => {
    expect(() =>
      compile(
        `interface Point { x: number; y: number; }
const p: Point = JSON.parse('{"x":3,"y":4}');`,
      ),
    ).toThrow(/parseJson/);
  });

  test("STD14 parseJson with no type argument → needs a modeled type", () => {
    expect(() =>
      compile(`${PARSE}const r = parseJson("[1,2,3]");`),
    ).toThrow(/parseJson/);
  });

  test("STD15 unknown @ttr/std import name → not exported", () => {
    expect(() =>
      compile(`import { nope } from "@ttr/std";\nconsole.log(1);`),
    ).toThrow(/@ttr\/std/);
  });

  test("STD16 import from another bare specifier → only @ttr/std recognized", () => {
    expect(() =>
      compile(`import { x } from "lodash";\nconsole.log(1);`),
    ).toThrow(/@ttr\/std/);
  });
});
