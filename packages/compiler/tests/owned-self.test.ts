/**
 * Specs for series 068 — broad owned-`self` (consuming methods → `fn m(self)`,
 * issue #35). Graduates the 060 owned-`self` deferral: a method that moves a
 * non-`Copy` field out of `this` with no subsequent `self` use (`build(): T {
 * return this.field }`) lowers to an **owned** receiver and drops the 038 field
 * clone. When the receiver is **reused** after the consuming call, it promotes to
 * `Rc<RefCell<T>>` (the 062/069 alias-escape machinery — the same union-find) and
 * the method falls back to `&self` + clone; a non-`Clone` moved-out field under
 * reuse is a documented `DialectError` boundary.
 *
 * Each behavioral spec differential-matches (compile → cargo run → TS-via-Bun). IDs
 * map to docs/work/068-owned-self/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { DialectError } from "../src/errors";
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

const CONFIG = `class Config {
  name: string;
  constructor(name: string) { this.name = name; }
}
`;

const BUILDER = `class Builder {
  cfg: Config;
  constructor(cfg: Config) { this.cfg = cfg; }
  build(): Config { return this.cfg; }
}
`;

// A non-`Clone` class: a fn-pointer field lands the emitter's struct outside the
// `Clone` derive (and outside the movable set), so `return this.h` cannot be cloned.
const HANDLE = `class Handle {
  cb: (x: number) => number;
  tag: string;
  constructor(cb: (x: number) => number, tag: string) { this.cb = cb; this.tag = tag; }
}
`;

describe("068 owned-self (consuming methods → fn m(self))", () => {
  test("OS1 dead-after consuming call → fn m(self), no clone", async () => {
    const src = `${CONFIG}${BUILDER}const b: Builder = new Builder(new Config("x"));
const c: Config = b.build();
console.log(c.name);`;
    await behaves(src, "x");
    const rust = compile(src);
    // Owned receiver, and the moved-out field read drops the 038 clone.
    expect(rust).toMatch(/fn build\(self\)/);
    expect(rust).toContain("return self.cfg;");
    expect(rust).not.toContain("self.cfg.clone()");
  });

  test("OS2 a non-`Clone` moved-out field compiles now (was cargo-loud)", async () => {
    // `Handle` (fn-pointer field) is non-`Clone`, so the 038 path could not clone
    // `self.h` behind `&self` (E0507). Owned `self` moves it out cleanly.
    const src = `${HANDLE}class Owner {
  h: Handle;
  constructor(h: Handle) { this.h = h; }
  take(): Handle { return this.h; }
}
function apply(cb: (x: number) => number, v: number): number { return cb(v); }
function dbl(x: number): number { return x * 2; }
const o: Owner = new Owner(new Handle(dbl, "h1"));
const h: Handle = o.take();
console.log(h.tag, apply(h.cb, 5));`;
    await behaves(src, "h1 10");
    expect(compile(src)).toMatch(/fn take\(self\)/);
  });

  test("OS3 an `Array` field consuming method (intoVec) — owned self", async () => {
    const src = `class Wrapper {
  items: Array<number>;
  constructor(items: Array<number>) { this.items = items; }
  intoVec(): Array<number> { return this.items; }
}
const w: Wrapper = new Wrapper([1, 2, 3]);
const v: Array<number> = w.intoVec();
console.log(v[0], v.length);`;
    await behaves(src, "1 3");
    const rust = compile(src);
    expect(rust).toMatch(/fn intoVec\(self\)/);
    expect(rust).not.toContain("self.items.clone()");
  });

  test("OS4 reused receiver → promote to Rc<RefCell<T>>, method falls back to &self + clone", async () => {
    // `b` is reused (`b.label()`) after `b.build()`, so `b` promotes to
    // `Rc<RefCell<Builder>>` and `build` reverts to `&self` + clone.
    const src = `${CONFIG}class Builder {
  cfg: Config;
  constructor(cfg: Config) { this.cfg = cfg; }
  build(): Config { return this.cfg; }
  label(): string { return this.cfg.name; }
}
const b: Builder = new Builder(new Config("x"));
const c: Config = b.build();
console.log(b.label(), c.name);`;
    await behaves(src, "x x");
    const rust = compile(src);
    expect(rust).toContain("Rc<RefCell<Builder>>");
    expect(rust).toContain("b.borrow().build()");
    // Demoted: the method keeps `&self` and the 038 clone (never `fn build(self)`).
    expect(rust).toMatch(/fn build\(&self\)/);
    expect(rust).toContain("self.cfg.clone()");
  });

  test("OS5 reused receiver + non-`Clone` moved-out field → DialectError", () => {
    const src = `${HANDLE}class Owner {
  h: Handle;
  constructor(h: Handle) { this.h = h; }
  take(): Handle { return this.h; }
  name(): string { return this.h.tag; }
}
function dbl(x: number): number { return x * 2; }
const o: Owner = new Owner(new Handle(dbl, "h1"));
const h: Handle = o.take();
console.log(h.tag, o.name());`;
    expect(() => compile(src)).toThrow(DialectError);
  });

  test("OS6 regression: a non-consuming &self method is unchanged", async () => {
    // `area` reads a field but does not move it out → stays `&self`, no owned self.
    const src = `class Rect {
  w: number;
  h: number;
  constructor(w: number, h: number) { this.w = w; this.h = h; }
  area(): number { return this.w * this.h; }
}
const r: Rect = new Rect(3, 4);
console.log(r.area());`;
    await behaves(src, "12");
    const rust = compile(src);
    expect(rust).toMatch(/fn area\(&self\)/);
    expect(rust).not.toContain("fn area(self)");
  });

  test("OS7 regression: a Copy-field return stays &self (no owned self)", async () => {
    // `get(): number { return this.n }` moves out a Copy field — no move-avoidance
    // benefit, so the non-`Copy` gate keeps it `&self` (byte-for-byte unchanged).
    const src = `class Cell {
  n: number;
  constructor(n: number) { this.n = n; }
  get(): number { return this.n; }
}
const c: Cell = new Cell(7);
console.log(c.get(), c.get());`;
    await behaves(src, "7 7");
    const rust = compile(src);
    expect(rust).toMatch(/fn get\(&self\)/);
    expect(rust).not.toContain("fn get(self)");
  });
});
