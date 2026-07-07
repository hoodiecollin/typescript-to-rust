/**
 * Specs for series 041 — `Object.keys`/`values` over `IndexMap`-backed records.
 * JS objects iterate in insertion order, so the `Record` backing type is
 * `indexmap::IndexMap` (not `HashMap`) and `Object.keys(m)[i]` is deterministic.
 * Differential: emitted Rust compiles (linking `indexmap`) AND matches the TS
 * run. IDs map to specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit, UnsupportedError } from "../src/emitter";
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

const REC3 = `const m: Record<string, number> = { "a": 1, "b": 2, "c": 3 };`;

describe("041 Object.keys / values (IndexMap insertion order)", () => {
  test("OBJ1 Object.keys preserves insertion order", async () => {
    const src = `${REC3}
const ks: Array<string> = Object.keys(m);
console.log(ks[0], ks[1], ks[2]);`;
    await behaves(src, "a b c");
    expect(compile(src)).toContain(".keys().cloned().collect");
  });

  test("OBJ2 Object.values preserves insertion order", async () => {
    await behaves(
      `${REC3}
const vs: Array<number> = Object.values(m);
console.log(vs[0], vs[1], vs[2]);`,
      "1 2 3",
    );
  });

  test("OBJ3 Object.keys(m).length is the entry count", async () => {
    await behaves(
      `${REC3}
console.log(Object.keys(m).length);`,
      "3",
    );
  });

  test("OBJ4 a record module imports IndexMap, not HashMap", () => {
    const rust = compile(`${REC3}\nconsole.log(Object.keys(m)[0]);`);
    expect(rust).toContain("use indexmap::IndexMap;");
    expect(rust).not.toContain("std::collections::HashMap");
  });
});

describe("041 Object.* — an unsupported static is fail-loud", () => {
  // Object.entries graduated in series 043; Object.assign in 044. An unknown
  // Object static stays fail-loud.
  test("OBJ5 an unknown Object static is fail-loud", () => {
    expect(() =>
      compile(`${REC3}\nconst f = Object.freeze(m);`),
    ).toThrow(UnsupportedError);
  });
});
