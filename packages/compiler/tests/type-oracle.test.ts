/**
 * Specs for series 082 — TypeOracle: tsc-checker-backed type resolution coupled
 * with oxc (graduates spike #44, issue #49). Slice 1 cuts `collectionOf` over to
 * the oracle so a `Map`/`Set` receiver of ANY expression shape — `this.field`, a
 * field of a local, a `getX()` call — lowers to its `IndexMap`/`IndexSet` ops,
 * where before only a bare-identifier receiver resolved.
 *
 * `compile` threads the source text (so the oracle is active); `compileNoSource`
 * lowers without it (the pre-082 `bindingTypes`-only path), used to prove the
 * regression specs. IDs map to docs/work/082-type-oracle/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { runRust } from "../src/harness";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program, src);
}

function compileNoSource(src: string): string {
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

describe("082 TypeOracle — collectionOf cut-over", () => {
  test("ORAC1 `this.field` Map — read + mutate through the oracle", async () => {
    const src = `class Store {
  cache: Map<string, number>;
  constructor() { this.cache = new Map<string, number>(); }
  seed(): void {
    const k: string = "a";
    this.cache.set(k, 1);
    this.cache.set("b", 2);
  }
  read(): void {
    const k: string = "a";
    console.log(this.cache.get(k) ?? -1);
    console.log(this.cache.has("b"), this.cache.has("z"));
    console.log(this.cache.size);
  }
}
const s: Store = new Store();
s.seed();
s.read();`;
    await behaves(src, "1\ntrue false\n2");
    const rust = compile(src);
    expect(rust).toContain(".insert(");
    expect(rust).toContain(".cloned()");
    expect(rust).toContain(".contains_key(");
    // The field-mutating method resolves to `&mut self`.
    expect(rust).toContain("fn seed(&mut self)");
  });

  test("ORAC2 `this.field` Set<number> — OrderedFloat elem", async () => {
    const src = `class Tags {
  tags: Set<number>;
  constructor() { this.tags = new Set<number>(); }
  add2(n: number): void { this.tags.add(n); }
  read(): void {
    console.log(this.tags.has(1), this.tags.has(9));
    console.log(this.tags.size);
  }
}
const t: Tags = new Tags();
t.add2(1);
t.add2(2);
t.read();`;
    await behaves(src, "true false\n2");
    const rust = compile(src);
    expect(rust).toContain("IndexSet<OrderedFloat<f64>>");
    expect(rust).toContain("OrderedFloat(");
    // The field-mutating method resolves to `&mut self`.
    expect(rust).toContain("fn add2(&mut self,");
  });

  test("ORAC3 `getX()` call receiver resolves", async () => {
    const src = `class Store {
  cache: Map<string, number>;
  constructor() { this.cache = new Map<string, number>(); }
  seed(): void { this.cache.set("a", 5); }
  getCache(): Map<string, number> { return this.cache; }
  read(): void {
    const k: string = "a";
    console.log(this.getCache().get(k) ?? -1);
  }
}
const s: Store = new Store();
s.seed();
s.read();`;
    await behaves(src, "5");
    expect(compile(src)).toContain(".cloned()");
  });

  test("ORAC4 field-of-local receiver resolves", async () => {
    // `store.cache` — a field of a local (a function parameter) is a
    // MemberExpression `bindingTypes` can't key on; the oracle resolves it.
    const src = `class Store {
  cache: Map<string, number>;
  constructor() { this.cache = new Map<string, number>(); }
  seed(): void { this.cache.set("a", 7); }
}
function lookup(store: Store): number { return store.cache.get("a") ?? -1; }
const s: Store = new Store();
s.seed();
console.log(lookup(s));`;
    await behaves(src, "7");
    expect(compile(src)).toContain(".cloned()");
  });

  test("ORAC5 bare-identifier Map receiver is byte-for-byte unchanged", () => {
    const src = `const m: Map<string, number> = new Map<string, number>();
m.set("a", 1);
console.log(m.get("a") ?? -1, m.has("a"), m.size);`;
    // Oracle present (source threaded) vs absent must emit identically — the
    // bindingTypes path answers first for an identifier receiver, so the oracle
    // is never consulted and cannot drift the output.
    expect(compile(src)).toBe(compileNoSource(src));
  });

  test("ORAC6 non-map `this.field` receiver is untouched", async () => {
    const src = `class Counter {
  count: number;
  constructor() { this.count = 3; }
  show(): void { console.log(this.count + 1); }
}
const c: Counter = new Counter();
c.show();`;
    await behaves(src, "4");
    // Not a map/set → the oracle returns null, no IndexMap/IndexSet routing.
    const rust = compile(src);
    expect(rust).not.toContain("IndexMap");
    expect(rust).not.toContain("IndexSet");
  });

  test("ORAC7 no-source path still lowers a bare-identifier map", async () => {
    const src = `const m: Map<string, number> = new Map<string, number>();
m.set("a", 1);
console.log(m.get("a") ?? -1);`;
    const rust = compileNoSource(src);
    const rr = await runRust(rust);
    expect(rr.ok).toBe(true);
    expect(rr.stdout.trim()).toBe("1");
  });
});
