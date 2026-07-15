/**
 * Specs for series 060 — class deferrals. Graduates issue #23: method-parameter
 * borrow inference (params infer `&T`/`&mut T` like free fns), `static`
 * members (associated `fn`/`const`, `Type::m` call sites), getters/setters
 * (transparent-access rewrite), and public/private accessibility (`protected`
 * fail-loud). Generics, owned-`self`, and decorators stay fail-loud.
 *
 * Each spec differential-matches (compile → cargo run → TS-via-Bun). IDs map to
 * docs/work/060-class-deferrals/specs.md.
 */

import { expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { lower } from "../src/lower";
import { defineDifferential } from "./_support/differential";

function rejects(src: string, re: RegExp): void {
  expect(() =>
    lower(parseSync("t.ts", src).program as unknown as Program),
  ).toThrow(re);
}

defineDifferential("class-deferrals", [
  {
    name: "CLS1 a method reading a struct param infers `&Point`",
    src: `interface Point { x: number; y: number; }
class Calc {
  base: number;
  constructor(base: number) { this.base = base; }
  addTo(p: Point): number { return p.x + p.y + this.base; }
}
const c: Calc = new Calc(10);
const pt: Point = { x: 1, y: 2 };
console.log(c.addTo(pt));`,
    expected: "13",
    extra: ({ rust }) => {
      expect(rust).toContain("fn addTo(&self, p: &Point)");
      expect(rust).toContain("c.addTo(&pt)");
    },
  },
  {
    name: "CLS2 a method mutating an array param infers `&mut`",
    src: `class Filler {
  tag: number;
  constructor(tag: number) { this.tag = tag; }
  fill(xs: Array<number>): void { xs.push(9); }
}
const f: Filler = new Filler(0);
const arr: Array<number> = [1, 2];
f.fill(arr);
console.log(arr.length, arr[2]);`,
    expected: "3 9",
    extra: ({ rust }) => {
      expect(rust).toContain("xs: &mut Vec<f64>");
      expect(rust).toContain("f.fill(&mut arr)");
    },
  },
  {
    name: "CLS3 static method → `Type::m()`",
    src: `class P {
  x: number;
  y: number;
  constructor(x: number, y: number) { this.x = x; this.y = y; }
  static origin(): P { return new P(0, 0); }
}
const o: P = P.origin();
console.log(o.x, o.y);`,
    expected: "0 0",
    extra: ({ rust }) => {
      expect(rust).toContain("fn origin() -> P");
      expect(rust).toContain("P::origin()");
    },
  },
  {
    name: "CLS4 static field → associated `const`, read as `Type::NAME`",
    src: `class Config {
  static MAX: number = 100;
  v: number;
  constructor(v: number) { this.v = v; }
}
console.log(Config.MAX);`,
    expected: "100",
    extra: ({ rust }) => {
      expect(rust).toContain("const MAX: f64 = 100.0;");
      expect(rust).toContain("Config::MAX");
    },
  },
  {
    name: "CLS5 getter read `r.area` → `r.area()`",
    src: `class Rect {
  w: number;
  h: number;
  constructor(w: number, h: number) { this.w = w; this.h = h; }
  get area(): number { return this.w * this.h; }
}
const r: Rect = new Rect(3, 4);
console.log(r.area);`,
    expected: "12",
    extra: ({ rust }) => {
      expect(rust).toContain("fn area(&self) -> f64");
      expect(rust).toContain("r.area()");
    },
  },
  {
    name: "CLS6 setter write `b.w = v` → `b.set_w(v)`",
    src: `class Box2 {
  private _w: number;
  constructor(w: number) { this._w = w; }
  get w(): number { return this._w; }
  set w(v: number) { this._w = v; }
}
const b: Box2 = new Box2(1);
b.w = 5;
console.log(b.w);`,
    expected: "5",
    extra: ({ rust }) => {
      expect(rust).toContain("fn set_w(&mut self, v: f64)");
      expect(rust).toContain("b.set_w(5.0)");
    },
  },
  {
    name: "CLS7 public/private accessibility is accepted (behaves)",
    src: `class Acct {
  public owner: number;
  private balance: number;
  constructor(owner: number, balance: number) { this.owner = owner; this.balance = balance; }
  total(): number { return this.owner + this.balance; }
}
const a: Acct = new Acct(1, 40);
console.log(a.total());`,
    expected: "41",
  },
]);

test("CLS8 a `protected` member is fail-loud", () => {
  rejects(
    `class C {
  protected secret: number;
  constructor(secret: number) { this.secret = secret; }
}`,
    /protected/i,
  );
});
