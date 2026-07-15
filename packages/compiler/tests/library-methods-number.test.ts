/**
 * Specs for series 083 — Number / Math library methods over the unified
 * `receiverTypeOf` backbone. Native rows (NUMN*), tslib-quirk rows (NUMT*), and
 * the variadic `min!`/`max!` macro (MINMAX*). Each spec differential-matches;
 * a `Tf` row observes the JS quirk. IDs map to
 * docs/work/083-library-methods-oracle/specs.md.
 */

import { expect } from "bun:test";
import { defineDifferential } from "./_support/differential";

defineDifferential("library-methods-number", [
  {
    name: "NUMN1 Math.floor / ceil / round / abs",
    src: `console.log(Math.floor(3.7), Math.ceil(3.2), Math.round(2.5), Math.abs(-4));`,
    expected: "3 4 3 4",
    extra: ({ rust }) => {
      expect(rust).toContain(".floor()");
      expect(rust).toContain(".ceil()");
      expect(rust).toContain(".round()");
      expect(rust).toContain(".abs()");
    },
  },
  {
    name: "NUMN2 Math.min / max (binary → native f64)",
    src: `console.log(Math.min(5, 9), Math.max(5, 9));`,
    expected: "5 9",
    extra: ({ rust }) => {
      expect(rust).toContain(".min(");
      expect(rust).toContain(".max(");
    },
  },
  {
    name: "NUMN1b Math on an f64 variable (no ambiguity)",
    src: `const x: number = 3.7;
console.log(Math.floor(x), Math.abs(x));`,
    expected: "3 3.7",
  },
  {
    name: "NUMT1 toFixed(d) — rounding + formatting",
    src: `const n: number = 3.14159;
console.log(n.toFixed(2));
console.log((2.5).toFixed(0));
console.log((1).toFixed(2));`,
    expected: "3.14\n3\n1.00",
    extra: ({ rust }) => expect(rust).toContain("tslib::number::to_fixed"),
  },
  {
    name: "NUMT2 toString(radix)",
    src: `console.log((255).toString(16));
console.log((10).toString(2));`,
    expected: "ff\n1010",
    extra: ({ rust }) => expect(rust).toContain("tslib::number::to_radix"),
  },
  {
    name: "NUMT3 parseInt — radix + trailing garbage",
    src: `console.log(Number.parseInt("42px", 10));
console.log(Number.parseInt("ff", 16));
console.log(Number.parseInt("0x1a", 16));`,
    expected: "42\n255\n26",
    extra: ({ rust }) => expect(rust).toContain("tslib::number::parse_int"),
  },
  {
    name: "NUMT4 parseFloat — trailing garbage",
    src: `console.log(Number.parseFloat("3.14abc"));
console.log(Number.parseFloat("  42 "));`,
    expected: "3.14\n42",
    extra: ({ rust }) => expect(rust).toContain("tslib::number::parse_float"),
  },
  {
    name: "NUMT5 to_js_string fidelity — integers, fractions, -0",
    src: `console.log((42).toString());
console.log((1.5).toString());
console.log((-0).toString());`,
    expected: "42\n1.5\n0",
    extra: ({ rust }) => expect(rust).toContain("tslib::number::to_js_string"),
  },
  {
    name: "MINMAX1 variadic min / max → min! / max! macro",
    src: `console.log(Math.min(3, 1, 2), Math.max(3, 1, 2));
console.log(Math.min(5, 4, 9, 1));`,
    expected: "1 3\n1",
    extra: ({ rust }) => {
      expect(rust).toContain("tslib::min!");
      expect(rust).toContain("tslib::max!");
    },
  },
]);
