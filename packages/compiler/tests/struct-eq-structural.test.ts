/**
 * Specs for series 047a — struct `===`/`!==` defaults to **structural** equality
 * (`derive(PartialEq)`), a *documented divergence* from JS identity equality. Two
 * distinct-but-equal structs compare `true` (JS says `false`); that flipped truth
 * value is the pinned behavior. `f64` fields are `PartialEq` but not `Eq` (so this
 * does NOT unlock struct map/set keys, #21).
 *
 * IDs map to docs/work/047-struct-equality/specs.md.
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

/** Emit, run as Rust, assert stdout equals `expected` (structural, so it may
 *  intentionally differ from the JS run — see the per-spec note). */
async function runsTo(src: string, expected: string): Promise<void> {
  const rust = compile(src);
  const rr = await runRust(rust);
  expect(rr.ok).toBe(true);
  expect(rr.stdout.trim()).toBe(expected);
}

const POINT = `interface Point { x: number; y: number; }`;

describe("047a structural equality (documented divergence)", () => {
  test("EQ1 distinct-but-equal structs compare equal (JS would say false)", async () => {
    const src = `${POINT}
const a: Point = { x: 1, y: 2 };
const b: Point = { x: 1, y: 2 };
console.log(a === b);`;
    await runsTo(src, "true");
    const rust = compile(src);
    expect(rust).toContain("PartialEq");
    expect(rust).toContain("a == b");
    // The pinned divergence: JS identity equality says false.
    expect(runTs(src)).toBe("false");
  });

  test("EQ2 structs differing in a field are unequal", async () => {
    await runsTo(
      `${POINT}
const a: Point = { x: 1, y: 2 };
const b: Point = { x: 1, y: 9 };
console.log(a === b);`,
      "false",
    );
  });

  test("EQ3 !== mirrors (emits !=)", async () => {
    const eqSrc = `${POINT}
const a: Point = { x: 1, y: 2 };
const b: Point = { x: 1, y: 2 };
console.log(a !== b);`;
    await runsTo(eqSrc, "false");
    expect(compile(eqSrc)).toContain("a != b");
    await runsTo(
      `${POINT}
const a: Point = { x: 1, y: 2 };
const b: Point = { x: 1, y: 9 };
console.log(a !== b);`,
      "true",
    );
  });

  test("EQ4 nested-struct structural equality is deep", async () => {
    const src = `interface Inner { x: number; }
interface Outer { p: Inner; }
const a: Outer = { p: { x: 1 } };
const b: Outer = { p: { x: 1 } };
console.log(a === b);`;
    await runsTo(src, "true");
    const rust = compile(src);
    // Both the outer and inner struct derive PartialEq.
    expect(rust.match(/PartialEq/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("EQ5 f64 fields → PartialEq but no bare Eq (guards #21 non-regression)", () => {
    const rust = compile(`${POINT}
const a: Point = { x: 1.5, y: 2.5 };
const b: Point = { x: 1.5, y: 2.5 };
console.log(a === b);`);
    expect(rust).toContain("PartialEq");
    // No accidental Eq/Hash — f64 is not Eq.
    expect(rust).not.toContain(", Eq");
    expect(rust).not.toContain("Eq,");
    expect(rust).not.toContain("Hash");
  });
});
