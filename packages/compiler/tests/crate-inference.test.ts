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
  {
    // #71 — a *named* re-export in a **mixed** file (own logic + re-export) is no
    // longer fail-loud: a consumer routes the re-exported name to the REAL source
    // module, and the mixed file emits only its own declarations.
    name: "RXP1 mixed file re-export routes the consumer to the real source",
    files: {
      "source.ts": `export function real(): number { return 42; }`,
      "mixed.ts": `export function own(): number { return 1; }
export { real } from "./source";`,
      "main.ts": `import { own, real } from "./mixed";
console.log(own() + real());`,
    },
    expected: "43",
    extra: ({ files }) => {
      const main = files?.find((f) => f.path === "main.rs")?.content ?? "";
      // The re-exported name binds to the real source, bypassing the mixed module.
      expect(main).toContain("use crate::source::real;");
      const mixed = files?.find((f) => f.path === "mixed.rs")?.content ?? "";
      expect(mixed).toContain("fn own");
      expect(mixed).not.toContain("fn real");
    },
  },
  {
    // #71 — the chain is followed through a mixed intermediary to the definition.
    name: "RXP2 transitive re-export chased through a mixed intermediary",
    files: {
      "z.ts": `export function deep(): number { return 7; }`,
      "mid.ts": `export function midOwn(): number { return 2; }
export { deep } from "./z";`,
      "mixed.ts": `export function own(): number { return 1; }
export { deep } from "./mid";`,
      "main.ts": `import { deep } from "./mixed";
console.log(deep());`,
    },
    expected: "7",
    extra: ({ files }) => {
      const main = files?.find((f) => f.path === "main.rs")?.content ?? "";
      expect(main).toContain("use crate::z::deep;");
    },
  },
  {
    // #71 — a renamed re-export in a mixed file resolves to the original name.
    name: "RXP3 renamed re-export in a mixed file",
    files: {
      "source.ts": `export function real(): number { return 42; }`,
      "mixed.ts": `export function own(): number { return 1; }
export { real as aliased } from "./source";`,
      "main.ts": `import { aliased } from "./mixed";
console.log(aliased());`,
    },
    expected: "42",
    extra: ({ files }) => {
      const main = files?.find((f) => f.path === "main.rs")?.content ?? "";
      expect(main).toContain("use crate::source::real as aliased;");
    },
  },
  {
    // #70 — a scalar value `export default` → a `LazyLock<f64>` static; a consumer
    // derefs it (a scalar is `Copy`, so read/move both work).
    name: "DEF1 scalar `export default 42` read cross-module",
    files: {
      "cfg.ts": `export default 42;`,
      "main.ts": `import n from "./cfg";
console.log(n + 1);`,
    },
    expected: "43",
    extra: ({ files }) => {
      const cfg = files?.find((f) => f.path === "cfg.rs")?.content ?? "";
      expect(cfg).toContain("LazyLock<f64>");
    },
  },
  {
    // #70 — a string default → `LazyLock<String>`; a method read auto-derefs.
    name: "DEF2 string `export default` with a method read",
    files: {
      "cfg.ts": `export default "hello";`,
      "main.ts": `import s from "./cfg";
console.log(s.toUpperCase());`,
    },
    expected: "HELLO",
  },
  {
    // #70 — an array default → `LazyLock<Vec<f64>>`; index + `.length` read.
    name: "DEF3 array `export default` index + length read",
    files: {
      "cfg.ts": `export default [10, 20, 30];`,
      "main.ts": `import xs from "./cfg";
console.log(xs[1], xs.length);`,
    },
    expected: "20 3",
  },
  {
    // #70 — a `new <Struct>()` default (oracle-typed); read its fields cross-module.
    name: "DEF4 `export default new Point(3,4)` field read",
    files: {
      "pt.ts": `export class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) { this.x = x; this.y = y; }
}
export default new Point(3, 4);`,
      "main.ts": `import p from "./pt";
console.log(p.x + p.y);`,
    },
    expected: "7",
  },
  {
    // #70 — an arrow default is a real `fn` (via normalizeArrows), not a lazy static.
    name: "DEF5 arrow `export default` → a fn",
    files: {
      "dbl.ts": `export default (x: number): number => x * 2;`,
      "main.ts": `import f from "./dbl";
console.log(f(21));`,
    },
    expected: "42",
    extra: ({ files }) => {
      const dbl = files?.find((f) => f.path === "dbl.rs")?.content ?? "";
      expect(dbl).toContain("fn __default_export");
      expect(dbl).not.toContain("LazyLock");
    },
  },
]);
