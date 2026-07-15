/**
 * Specs for series 026 (first slice) — parentheses + precedence-aware emission
 * (gap D from 030). Parsing preserves grouping structurally (a
 * `ParenthesizedExpression` wraps the grouped subtree); lowering unwraps it, and
 * the emitter re-parenthesizes a `binary` child from an operator-precedence
 * table so `(a + b) * c` never flattens to `a + b * c`.
 *
 * Every spec is differential: emitted Rust compiles AND its stdout matches TS.
 */

import { describe, expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("precedence", [
  {
    name: "a grouped additive under a multiply keeps its parens",
    src: `console.log((1 + 2) * 3);`,
    expected: "9",
  },
  {
    name: "natural precedence needs no parens",
    src: `console.log(1 + 2 * 3);`,
    expected: "7",
  },
  {
    name: "right-side same-precedence subtraction is parenthesized",
    src: `console.log(10 - (3 - 1));`,
    expected: "8",
  },
  {
    name: "two grouped sums divided",
    src: `const a: number = 8;
const b: number = 2;
const c: number = 3;
const d: number = 1;
console.log((a + b) / (c + d));`,
    expected: "2.5",
  },
  {
    name: "deeply nested grouping round-trips",
    src: `console.log(2 * (3 + 4) - (1 + 1));`,
    expected: "12",
  },
]);

describe("026 parens + precedence", () => {
  test("the emitted Rust actually contains the guarding parens", () => {
    const rust = compile(`console.log((1 + 2) * 3);`);
    expect(rust).toContain("(1.0 + 2.0) * 3.0");
  });
});
