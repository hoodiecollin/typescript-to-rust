/**
 * Specs for series 078 — field-held mutable collections
 * (`localVar.field.<mut>()` borrow tail, issue #45, companion to #37/072).
 *
 * 072 resolves a `localVar.field` Map/Set receiver (via the 082 tsc oracle) but
 * ships only the **clean** owned-local case, failing loud on the borrow-conflict
 * tail. This series graduates that tail:
 *
 *  - **Clean** — a plainly-owned local mutates its field-collection directly
 *    (`let mut c; c.entries.insert(..)`), the missing 072-clean `mut` piece.
 *  - **Promote** — an aliased / field-stored owner promotes to `Rc<RefCell<T>>`
 *    (the shared `computeAutoRc` union-find, one more alias shape) and mutates
 *    through `.borrow_mut().field.insert(..)` (the `refineRc` write-mode fix).
 *
 * Each spec differential-matches (compile → cargo run → TS-via-Bun). IDs map to
 * docs/work/078-field-collection-ownership/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { checkRust, runRust } from "../src/harness";

function compile(src: string): string {
  // The 082 tsc oracle (`collectionOf` for `localVar.field` Map/Set receivers)
  // needs the raw source — pass it as `emit`'s second arg, or field receivers
  // fall back to `bindingTypes` and never resolve.
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

const CACHE = `class Cache {
  entries: Map<string, number>;
  tags: Set<string>;
  constructor() {
    this.entries = new Map<string, number>();
    this.tags = new Set<string>();
  }
}
`;

describe("078 field-held collection ownership (localVar.field.<mut>())", () => {
  test("FC1 clean owned local: direct insert on a `mut` binding", async () => {
    const src = `${CACHE}const c: Cache = new Cache();
c.entries.set("k", 1);
console.log(c.entries.get("k") ?? -1);`;
    await behaves(src, "1");
    const rust = compile(src);
    expect(rust).toContain("let mut c");
    expect(rust).toContain("c.entries.insert(");
    expect(rust).not.toContain("Rc<RefCell");
  });

  test("FC2 clean owned local: Set field add + has", async () => {
    const src = `${CACHE}const c: Cache = new Cache();
c.tags.add("x");
console.log(c.tags.has("x"));`;
    await behaves(src, "true");
    const rust = compile(src);
    expect(rust).toContain("c.tags.insert(");
    expect(rust).not.toContain("Rc<RefCell");
  });

  test("FC3 clean owned local: delete on a field map", async () => {
    const src = `${CACHE}const c: Cache = new Cache();
c.entries.set("k", 1);
c.entries.delete("k");
console.log(c.entries.get("k") ?? -1);`;
    await behaves(src, "-1");
    const rust = compile(src);
    expect(rust).toContain("c.entries.shift_remove(");
    expect(rust).not.toContain("Rc<RefCell");
  });

  test("FC4 aliased owner: both promote, mutation observed through the alias", async () => {
    const src = `${CACHE}const c: Cache = new Cache();
const d: Cache = c;
d.entries.set("k", 1);
console.log(c.entries.get("k") ?? -1);`;
    await behaves(src, "1");
    const rust = compile(src);
    expect(rust).toContain("Rc<RefCell<Cache>>");
    expect(rust).toContain("borrow_mut().entries.insert(");
  });

  test("FC5 field-stored owner: promotion threads through the container field", async () => {
    const src = `${CACHE}class Box {
  c: Cache;
  constructor(c: Cache) { this.c = c; }
}
const c: Cache = new Cache();
const h: Box = new Box(c);
c.entries.set("k", 2);
console.log(h.c.entries.get("k") ?? -1);`;
    await behaves(src, "2");
    expect(compile(src)).toContain("Rc<RefCell<Cache>>");
  });

  test("FC6 promoted owner: read through the alias returns the written value", async () => {
    const src = `${CACHE}const c: Cache = new Cache();
const d: Cache = c;
c.entries.set("a", 10);
d.entries.set("b", 20);
console.log((c.entries.get("a") ?? 0) + (d.entries.get("b") ?? 0));`;
    await behaves(src, "30");
    expect(compile(src)).toContain("Rc<RefCell<Cache>>");
  });

  test("FC7 fail-loud: a lifted callback mutating a captured field-collection (→ #46)", () => {
    // A collection mutation of a captured owner inside a lifted callback is a
    // mutable capture — a clean `DialectError` at `freeVarsOf`, not a miscompile.
    // Closure-capture graduation itself is out of #45's scope (→ #46); the interim
    // rejection stands and now covers the field-collection shape.
    const src = `${CACHE}const c: Cache = new Cache();
const xs: Array<string> = ["a", "b"];
const ys: Array<number> = xs.map((k: string): number => c.entries.set(k, 1).size);
console.log(ys.length);`;
    expect(() => compile(src)).toThrow(/mutable capture/);
  });

  test("FC8 fail-loud: mutate-during-iteration over a field-collection (→ #41)", async () => {
    // Mutating a field-collection while iterating it is the mutate-during-iteration
    // shape #41 owns. It stays **cargo-loud** (the emitted Rust double-borrows / has
    // no such method) — fail-loud, no new panic emitted — until #41 ships its
    // index-based re-borrow. Not promoted (owner is unaliased), so no `Rc`.
    const src = `${CACHE}const c: Cache = new Cache();
c.entries.set("k", 1);
for (const [k, v] of c.entries) {
  c.entries.set(k, v + 1);
}
console.log(c.entries.get("k") ?? -1);`;
    const r = await checkRust(compile(src));
    expect(r.ok).toBe(false);
  });

  test("FC9 regression: `this.field` collection mutation is unchanged", async () => {
    // A `&mut self` method mutating a `this.field` map (072) — the always-sound
    // case (#45 leaves it untouched): direct `self.m.insert(..)`, no `Rc`. The
    // literal key avoids the orthogonal `&str`-param-vs-`String`-key limitation.
    const src = `class Store {
  m: Map<string, number>;
  constructor() { this.m = new Map<string, number>(); }
  seed(v: number): void { this.m.set("k", v); }
  total(): number { return this.m.get("k") ?? -1; }
}
const s: Store = new Store();
s.seed(5);
console.log(s.total());`;
    await behaves(src, "5");
    const rust = compile(src);
    expect(rust).toContain("self.m.insert(");
    expect(rust).not.toContain("Rc<RefCell");
  });

  test("FC10 regression: a plainly-owned field read needs no `mut` and no `Rc`", async () => {
    const src = `${CACHE}const c: Cache = new Cache();
console.log(c.entries.get("k") ?? -1);`;
    await behaves(src, "-1");
    const rust = compile(src);
    expect(rust).not.toContain("let mut c");
    expect(rust).not.toContain("Rc<RefCell");
  });
});
