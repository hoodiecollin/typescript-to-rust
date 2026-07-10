/**
 * Specs for series 061 — HashMap operations & `Map`/`Set` classes. Graduates the
 * fail-loud deferral in issue #21: the `Map<K,V>` and `Set<T>` classes (backed by
 * `IndexMap`/`IndexSet` for JS insertion-order fidelity), the record query ops
 * (`k in obj`, `delete obj[k]`, variable-key `Option` reads), scalar-`f64` keys via
 * `OrderedFloat` (faithful to JS SameValueZero), and gated struct keys.
 *
 * Each spec differential-matches (compile → cargo run → TS-via-Bun) and pins the
 * refined emitted shape. IDs map to docs/work/061-hashmap-map-set/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { lower } from "../src/lower";
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

function rejects(src: string, re: RegExp): void {
  expect(() =>
    lower(parseSync("t.ts", src).program as unknown as Program),
  ).toThrow(re);
}

describe("061 Map / Set / record query ops", () => {
  test("MAP1 `Map<string, number>` set/get/has/delete/size", async () => {
    const src = `const m: Map<string, number> = new Map<string, number>();
m.set("a", 1);
m.set("b", 2);
console.log(m.size);
console.log(m.has("a"), m.has("z"));
console.log((m.get("a") ?? -1), (m.get("z") ?? -1));
m.delete("a");
console.log(m.size, m.has("a"));`;
    await behaves(src, "2\ntrue false\n1 -1\n1 false");
    const rust = compile(src);
    expect(rust).toContain("IndexMap::<String, f64>::new()");
    expect(rust).toContain('.insert("a".to_string(), 1.0)');
    expect(rust).toContain(".contains_key(");
    expect(rust).toContain(".cloned()");
    expect(rust).toContain(".shift_remove(");
  });

  test("MAP2 `Map` iteration preserves JS insertion order", async () => {
    const src = `const m: Map<string, number> = new Map<string, number>();
m.set("z", 1);
m.set("a", 2);
m.set("m", 3);
for (const [k, v] of m) { console.log(k, v); }`;
    await behaves(src, "z 1\na 2\nm 3");
  });

  test("MAP3 `Map<number, V>` integer + fractional keys (OrderedFloat)", async () => {
    const src = `const m: Map<number, string> = new Map<number, string>();
m.set(1, "one");
m.set(2.5, "two-and-half");
console.log((m.get(1) ?? "?"), (m.get(2.5) ?? "?"), (m.get(9) ?? "?"));
console.log(m.size);`;
    await behaves(src, "one two-and-half ?\n2");
    expect(compile(src)).toContain("OrderedFloat");
  });

  test("SET1 `Set<string>` add/has/delete/size/iter", async () => {
    const src = `const s: Set<string> = new Set<string>();
s.add("a");
s.add("b");
s.add("a");
console.log(s.size, s.has("a"), s.has("z"));
for (const x of s) { console.log(x); }
s.delete("a");
console.log(s.size, s.has("a"));`;
    await behaves(src, "2 true false\na\nb\n1 false");
    const rust = compile(src);
    expect(rust).toContain("IndexSet::<String>::new()");
    expect(rust).toContain(".contains(");
  });

  test("SET2 `Set<number>` collapses -0/+0 and dedupes NaN (SameValueZero)", async () => {
    const src = `const s: Set<number> = new Set<number>();
s.add(0);
s.add(-0);
s.add(NaN);
s.add(NaN);
console.log(s.size);`;
    await behaves(src, "2");
    expect(compile(src)).toContain("IndexSet::<OrderedFloat<f64>>::new()");
  });

  test("REC1 `k in obj` → `contains_key`", async () => {
    const src = `const obj: Record<string, number> = { a: 1, b: 2 };
const k: string = "a";
console.log((k in obj), ("z" in obj));`;
    await behaves(src, "true false");
    expect(compile(src)).toContain(".contains_key(");
  });

  test("REC2 `delete obj[k]` → `shift_remove`", async () => {
    const src = `const obj: Record<string, number> = { a: 1, b: 2 };
delete obj["a"];
console.log(("a" in obj), ("b" in obj));`;
    await behaves(src, "false true");
    expect(compile(src)).toContain(".shift_remove(");
  });

  test("REC3 variable-key read → `Option`", async () => {
    const src = `const obj: Record<string, number> = { a: 1 };
const k: string = "a";
const miss: string = "z";
console.log((obj[k] ?? -1), (obj[miss] ?? -1));`;
    await behaves(src, "1 -1");
    expect(compile(src)).toContain(".get(");
    expect(compile(src)).toContain(".cloned()");
  });

  test("FL1 a struct key with an `f64` field is fail-loud (own issue)", () => {
    rejects(
      `interface P { x: number; y: number; }
const m: Map<P, string> = new Map<P, string>();`,
      /f64|Hash|key/i,
    );
  });
});
