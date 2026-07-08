/**
 * Specs for series 047c — scalars are untouched by the directive scopes, and the
 * two fail-loud upgrades that replace an opaque cargo `E0369` with a clean
 * dialect signal: a struct whose type is not `PartialEq`-eligible (an fn-pointer
 * field), and an identity/discipline mismatch under `"use rc"`.
 *
 * IDs map to docs/work/047-struct-equality/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { runRust } from "../src/harness";
import { UnsupportedError } from "../src/lower";

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

describe("047c scalars unchanged + fail-loud upgrades", () => {
  test("EQ8 scalars compare with == inside a use rc scope (directives only affect structs)", async () => {
    const src = `"use rc";
console.log(1 === 1);
console.log("a" === "b");`;
    await behaves(src, "true\nfalse");
    expect(compile(src)).toContain("==");
  });

  test("EQ9 a struct with a non-PartialEq field compared with === is a clean UnsupportedError", () => {
    const src = `function double(n: number): number { return n * 2; }
interface Handler { fn: (n: number) => number; }
const a: Handler = { fn: double };
const b: Handler = { fn: double };
console.log(a === b);`;
    expect(() => compile(src)).toThrow(UnsupportedError);
  });

  test("EQ10 an identity/discipline mismatch under use rc is a clean UnsupportedError", () => {
    const src = `"use rc";
class C { n: number; constructor(n: number) { this.n = n; } }
const a: C = new C(1);
console.log(a === new C(2));`;
    expect(() => compile(src)).toThrow(UnsupportedError);
  });
});
