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
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { runRust } from "../src/harness";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
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

const POINT = `interface Point { x: number; y: number; }\n`;

describe("067 object-pattern over a named struct", () => {
  test("BD1 (emit) `const { x, y } = point` → `let Point { x, y } = point;`", () => {
    const src = `${POINT}const point: Point = { x: 1, y: 2 };\nconst { x, y } = point;\nconsole.log(x, y);`;
    expect(compile(src)).toContain("let Point { x, y } = point;");
  });

  test("BD2 (differential) destructured fields carry the source values", async () => {
    const src = `${POINT}const point: Point = { x: 3, y: 7 };\nconst { x, y } = point;\nconsole.log(x, y);`;
    await behaves(src, "3 7");
  });

  test("BD3 (differential, source live) the source stays usable → clone", async () => {
    const src = `${POINT}const point: Point = { x: 5, y: 9 };\nconst { x, y } = point;\nconsole.log(x, y, point.x + point.y);`;
    const rust = compile(src);
    // The live source is cloned by the ownership pass (Point is Clone, not Copy).
    expect(rust).toContain("let Point { x, y } = point.clone();");
    await behaves(src, "5 9 14");
  });

  test("BD4 (differential, source dead) an unused source is a bare move (no clone)", async () => {
    const src = `${POINT}const point: Point = { x: 8, y: 2 };\nconst { x, y } = point;\nconsole.log(x, y);`;
    const rust = compile(src);
    expect(rust).toContain("let Point { x, y } = point;");
    expect(rust).not.toContain("point.clone()");
    await behaves(src, "8 2");
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

  test("BD8 (differential) the tuple binding preserves element order", async () => {
    const src = `const [a, b] = [11, 22];\nconsole.log(a, b);`;
    await behaves(src, "11 22");
  });

  test("BD9 (differential, three elements) binds all three in order", async () => {
    const src = `const [a, b, c] = [1, 2, 3];\nconsole.log(a, b, c);`;
    await behaves(src, "1 2 3");
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

describe("067 unregressed prior art", () => {
  test("BD13 (differential) the 051a `Promise.all` tuple destructure still runs", async () => {
    const src = `async function getA(): Promise<number> { return 1; }
async function getB(): Promise<number> { return 2; }
async function run(): Promise<void> {
  const [a, b] = await Promise.all([getA(), getB()]);
  console.log(a, b);
}
await run();`;
    const rust = compile(src);
    expect(rust).toContain("let (a, b) =");
    await behaves(src, "1 2");
  });
});
