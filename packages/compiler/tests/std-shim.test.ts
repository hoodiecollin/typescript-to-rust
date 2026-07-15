/**
 * Specs for series 084 — the `@t2r/std` std-shim, Tier A (`parseJson` /
 * `stringifyJson`). A third routing lane: blessed TS functions recognized by the
 * reserved import specifier `"@t2r/std"` and lowered to known Rust. `stringifyJson`
 * reuses the 045 `tslib::json::stringify` writer; `parseJson<T>` lowers to
 * `tslib::json::ParseResult::<T>::parse`. Bare `JSON.parse`/`JSON.stringify` are
 * fail-loud with a redirect. Differential (TS-via-Bun vs Rust) + shape + throws.
 * IDs → specs.md (STD1–STD16).
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { runRust } from "../src/harness";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program, src);
}

function runTs(src: string): string {
  const proc = Bun.spawnSync(["bun", "run", "-"], {
    stdin: new TextEncoder().encode(src),
  });
  return new TextDecoder().decode(proc.stdout).trim();
}

async function behaves(src: string, expected: string): Promise<void> {
  const rust = compile(src);
  const rr = await runRust(rust);
  expect(rr.ok).toBe(true);
  expect(rr.stdout.trim()).toBe(runTs(src));
  expect(rr.stdout.trim()).toBe(expected);
}

const STR = `import { stringifyJson } from "@t2r/std";\n`;
const PARSE = `import { parseJson } from "@t2r/std";\n`;

describe("084 stringifyJson (045 writer, behind the shim)", () => {
  test("STD1 an integer prints without a decimal", async () => {
    const src = `${STR}console.log(stringifyJson(5));`;
    await behaves(src, "5");
    expect(compile(src)).toContain("tslib::json::stringify");
  });

  test("STD2 an array", async () => {
    await behaves(`${STR}console.log(stringifyJson([1, 2, 3]));`, "[1,2,3]");
  });

  test("STD3 a record in insertion order", async () => {
    await behaves(
      `${STR}const o: Record<string, number> = { "a": 1, "b": 2 };
console.log(stringifyJson(o));`,
      '{"a":1,"b":2}',
    );
  });

  test("STD4 a struct in declaration order", async () => {
    await behaves(
      `${STR}interface Point { x: number; y: number; }
const p: Point = { x: 1, y: 2 };
console.log(stringifyJson(p));`,
      '{"x":1,"y":2}',
    );
  });

  test("STD5 a fractional number keeps decimals", async () => {
    await behaves(`${STR}console.log(stringifyJson(1.5));`, "1.5");
  });

  test("STD6 an aliased import still routes (recognition by specifier)", async () => {
    const src = `import { stringifyJson as sj } from "@t2r/std";
console.log(sj(5));`;
    await behaves(src, "5");
    expect(compile(src)).toContain("tslib::json::stringify");
  });
});

describe("084 parseJson<T> → ParseResult<T>", () => {
  test("STD7 parse into a struct, read on the ok branch", async () => {
    const src = `${PARSE}interface Point { x: number; y: number; }
const r = parseJson<Point>('{"x": 3, "y": 4}');
if (r.ok) { console.log(r.value.x, r.value.y); }`;
    await behaves(src, "3 4");
    expect(compile(src)).toContain("ParseResult::<Point>::parse");
  });

  test("STD8 parse into an array type", async () => {
    const src = `${PARSE}const r = parseJson<Array<number>>("[10, 20, 30]");
if (r.ok) { console.log(r.value[1]); }`;
    await behaves(src, "20");
  });

  test("STD9 the error branch (no throw)", async () => {
    const src = `${PARSE}interface Point { x: number; y: number; }
const r = parseJson<Point>("not json");
if (!r.ok) { console.log("bad"); }`;
    await behaves(src, "bad");
  });

  test("STD10 round-trips through stringifyJson", async () => {
    const src = `import { parseJson, stringifyJson } from "@t2r/std";
interface Point { x: number; y: number; }
const p: Point = { x: 7, y: 9 };
const r = parseJson<Point>(stringifyJson(p));
if (r.ok) { console.log(r.value.x, r.value.y); }`;
    await behaves(src, "7 9");
  });
});

describe("084 fail-loud: forbid bare JSON + redirect", () => {
  test("STD11 bare JSON.stringify → redirect to stringifyJson", () => {
    expect(() => compile(`console.log(JSON.stringify(5));`)).toThrow(
      /stringifyJson.*@t2r\/std|@t2r\/std.*stringifyJson/,
    );
  });

  test("STD12 bare JSON.parse (untyped) → redirect to parseJson", () => {
    expect(() => compile(`const v = JSON.parse("[1,2,3]");`)).toThrow(
      /parseJson.*@t2r\/std|@t2r\/std.*parseJson/,
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

  test("STD15 unknown @t2r/std import name → not exported", () => {
    expect(() =>
      compile(`import { nope } from "@t2r/std";\nconsole.log(1);`),
    ).toThrow(/@t2r\/std/);
  });

  test("STD16 import from another bare specifier → only @t2r/std recognized", () => {
    expect(() =>
      compile(`import { x } from "lodash";\nconsole.log(1);`),
    ).toThrow(/@t2r\/std/);
  });
});
