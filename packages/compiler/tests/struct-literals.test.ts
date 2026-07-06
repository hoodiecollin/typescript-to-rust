/**
 * Specs for series 032 — nested / inferred struct literals (gap B from 030).
 *
 * A struct object literal was only recognized at the top level of a struct-typed
 * binding; an *inline nested* literal (`{ start: { x: 0, y: 0 } }`) or a struct
 * literal *inside a collection* (`Array<Point>` = `[{ x: 1, y: 2 }]`) fell through
 * to the bare-object-literal `UnsupportedError`. This series recurses into a
 * field's / element's declared struct type.
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

describe("032 nested/inferred struct literals", () => {
  test("an inline nested struct literal lowers recursively", async () => {
    await behaves(
      `interface Point { x: number; y: number; }
interface Line { start: Point; end: Point; }
const l: Line = { start: { x: 0, y: 0 }, end: { x: 3, y: 4 } };
console.log(l.end.x);`,
      "3",
    );
  });

  test("a two-level nested struct literal lowers recursively", async () => {
    await behaves(
      `interface Point { x: number; y: number; }
interface Seg { a: Point; b: Point; }
interface Path { head: Seg; }
const p: Path = { head: { a: { x: 1, y: 2 }, b: { x: 5, y: 6 } } };
console.log(p.head.b.x);`,
      "5",
    );
  });

  test("a struct literal inside an Array element lowers", async () => {
    await behaves(
      `interface Point { x: number; y: number; }
const pts: Array<Point> = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
console.log(pts[1].y);`,
      "4",
    );
  });
});
