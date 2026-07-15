/**
 * Specs for series 027 (first slice) — the `tslib` fidelity crate + hybrid
 * routing. Quirk-heavy library methods route to `tslib` (JS semantics live in one
 * audited crate); clean methods stay native. Also covers unary `-`/`!` support,
 * the prerequisite for `at(-1)`.
 *
 * Differential: emitted Rust compiles (linking `tslib`) AND matches the TS run.
 */

import { expect } from "bun:test";
import { defineDifferential } from "./_support/differential";

defineDifferential("tslib", [
  {
    name: "negation on a numeric literal",
    src: `const x: number = -5;
console.log(x);`,
    expected: "-5",
  },
  {
    name: "negation of a parenthesized sum keeps its parens",
    src: `console.log(-(3 + 4));`,
    expected: "-7",
  },
  {
    name: "logical not on a boolean",
    src: `const b: boolean = true;
console.log(!b);`,
    expected: "false",
  },
  {
    name: "Array.at with a negative index → last element (tslib)",
    src: `const xs: Array<number> = [10, 20, 30];
console.log(xs.at(-1));`,
    expected: "30",
    // The route is tslib, not native indexing.
    extra: ({ rust }) => expect(rust).toContain("tslib::array::at"),
  },
  {
    name: "Array.at with a positive index (tslib)",
    src: `const xs: Array<number> = [10, 20, 30];
console.log(xs.at(1));`,
    expected: "20",
  },
  {
    name: "String.padStart left-pads (tslib)",
    src: `console.log("5".padStart(3, "0"));`,
    expected: "005",
  },
  {
    name: "String.padEnd right-pads (tslib)",
    src: `console.log("5".padEnd(3, "0"));`,
    expected: "500",
  },
]);
