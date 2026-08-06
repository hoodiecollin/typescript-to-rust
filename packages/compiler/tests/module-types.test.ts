/**
 * Specs for series 050c — cross-`mod` struct / class / enum resolution (issue #6).
 * Because `lowerCrate` splices every module's declarations into ONE synthetic
 * program and lowers it as a unit, a cross-module nominal reference (a `new Point`,
 * a `p.dist()` method call, a `Shape`-typed struct literal, a `Color.Red`) resolves
 * **by construction** during lowering; the importer's `use` map brings the name
 * into scope, and 050b's visibility closure has already widened the exported type
 * (its fields / ctor / methods) to `pub(crate)` so the cross-module access is legal.
 * IDs map to series 050.
 */

import { expect } from "bun:test";
import { defineDifferential } from "./_support/differential";

defineDifferential("module-types", [
  // ── MOD13 — an exported class, constructed in the entry ────────────────────
  {
    name: "MOD13 export class Point + `new Point(1,2)` cross-module compiles",
    files: {
      "point.ts": `export class Point {\n  constructor(public x: number, public y: number) {}\n}`,
      "main.ts": `import { Point } from "./point";\nconst p: Point = new Point(1, 2);\nconsole.log(p.x + p.y);`,
    },
    expected: "3",
    extra: ({ rust }) => {
      expect(rust).toContain("use crate::point::Point;");
      expect(rust).toMatch(/pub\(crate\) struct Point/);
      expect(rust).toMatch(/pub\(crate\) x:/);
      expect(rust).toMatch(/pub\(crate\) fn new/);
    },
  },
  // ── MOD14 — a cross-`mod` method call behaves ──────────────────────────────
  {
    name: "MOD14 cross-module method call p.sum() behaves",
    files: {
      "point.ts": `export class Point {\n  constructor(public x: number, public y: number) {}\n  sum(): number { return this.x + this.y; }\n}`,
      "main.ts": `import { Point } from "./point";\nconst p: Point = new Point(3, 4);\nconsole.log(p.sum());`,
    },
    expected: "7",
    extra: ({ rust }) => expect(rust).toMatch(/pub\(crate\) fn sum/),
  },
  // ── MOD15 — an exported interface as a cross-`mod` struct-literal type ──────
  {
    name: "MOD15 export interface Shape used as a cross-module struct literal",
    files: {
      "shapes.ts": `export interface Shape { w: number; h: number; }`,
      "main.ts": `import { Shape } from "./shapes";\nconst s: Shape = { w: 2, h: 3 };\nconsole.log(s.w * s.h);`,
    },
    expected: "6",
    extra: ({ rust }) => {
      expect(rust).toContain("use crate::shapes::Shape;");
      expect(rust).toMatch(/pub\(crate\) struct Shape/);
    },
  },
  // ── MOD16 — an exported enum referenced across a module boundary ────────────
  {
    name: "MOD16 export enum Color referenced cross-module (Color.Green)",
    files: {
      "color.ts": `export enum Color { Red, Green, Blue }`,
      "main.ts": `import { Color } from "./color";\nconst c: Color = Color.Green;\nconsole.log(c === Color.Green);`,
    },
    expected: "true",
    extra: ({ rust }) => {
      expect(rust).toContain("use crate::color::Color;");
      expect(rust).toMatch(/pub\(crate\) enum Color/);
    },
  },
]);
