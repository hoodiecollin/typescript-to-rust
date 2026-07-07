/**
 * Specs for series 045 — JSON.stringify / JSON.parse (serde + tslib number
 * fidelity). stringify routes to `tslib::json::stringify` (JS number rules,
 * insertion-ordered keys); parse is annotation-driven (`from_str::<T>`) with an
 * untyped `serde_json::Value` fallback. Differential + shape. IDs → specs.md.
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

describe("045a JSON.stringify", () => {
  test("JSN1 an integer prints without a decimal", async () => {
    const src = `console.log(JSON.stringify(5));`;
    await behaves(src, "5");
    expect(compile(src)).toContain("tslib::json::stringify");
  });

  test("JSN2 an array", async () => {
    await behaves(`console.log(JSON.stringify([1, 2, 3]));`, "[1,2,3]");
  });

  test("JSN3 a record in insertion order", async () => {
    await behaves(
      `const o: Record<string, number> = { "a": 1, "b": 2 };
console.log(JSON.stringify(o));`,
      '{"a":1,"b":2}',
    );
  });

  test("JSN4 a struct (fields in declaration order)", async () => {
    await behaves(
      `interface Point { x: number; y: number; }
const p: Point = { x: 1, y: 2 };
console.log(JSON.stringify(p));`,
      '{"x":1,"y":2}',
    );
  });

  test("JSN5 a fractional number keeps decimals", async () => {
    await behaves(`console.log(JSON.stringify(1.5));`, "1.5");
  });
});

describe("045b JSON.parse (annotation-driven)", () => {
  test("JSN6 parse into an array type", async () => {
    const src = `const xs: Array<number> = JSON.parse("[10, 20, 30]");
console.log(xs[1]);`;
    await behaves(src, "20");
    expect(compile(src)).toContain("from_str::<Vec<f64>>");
  });

  test("JSN7 parse into a struct type", async () => {
    await behaves(
      `interface Point { x: number; y: number; }
const p: Point = JSON.parse("{\\"x\\": 3, \\"y\\": 4}");
console.log(p.x, p.y);`,
      "3 4",
    );
  });
});

describe("045c untyped JSON.parse → Value (round-trip)", () => {
  test("JSN8 stringify(parse(s)) round-trips", async () => {
    const src = `const v = JSON.parse("[1,2,3]");
console.log(JSON.stringify(v));`;
    await behaves(src, "[1,2,3]");
    expect(compile(src)).toContain("serde_json::Value");
  });
});
