/**
 * Specs for series 047b — under `"use rc"`, struct `===`/`!==` is **identity**
 * (`Rc::ptr_eq`) not structural: an aliased handle is equal, a fresh equal value
 * is not. Because an `rc` binding has a stable heap home, this restores exactly
 * JS identity semantics — so the differential vs. Bun agrees (contrast the 047a
 * structural divergence, where the same field values give the opposite result).
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

async function behaves(src: string, expected: string): Promise<void> {
  const rust = compile(src);
  const rr = await runRust(rust);
  expect(rr.ok).toBe(true);
  expect(rr.stdout.trim()).toBe(runTs(src));
  expect(rr.stdout.trim()).toBe(expected);
}

const C = `class C {
  n: number;
  constructor(n: number) { this.n = n; }
}`;

describe("047b rc identity equality", () => {
  test("EQ6 aliased handle is identity-equal; a fresh equal value is not", async () => {
    const src = `"use rc";
${C}
const a: C = new C(1);
const b: C = a;
const c: C = new C(1);
console.log(a === b);
console.log(a === c);`;
    await behaves(src, "true\nfalse");
    expect(compile(src)).toContain("Rc::ptr_eq");
  });

  test("EQ7 !== under use rc emits !Rc::ptr_eq and is the complement", async () => {
    const src = `"use rc";
${C}
const a: C = new C(1);
const b: C = a;
const c: C = new C(1);
console.log(a !== b);
console.log(a !== c);`;
    await behaves(src, "false\ntrue");
    expect(compile(src)).toContain("!Rc::ptr_eq");
  });
});
