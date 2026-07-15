/**
 * Specs for series 044 — Object.assign + object spread over IndexMap records.
 * Both lower to a merged-map builder block; later sources/spreads override
 * earlier keys (JS semantics). Differential + shape. IDs → specs.md.
 */

import { expect, test } from "bun:test";
import { UnsupportedError } from "../src/emitter";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("object-assign-spread", [
  {
    name: "ASN1 merge into a fresh {} target",
    src: `const a: Record<string, number> = { "x": 1 };
const b: Record<string, number> = { "y": 2 };
const m: Record<string, number> = Object.assign({}, a, b);
console.log(m["x"], m["y"]);`,
    expected: "1 2",
    extra: ({ rust }) => expect(rust).toContain("let mut __o = IndexMap::new();"),
  },
  {
    name: "ASN3 a later source overrides an earlier key",
    src: `const a: Record<string, number> = { "x": 1 };
const b: Record<string, number> = { "x": 9 };
const m: Record<string, number> = Object.assign({}, a, b);
console.log(m["x"]);`,
    expected: "9",
  },
  {
    name: "SPR1 { ...a, k: v } applies the explicit entry",
    src: `const a: Record<string, number> = { "x": 1 };
const m: Record<string, number> = { ...a, "y": 2 };
console.log(m["x"], m["y"]);`,
    expected: "1 2",
    extra: ({ rust }) => expect(rust).toContain("__o.extend("),
  },
  {
    name: "SPR3 an explicit key before a spread is overridden by the spread",
    src: `const a: Record<string, number> = { "x": 5 };
const m: Record<string, number> = { "x": 1, ...a };
console.log(m["x"]);`,
    expected: "5",
  },
]);

test("SPR4 array spread is fail-loud", () => {
  expect(() =>
    compile(`const a: Array<number> = [1, 2];\nconst b: Array<number> = [...a];`),
  ).toThrow(UnsupportedError);
});
