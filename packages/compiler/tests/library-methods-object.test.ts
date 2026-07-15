/**
 * Specs for series 083 — the pure-impl catalog rows that 066 unblocked but that
 * PRIOR series already shipped (find/Object.entries/Object.assign/JSON.stringify).
 * 083 verifies they stay green (SHIP-*), pins the heterogeneous-Object.assign
 * fail-loud residual (ASSIGN-FL), and characterizes the JSON.stringify
 * `undefined`-omission divergence (JSON-UNDEF) that needs a genuine dialect
 * decision. IDs map to docs/work/083-library-methods-oracle/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { runRust } from "../src/harness";
import { compile, defineDifferential, runTs } from "./_support/differential";

defineDifferential("library-methods-object", [
  {
    name: "SHIP-FIND arr.find(p) → Option<T>, undefined miss (066)",
    src: `const xs: Array<number> = [1, 2, 3];
console.log(xs.find((x: number): boolean => x === 2) ?? -1);
console.log(xs.find((x: number): boolean => x === 9) ?? -1);`,
    expected: "2\n-1",
  },
  {
    name: "SHIP-ENTRIES Object.entries(obj) → [string, V][]",
    src: `const obj: Record<string, number> = { a: 1, b: 2 };
for (const [k, v] of Object.entries(obj)) { console.log(k, v); }`,
    expected: "a 1\nb 2",
  },
  {
    name: "SHIP-ASSIGN homogeneous Object.assign (Record merge)",
    src: `const a: Record<string, number> = { x: 1, y: 2 };
const b: Record<string, number> = { y: 20, z: 3 };
const merged: Record<string, number> = Object.assign(a, b);
console.log(merged["x"], merged["y"], merged["z"]);`,
    expected: "1 20 3",
  },
  {
    name: "SHIP-JSON stringifyJson(v) — object + number fidelity (via @t2r/std)",
    // Migrated to the std-shim (series 084): bare `JSON.stringify` is now fail-loud
    // and redirects; the fidelity writer lives behind `stringifyJson`.
    src: `import { stringifyJson } from "@t2r/std";
interface P { n: number; s: string; }
const p: P = { n: 1, s: "hi" };
console.log(stringifyJson(p));
console.log(stringifyJson(1.5));
console.log(stringifyJson([1, 2, 3]));`,
    expected: '{"n":1,"s":"hi"}\n1.5\n[1,2,3]',
  },
  {
    name: "SHIP-JSON-INF stringifyJson — Infinity/NaN → null (already faithful)",
    src: `import { stringifyJson } from "@t2r/std";
interface P { a: number; b: number; }
const p: P = { a: 1 / 0, b: 0 / 0 };
console.log(stringifyJson(p));`,
    expected: '{"a":null,"b":null}',
  },
  {
    name: "ASSIGN-FL heterogeneous Object.assign stays fail-loud (cargo rejects)",
    // Merging two DIFFERENT struct shapes has no idiomatic field-copy target — it
    // rides the #43 interface→trait epic. Emits `a.extend(b.clone())` on a struct
    // `A` (no `extend` method) → cargo rejects. Never a silent miscompile.
    src: `interface A { x: number; }
interface B { y: number; }
const a: A = { x: 1 };
const b: B = { y: 2 };
const merged: A = Object.assign(a, b);
console.log(merged.x);`,
    expectFail: true,
  },
]);

describe("083 catalog rows — undefined-omission (resolved in series 091)", () => {
  test("JSON-UNDEF stringifyJson OMITS an undefined-only field (Rust === JS)", async () => {
    // RESOLVED (series 091, epic #59 increment 2): what series 084 pinned as an
    // accepted divergence — `b: number | undefined` serializing as `null` — is now
    // fixed. An `undefined`-only field emits `#[serde(skip_serializing_if]` so serde
    // OMITS the key, matching JS. (A `null`-bearing field still keeps `null`; see
    // `undefined-omission.test.ts` for the full matrix.)
    const src = `import { stringifyJson } from "@t2r/std";
interface P { a: number; b: number | undefined; }
const p: P = { a: 1, b: undefined };
console.log(stringifyJson(p));`;
    const rust = compile(src);
    const rr = await runRust(rust);
    expect(rr.ok).toBe(true);
    // Both sides now omit the undefined key — no divergence.
    expect(rr.stdout.trim()).toBe('{"a":1}');
    expect(await runTs(src)).toBe('{"a":1}');
  });
});
