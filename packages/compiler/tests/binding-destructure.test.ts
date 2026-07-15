/**
 * Specs for series 067 — exact-arity binding destructuring (issue #34).
 * Graduates the 008 residual for the two shapes that can never produce a missing
 * element (so they need no `undefined` model): object-pattern over a named struct
 * (`const { x, y } = point`) and array-pattern over a fixed-arity tuple source
 * (`const [a, b] = [e0, e1]`). Vec-source array-patterns, renamed/rest/nested
 * fields, and arity mismatches stay fail-loud. IDs map to
 * docs/work/067-binding-destructuring/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

const POINT = `interface Point { x: number; y: number; }\n`;

defineDifferential("binding-destructure", [
  {
    name: "BD2 (differential) destructured fields carry the source values",
    src: `${POINT}const point: Point = { x: 3, y: 7 };\nconst { x, y } = point;\nconsole.log(x, y);`,
    expected: "3 7",
  },
  {
    name: "BD3 (differential, source live) the source stays usable → clone",
    src: `${POINT}const point: Point = { x: 5, y: 9 };\nconst { x, y } = point;\nconsole.log(x, y, point.x + point.y);`,
    expected: "5 9 14",
    extra: ({ rust }) => {
      // The live source is cloned by the ownership pass (Point is Clone, not Copy).
      expect(rust).toContain("let Point { x, y } = point.clone();");
    },
  },
  {
    name: "BD4 (differential, source dead) an unused source is a bare move (no clone)",
    src: `${POINT}const point: Point = { x: 8, y: 2 };\nconst { x, y } = point;\nconsole.log(x, y);`,
    expected: "8 2",
    extra: ({ rust }) => {
      expect(rust).toContain("let Point { x, y } = point;");
      expect(rust).not.toContain("point.clone()");
    },
  },
  {
    name: "BD8 (differential) the tuple binding preserves element order",
    src: `const [a, b] = [11, 22];\nconsole.log(a, b);`,
    expected: "11 22",
  },
  {
    name: "BD9 (differential, three elements) binds all three in order",
    src: `const [a, b, c] = [1, 2, 3];\nconsole.log(a, b, c);`,
    expected: "1 2 3",
  },
  {
    name: "BD13 (differential) the 051a `Promise.all` tuple destructure still runs",
    src: `async function getA(): Promise<number> { return 1; }
async function getB(): Promise<number> { return 2; }
async function run(): Promise<void> {
  const [a, b] = await Promise.all([getA(), getB()]);
  console.log(a, b);
}
await run();`,
    expected: "1 2",
    extra: ({ rust }) => {
      expect(rust).toContain("let (a, b) =");
    },
  },
]);

describe("067 object-pattern over a named struct", () => {
  test("BD1 (emit) `const { x, y } = point` → `let Point { x, y } = point;`", () => {
    const src = `${POINT}const point: Point = { x: 1, y: 2 };\nconst { x, y } = point;\nconsole.log(x, y);`;
    expect(compile(src)).toContain("let Point { x, y } = point;");
  });

  test("BD5 (fail-loud) a renamed field is unsupported (shorthand-only)", () => {
    const src = `${POINT}const point: Point = { x: 1, y: 2 };\nconst { x: px, y } = point;\nconsole.log(px, y);`;
    expect(() => compile(src)).toThrow(/shorthand|renamed|destructuring/i);
  });

  test("BD6 (fail-loud) a rest element is unsupported", () => {
    const src = `${POINT}const point: Point = { x: 1, y: 2 };\nconst { x, ...rest } = point;\nconsole.log(x);`;
    expect(() => compile(src)).toThrow(/rest|destructuring/i);
  });
});

describe("067 array-pattern over a fixed-arity tuple", () => {
  test("BD7 (emit) `const [a, b] = [e0, e1]` → `let (a, b) = (e0, e1);`", () => {
    const src = `const [a, b] = [10, 20];\nconsole.log(a, b);`;
    expect(compile(src)).toContain("let (a, b) = (10");
  });

  test("BD10 (fail-loud) an array-pattern over a Vec identifier points at #42", () => {
    const src = `const arr: Array<number> = [1, 2, 3];\nconst [a, b] = arr;\nconsole.log(a, b);`;
    expect(() => compile(src)).toThrow(/42|Vec|undefined|out-of-bounds|destructuring/i);
  });

  test("BD11 (fail-loud) an arity mismatch is unsupported", () => {
    const src = `const [a, b, c] = [1, 2];\nconsole.log(a, b, c);`;
    expect(() => compile(src)).toThrow(/arity|mismatch|destructuring/i);
  });

  test("BD12 (fail-loud) a rest element is unsupported", () => {
    const src = `const [a, ...rest] = [1, 2, 3];\nconsole.log(a);`;
    expect(() => compile(src)).toThrow(/rest|destructuring/i);
  });
});
