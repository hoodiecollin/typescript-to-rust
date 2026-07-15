/**
 * Specs for series 083 slice 2 — the `&str`-key borrow fix. A `string` **param**
 * lowers to `&str`; a Map/Set lookup used to wrap it as `&(&str)` = `&&str`
 * (E0277). The fix drops the outer borrow for an already-`&str` key. Owned /
 * literal / OrderedFloat / structKey keys keep their `&`-wrapped path (regression).
 * IDs map to docs/work/083-library-methods-oracle/specs.md.
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

describe("083 &str-key borrow fix", () => {
  test("KEY1 m.get(k) with a string param over Map<string,V> — bare key", async () => {
    const src = `function lookup(m: Map<string, number>, k: string): number {
  return m.get(k) ?? -1;
}
const m: Map<string, number> = new Map<string, number>();
m.set("a", 1);
console.log(lookup(m, "a"), lookup(m, "z"));`;
    await behaves(src, "1 -1");
    const rust = compile(src);
    // Bare `k`, never `&k` (which would be `&&str`).
    expect(rust).toContain(".get(k)");
    expect(rust).not.toContain(".get(&k)");
  });

  test("KEY2 m.has(k) / m.delete(k) with a string param — bare key", async () => {
    const src = `function del(m: Map<string, number>, k: string): boolean {
  const had: boolean = m.has(k);
  m.delete(k);
  return had;
}
const m: Map<string, number> = new Map<string, number>();
m.set("a", 1);
console.log(del(m, "a"), m.has("a"));`;
    await behaves(src, "true false");
    const rust = compile(src);
    expect(rust).toContain(".contains_key(k)");
    expect(rust).toContain(".shift_remove(k)");
  });

  test("KEY3 s.has(k) with a string param over Set<string> — bare key", async () => {
    const src = `function seen(s: Set<string>, k: string): boolean {
  return s.has(k);
}
const s: Set<string> = new Set<string>();
s.add("x");
console.log(seen(s, "x"), seen(s, "y"));`;
    await behaves(src, "true false");
    expect(compile(src)).toContain(".contains(k)");
  });

  test("KEY-REG1 a literal / owned key keeps its &-wrapped path (regression)", async () => {
    const src = `const m: Map<string, number> = new Map<string, number>();
m.set("a", 1);
console.log(m.has("a"));
const owned: string = "a";
console.log(m.has(owned));`;
    await behaves(src, "true\ntrue");
    const rust = compile(src);
    // A string literal and an owned `String` local stay `&`-wrapped.
    expect(rust).toContain('.contains_key(&"a"');
    expect(rust).toContain(".contains_key(&owned)");
  });
});
