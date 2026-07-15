/**
 * Specs for series 083 — the pure-impl catalog rows that 066 unblocked but that
 * PRIOR series already shipped (find/Object.entries/Object.assign/JSON.stringify).
 * 083 verifies they stay green (SHIP-*), pins the heterogeneous-Object.assign
 * fail-loud residual (ASSIGN-FL), and characterizes the JSON.stringify
 * `undefined`-omission divergence (JSON-UNDEF) that needs a genuine dialect
 * decision. IDs map to docs/work/083-library-methods-oracle/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { runRust } from "../src/harness";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program, src);
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

describe("083 catalog rows — verified still shipped", () => {
  test("SHIP-FIND arr.find(p) → Option<T>, undefined miss (066)", async () => {
    const src = `const xs: Array<number> = [1, 2, 3];
console.log(xs.find((x: number): boolean => x === 2) ?? -1);
console.log(xs.find((x: number): boolean => x === 9) ?? -1);`;
    await behaves(src, "2\n-1");
  });

  test("SHIP-ENTRIES Object.entries(obj) → [string, V][]", async () => {
    const src = `const obj: Record<string, number> = { a: 1, b: 2 };
for (const [k, v] of Object.entries(obj)) { console.log(k, v); }`;
    await behaves(src, "a 1\nb 2");
  });

  test("SHIP-ASSIGN homogeneous Object.assign (Record merge)", async () => {
    const src = `const a: Record<string, number> = { x: 1, y: 2 };
const b: Record<string, number> = { y: 20, z: 3 };
const merged: Record<string, number> = Object.assign(a, b);
console.log(merged["x"], merged["y"], merged["z"]);`;
    await behaves(src, "1 20 3");
  });

  test("SHIP-JSON stringifyJson(v) — object + number fidelity (via @t2r/std)", async () => {
    // Migrated to the std-shim (series 084): bare `JSON.stringify` is now fail-loud
    // and redirects; the fidelity writer lives behind `stringifyJson`.
    const src = `import { stringifyJson } from "@t2r/std";
interface P { n: number; s: string; }
const p: P = { n: 1, s: "hi" };
console.log(stringifyJson(p));
console.log(stringifyJson(1.5));
console.log(stringifyJson([1, 2, 3]));`;
    await behaves(src, '{"n":1,"s":"hi"}\n1.5\n[1,2,3]');
  });

  test("SHIP-JSON-INF stringifyJson — Infinity/NaN → null (already faithful)", async () => {
    const src = `import { stringifyJson } from "@t2r/std";
interface P { a: number; b: number; }
const p: P = { a: 1 / 0, b: 0 / 0 };
console.log(stringifyJson(p));`;
    await behaves(src, '{"a":null,"b":null}');
  });
});

describe("083 catalog rows — fail-loud residuals", () => {
  test("ASSIGN-FL heterogeneous Object.assign stays fail-loud (cargo rejects)", async () => {
    // Merging two DIFFERENT struct shapes has no idiomatic field-copy target — it
    // rides the #43 interface→trait epic. Emits `a.extend(b.clone())` on a struct
    // `A` (no `extend` method) → cargo rejects. Never a silent miscompile.
    const src = `interface A { x: number; }
interface B { y: number; }
const a: A = { x: 1 };
const b: B = { y: 2 };
const merged: A = Object.assign(a, b);
console.log(merged.x);`;
    const rr = await runRust(compile(src));
    expect(rr.ok).toBe(false);
  });
});

describe("083 catalog rows — documented divergence", () => {
  test("JSON-UNDEF stringifyJson of an undefined field diverges (066 collapse)", async () => {
    // ACCEPTED DIVERGENCE (series 084, resolving #57): JS OMITS an `undefined`
    // property (`{"a":1}`), but the 066 model collapses `null ≡ undefined` to
    // `Option::None`, which serde serializes as `null` → `{"a":1,"b":null}`.
    // Collin's decision: accept + document (no provenance/omission now). This spec
    // PINS the accepted behavior behind the shim.
    const src = `import { stringifyJson } from "@t2r/std";
interface P { a: number; b: number | undefined; }
const p: P = { a: 1, b: undefined };
console.log(stringifyJson(p));`;
    const rust = compile(src);
    const rr = await runRust(rust);
    expect(rr.ok).toBe(true);
    // Rust renders the None as `null`; JS would omit `b`. Divergence pinned.
    expect(rr.stdout.trim()).toBe('{"a":1,"b":null}');
    expect(runTs(src)).toBe('{"a":1}');
  });
});
