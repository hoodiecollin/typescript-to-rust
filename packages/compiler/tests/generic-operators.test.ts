/**
 * Specs for series 088 — operators on a generic `T` via a uniform tslib
 * JS-operator trait layer (issue #62). Graduates the operators-on-`T` fail-loud
 * from series 081: when **both operands of an operator are the same
 * `{kind:"param"}` T**, the operator lowers to a tslib `ops` trait method
 * (`self.v.js_add(&o)`) and the operator's bound (`T: tslib::ops::JsAdd`) is
 * unioned onto the scope's generic clause. Dispatch is by-reference, ownership-safe.
 * The trait bound IS the constraint (no `<T extends number>`). Mixed operands
 * (`this.v + 1`) and logical/bitwise over a bare `T` stay fail-loud.
 *
 * IDs map to docs/work/088-generic-operators/specs.md (GOP1–GOP9).
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { runRust } from "../src/harness";
import { UnsupportedError } from "../src/lower";

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
  if (!rr.ok) console.error(rust, rr.stderr);
  expect(rr.ok).toBe(true);
  expect(rr.stdout.trim()).toBe(runTs(src));
  expect(rr.stdout.trim()).toBe(expected);
}

describe("088 in-scope operators over a same-T pair", () => {
  test("GOP1 polymorphic `+` (numeric add AND string concat) from one T", async () => {
    const src = `class Box<T> {
  v: T;
  constructor(v: T) { this.v = v; }
  combine(o: T): T { return this.v + o; }
}
console.log(new Box(5).combine(3));
console.log(new Box("a").combine("b"));`;
    const rust = compile(src);
    expect(rust).toContain("tslib::ops::JsAdd");
    expect(rust).toContain(".js_add(&");
    await behaves(src, "8\nab");
  });

  test("GOP2 `- * / %` over a numeric T", async () => {
    const src = `class Calc<T> {
  v: T;
  constructor(v: T) { this.v = v; }
  sub(o: T): T { return this.v - o; }
  mul(o: T): T { return this.v * o; }
  div(o: T): T { return this.v / o; }
  rem(o: T): T { return this.v % o; }
}
const c: Calc<number> = new Calc(10);
console.log(c.sub(3));
console.log(c.mul(3));
console.log(c.div(4));
console.log(c.rem(3));`;
    const rust = compile(src);
    expect(rust).toContain(".js_sub(&");
    expect(rust).toContain(".js_mul(&");
    expect(rust).toContain(".js_div(&");
    expect(rust).toContain(".js_rem(&");
    await behaves(src, "7\n30\n2.5\n1");
  });

  test("GOP3 ordering `< > <= >=` over numeric and BMP-string T", async () => {
    const src = `class Ord<T> {
  v: T;
  constructor(v: T) { this.v = v; }
  lt(o: T): boolean { return this.v < o; }
  gt(o: T): boolean { return this.v > o; }
  le(o: T): boolean { return this.v <= o; }
  ge(o: T): boolean { return this.v >= o; }
}
const n: Ord<number> = new Ord(2);
console.log(n.lt(3));
console.log(n.gt(3));
console.log(n.le(2));
console.log(n.ge(5));
const s: Ord<string> = new Ord("apple");
console.log(s.lt("banana"));
console.log(s.ge("apple"));`;
    const rust = compile(src);
    expect(rust).toContain("tslib::ops::JsOrd");
    expect(rust).toContain(".js_lt(&");
    await behaves(src, "true\nfalse\ntrue\nfalse\ntrue\ntrue");
  });

  test("GOP4 equality `=== !==` over a primitive T (number, string, bool)", async () => {
    const src = `class Eq<T> {
  v: T;
  constructor(v: T) { this.v = v; }
  eq(o: T): boolean { return this.v === o; }
  ne(o: T): boolean { return this.v !== o; }
}
console.log(new Eq(5).eq(5));
console.log(new Eq(5).ne(6));
console.log(new Eq("x").eq("x"));
console.log(new Eq(true).ne(false));`;
    const rust = compile(src);
    expect(rust).toContain("tslib::ops::JsEq");
    expect(rust).toContain(".js_eq(&");
    expect(rust).toContain(".js_ne(&");
    await behaves(src, "true\ntrue\ntrue\ntrue");
  });

  test("GOP5 `===` over a struct-instantiated T (structural, documented divergence)", async () => {
    // A struct-typed `T` gets a per-struct `impl tslib::ops::JsEq for Point`
    // delegating to the derived `PartialEq` — so `===` is **structural** (Rust),
    // the same documented edge the dialect accepts for concrete struct `===` (JS
    // uses object identity). Differing-field structs agree (both `false`); the
    // distinct-but-equal case pins the divergence (Rust `true`, JS `false`).
    // Differing-field structs → both Rust and JS say `false`; this case fully
    // differential-matches and exercises the trait path (`js_eq`/`js_ne`).
    const src = `class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) { this.x = x; this.y = y; }
}
class Eq<T> {
  v: T;
  constructor(v: T) { this.v = v; }
  eq(o: T): boolean { return this.v === o; }
  ne(o: T): boolean { return this.v !== o; }
}
console.log(new Eq(new Point(1, 2)).eq(new Point(3, 4)));
console.log(new Eq(new Point(1, 2)).ne(new Point(3, 4)));`;
    const rust = compile(src);
    expect(rust).toContain("impl tslib::ops::JsEq for Point");
    expect(rust).toContain(".js_eq(&");
    expect(rust).toContain(".js_ne(&");
    await behaves(src, "false\ntrue");

    // The pinned structural-vs-identity divergence: distinct-but-equal structs are
    // structurally equal in Rust (`true`) but reference-unequal in JS (`false`).
    const distinct = `class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) { this.x = x; this.y = y; }
}
class Eq<T> {
  v: T;
  constructor(v: T) { this.v = v; }
  eq(o: T): boolean { return this.v === o; }
}
console.log(new Eq(new Point(1, 2)).eq(new Point(1, 2)));`;
    const dr = await runRust(compile(distinct));
    expect(dr.ok).toBe(true);
    expect(dr.stdout.trim()).toBe("true");
    expect(runTs(distinct)).toBe("false");
  });

  test("GOP6 mixed `Pair<A, B>`: `+` on A, `<` on B, independently bounded", async () => {
    const src = `class Pair<A, B> {
  a: A;
  b: B;
  constructor(a: A, b: B) { this.a = a; this.b = b; }
  addA(o: A): A { return this.a + o; }
  ltB(o: B): boolean { return this.b < o; }
}
const p: Pair<number, string> = new Pair(1, "m");
console.log(p.addA(2));
console.log(p.ltB("n"));`;
    const rust = compile(src);
    expect(rust).toContain("A: tslib::ops::JsAdd");
    expect(rust).toContain("B: tslib::ops::JsOrd");
    await behaves(src, "3\ntrue");
  });
});

describe("088 fail-loud residuals", () => {
  test("GOP7 mixed operands (`this.v + 1`, `t < 5`) fail loud", () => {
    const literalPlus = `class Box<T> {
  v: T;
  constructor(v: T) { this.v = v; }
  bump(): T { return this.v + 1; }
}
console.log("x");`;
    expect(() => compile(literalPlus)).toThrow(UnsupportedError);

    const paramVsLiteral = `class Box<T> {
  v: T;
  constructor(v: T) { this.v = v; }
  small(t: T): boolean { return t < 5; }
}
console.log("x");`;
    expect(() => compile(paramVsLiteral)).toThrow(UnsupportedError);
  });

  test("GOP8 logical / bitwise over a bare T fails loud", () => {
    const logical = `class Box<T> {
  v: T;
  constructor(v: T) { this.v = v; }
  both(o: T): T { return this.v && o; }
}
console.log("x");`;
    expect(() => compile(logical)).toThrow(UnsupportedError);

    const bitwise = `class Box<T> {
  v: T;
  constructor(v: T) { this.v = v; }
  bor(o: T): T { return this.v | o; }
}
console.log("x");`;
    expect(() => compile(bitwise)).toThrow(UnsupportedError);
  });
});

describe("088 regression", () => {
  test("GOP9 a concrete-typed operator (non-generic class) is unchanged", () => {
    const src = `class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) { this.x = x; this.y = y; }
  sum(): number { return this.x + this.y; }
}
console.log(new Point(1, 2).sum());`;
    const rust = compile(src);
    // The concrete `+` stays a native operator — no JS-operator trait dispatch, no
    // generic clause. (A per-struct `impl tslib::ops::JsEq` is emitted additively for
    // any `PartialEq` struct by design — it does not change the operator emission.)
    expect(rust).toContain("self.x + self.y");
    expect(rust).not.toContain("js_add");
    expect(rust).not.toContain("js_lt");
    expect(rust).not.toContain("impl<");
    expect(rust).toContain("impl Point {");
  });
});
