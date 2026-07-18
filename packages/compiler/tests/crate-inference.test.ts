/**
 * Specs for the crate-merge oracle graduation (series 050 residual, #68). The 099
 * type-oracle now compiles the WHOLE crate — tsc walks `./`-relative imports — so a
 * cross-module untyped binding infers *through* the import, exactly as a same-file
 * binding does. Before #68 these each required an explicit annotation (the pre-099
 * baseline). Differential: each compiles + runs + stdout-matches TS.
 */

import { expect } from "bun:test";
import { defineDifferential } from "./_support/differential";

defineDifferential("crate-inference", [
  {
    // A `new <ImportedStruct>(…)` binding, unannotated — the oracle resolves the
    // imported `Point` class and types `p` by construction.
    name: "CINF1 unannotated `const p = new Point(…)` with an imported class",
    files: {
      "point.ts": `export class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) { this.x = x; this.y = y; }
}`,
      "main.ts": `import { Point } from "./point";
const p = new Point(1, 2);
console.log(p.x + p.y);`,
    },
    expected: "3",
    extra: ({ rust }) => {
      // No annotation was needed — the binding is inferred, not `const p: Point`.
      expect(rust).toContain("use crate::point::Point;");
    },
  },
  {
    // A template-literal binding whose interpolation calls an imported fn — the
    // oracle infers `String` *through* the import (a builtin-signature inference).
    name: "CINF2 unannotated template-literal binding through an imported fn",
    files: {
      "greet.ts": `export function who(): string { return "world"; }`,
      "main.ts": `import { who } from "./greet";
const g = \`hi \${who()}\`;
console.log(g);`,
    },
    expected: "hi world",
    extra: ({ rust }) => expect(rust).toContain("format!"),
  },
  {
    // An arithmetic binding over an imported fn's return — the oracle infers `f64`
    // through the imported signature, so `s` needs no `: number`.
    name: "CINF3 unannotated arithmetic binding over an imported fn return",
    files: {
      "math.ts": `export function add(a: number, b: number): number { return a + b; }`,
      "main.ts": `import { add } from "./math";
const s = add(2, 3);
console.log(s + 1);`,
    },
    expected: "6",
  },
]);
