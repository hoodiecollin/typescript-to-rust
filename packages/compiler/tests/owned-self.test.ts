/**
 * Specs for series 068 — broad owned-`self` (consuming methods → `fn m(self)`,
 * issue #35). Graduates the 060 owned-`self` deferral: a method that moves a
 * non-`Copy` field out of `this` with no subsequent `self` use (`build(): T {
 * return this.field }`) lowers to an **owned** receiver and drops the 038 field
 * clone. When the receiver is **reused** after the consuming call, it promotes to
 * `Rc<RefCell<T>>` (the 062/069 alias-escape machinery — the same union-find) and
 * the method falls back to `&self` + clone; a non-`Clone` moved-out field under
 * reuse is a documented `UnsupportedError` boundary (a fail-loud residual — #80
 * reclassified it from forbidden → deferral).
 *
 * Each behavioral spec differential-matches (compile → cargo run → TS-via-Bun). IDs
 * map to docs/work/068-owned-self/specs.md.
 */

import { expect, test } from "bun:test";
import { UnsupportedError } from "../src/errors";
import { compile, defineDifferential } from "./_support/differential";

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

defineDifferential("owned-self", [
  {
    name: "OS1 dead-after consuming call → fn m(self), no clone",
    src: `${CONFIG}${BUILDER}const b: Builder = new Builder(new Config("x"));
const c: Config = b.build();
console.log(c.name);`,
    expected: "x",
    // Owned receiver, and the moved-out field read drops the 038 clone.
    extra: ({ rust }) => {
      expect(rust).toMatch(/fn build\(self\)/);
      expect(rust).toContain("return self.cfg;");
      expect(rust).not.toContain("self.cfg.clone()");
    },
  },
  {
    name: "OS2 a non-`Clone` moved-out field compiles now (was cargo-loud)",
    // `Handle` (fn-pointer field) is non-`Clone`, so the 038 path could not clone
    // `self.h` behind `&self` (E0507). Owned `self` moves it out cleanly.
    src: `${HANDLE}class Owner {
  h: Handle;
  constructor(h: Handle) { this.h = h; }
  take(): Handle { return this.h; }
}
function apply(cb: (x: number) => number, v: number): number { return cb(v); }
function dbl(x: number): number { return x * 2; }
const o: Owner = new Owner(new Handle(dbl, "h1"));
const h: Handle = o.take();
console.log(h.tag, apply(h.cb, 5));`,
    expected: "h1 10",
    extra: ({ rust }) => expect(rust).toMatch(/fn take\(self\)/),
  },
  {
    name: "OS3 an `Array` field consuming method (intoVec) — owned self",
    src: `class Wrapper {
  items: Array<number>;
  constructor(items: Array<number>) { this.items = items; }
  intoVec(): Array<number> { return this.items; }
}
const w: Wrapper = new Wrapper([1, 2, 3]);
const v: Array<number> = w.intoVec();
console.log(v[0], v.length);`,
    expected: "1 3",
    extra: ({ rust }) => {
      expect(rust).toMatch(/fn intoVec\(self\)/);
      expect(rust).not.toContain("self.items.clone()");
    },
  },
  {
    name: "OS4 reused receiver → promote to Rc<RefCell<T>>, method falls back to &self + clone",
    // `b` is reused (`b.label()`) after `b.build()`, so `b` promotes to
    // `Rc<RefCell<Builder>>` and `build` reverts to `&self` + clone.
    src: `${CONFIG}class Builder {
  cfg: Config;
  constructor(cfg: Config) { this.cfg = cfg; }
  build(): Config { return this.cfg; }
  label(): string { return this.cfg.name; }
}
const b: Builder = new Builder(new Config("x"));
const c: Config = b.build();
console.log(b.label(), c.name);`,
    expected: "x x",
    extra: ({ rust }) => {
      expect(rust).toContain("Rc<RefCell<Builder>>");
      expect(rust).toContain("b.borrow().build()");
      // Demoted: the method keeps `&self` and the 038 clone (never `fn build(self)`).
      expect(rust).toMatch(/fn build\(&self\)/);
      expect(rust).toContain("self.cfg.clone()");
    },
  },
  {
    name: "OS6 regression: a non-consuming &self method is unchanged",
    // `area` reads a field but does not move it out → stays `&self`, no owned self.
    src: `class Rect {
  w: number;
  h: number;
  constructor(w: number, h: number) { this.w = w; this.h = h; }
  area(): number { return this.w * this.h; }
}
const r: Rect = new Rect(3, 4);
console.log(r.area());`,
    expected: "12",
    extra: ({ rust }) => {
      expect(rust).toMatch(/fn area\(&self\)/);
      expect(rust).not.toContain("fn area(self)");
    },
  },
  {
    name: "OS7 regression: a Copy-field return stays &self (no owned self)",
    // `get(): number { return this.n }` moves out a Copy field — no move-avoidance
    // benefit, so the non-`Copy` gate keeps it `&self` (byte-for-byte unchanged).
    src: `class Cell {
  n: number;
  constructor(n: number) { this.n = n; }
  get(): number { return this.n; }
}
const c: Cell = new Cell(7);
console.log(c.get(), c.get());`,
    expected: "7 7",
    extra: ({ rust }) => {
      expect(rust).toMatch(/fn get\(&self\)/);
      expect(rust).not.toContain("fn get(self)");
    },
  },
]);

test("OS5 reused receiver + non-`Clone` moved-out field → UnsupportedError", () => {
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
  expect(() => compile(src)).toThrow(UnsupportedError);
});
