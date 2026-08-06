/**
 * Specs for series 093 — union types → Rust `enum`. Design + spec IDs:
 * series 093. Differentials (emitted Rust runs;
 * stdout === TS-via-Bun) unless a plain `test()` fail-loud pin.
 *
 * Grows stage-by-stage (design §10): a spec is added only once its stage compiles,
 * because a `compile()` throw in the shared `beforeAll` crashes the whole file.
 * Populated: **1a** (literal unions A/B), **1b** (discriminated inline objects C),
 * **1c** (anonymous synthesis + non-ident literals), **1d** (named-interface D +
 * primitive/mixed F via `typeof`), **1e** (non-discriminated E via `in`), plus
 * fail-loud residual pins (recursive, tuple alias, mixed literal+object G).
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("union-types", [
  // ── 1a: string-literal unions (A) ──────────────────────────────────────────
  {
    name: "UN-LIT1 string-literal union: construct + Display round-trip",
    src: `type Dir = "north" | "south" | "east" | "west";
const d: Dir = "north";
console.log(d);`,
    expected: "north",
    extra: ({ rust }) => expect(rust).toContain("enum Dir"),
  },
  {
    name: "UN-LIT2 switch over a string-literal union → exhaustive variant match",
    src: `type Dir = "north" | "south" | "east" | "west";
function opp(d: Dir): Dir {
  switch (d) {
    case "north": return "south";
    case "south": return "north";
    case "east": return "west";
    case "west": return "east";
  }
}
console.log(opp("north"));`,
    expected: "south",
  },
  {
    name: "UN-LIT3 === on a string-literal union (derive PartialEq)",
    src: `type Dir = "north" | "south";
const d: Dir = "north";
console.log(d === "north", d === "south");`,
    expected: "true false",
  },
  {
    name: "UN-LIT7 literal union as array element → Vec<enum>",
    src: `type Dir = "north" | "south";
const xs: Dir[] = ["north", "south"];
console.log(xs.length, xs[0]);`,
    expected: "2 north",
  },
  {
    name: "UN-LIT8 literal union as a struct field",
    src: `type Dir = "north" | "south" | "east";
interface Cmd { dir: Dir; }
const c: Cmd = { dir: "east" };
console.log(c.dir);`,
    expected: "east",
  },
  {
    name: "UN-LIT9 anonymous inline literal union (no alias) in a parameter",
    src: `function label(d: "a" | "b"): void { console.log(d); }
label("b");`,
    expected: "b",
    extra: ({ rust }) => expect(rust).toContain("__anonymous_union_"),
  },
  {
    name: "UN-LIT10 order-independent dedup: param & return unify to one enum",
    src: `function g(x: "a" | "b"): "b" | "a" { return x; }
console.log(g("a"));`,
    expected: "a",
  },
  // ── 1a: numeric-literal unions (B) ──────────────────────────────────────────
  {
    name: "UN-LIT4 numeric-literal union: construct + Display prints the number",
    src: `type Bit = 0 | 1;
const b: Bit = 1;
console.log(b);`,
    expected: "1",
  },
  {
    name: "UN-LIT5 switch over a numeric-literal union → variant match by value",
    src: `type Lvl = 1 | 2 | 3;
function name(l: Lvl): string {
  switch (l) {
    case 1: return "low";
    case 2: return "mid";
    case 3: return "high";
  }
}
console.log(name(2));`,
    expected: "mid",
  },
  // ── 1a: non-ident-safe literals (sanitize + exact round-trip) ───────────────
  {
    name: "UN-LIT6 non-ident-safe literals: sanitized variant, exact Display",
    src: `type K = "has-dash" | "with space" | "123";
const k: K = "has-dash";
console.log(k);`,
    expected: "has-dash",
  },
  // ── 1b: discriminated inline-object unions (C) → struct-variant enums ────────
  {
    name: "UN-DISC1 discriminated union: switch(x.kind) → variant match (circle)",
    src: `type Shape = { kind: "circle"; r: number } | { kind: "square"; s: number };
function area(sh: Shape): number {
  switch (sh.kind) {
    case "circle": return sh.r * sh.r;
    case "square": return sh.s * sh.s;
  }
}
console.log(area({ kind: "circle", r: 2 }));`,
    expected: "4",
    extra: ({ rust }) => expect(rust).toContain("enum Shape"),
  },
  {
    name: "UN-DISC2 discriminated union: the other arm (square)",
    src: `type Shape = { kind: "circle"; r: number } | { kind: "square"; s: number };
function area(sh: Shape): number {
  switch (sh.kind) {
    case "circle": return sh.r * sh.r;
    case "square": return sh.s * sh.s;
  }
}
console.log(area({ kind: "square", s: 3 }));`,
    expected: "9",
  },
  {
    name: "UN-DISC3 discriminated union: if/else-if ladder → variant match",
    src: `type Shape = { kind: "circle"; r: number } | { kind: "square"; s: number };
function area(sh: Shape): number {
  if (sh.kind === "circle") return sh.r * sh.r;
  else return sh.s * sh.s;
}
console.log(area({ kind: "circle", r: 3 }), area({ kind: "square", s: 4 }));`,
    expected: "9 16",
  },
  {
    name: "UN-DISC9 variant field is itself a declared struct (nested)",
    src: `interface Point { x: number; y: number; }
type Node = { kind: "at"; p: Point } | { kind: "origin" };
function nx(n: Node): number {
  switch (n.kind) {
    case "at": return n.p.x;
    case "origin": return 0;
  }
}
console.log(nx({ kind: "at", p: { x: 7, y: 2 } }), nx({ kind: "origin" }));`,
    expected: "7 0",
  },
  {
    name: "UN-DISC4 Vec<Shape> heterogeneous — iterate + match",
    src: `type Shape = { kind: "circle"; r: number } | { kind: "square"; s: number };
function area(sh: Shape): number {
  switch (sh.kind) {
    case "circle": return sh.r * sh.r;
    case "square": return sh.s * sh.s;
  }
}
const shapes: Shape[] = [{ kind: "circle", r: 1 }, { kind: "square", s: 2 }];
let total: number = 0;
for (const sh of shapes) { total = total + area(sh); }
console.log(total);`,
    expected: "5",
  },
  {
    name: "UN-DISC5 unit variant (discriminant-only member) beside a struct variant",
    src: `type Msg = { kind: "reset" } | { kind: "set"; value: number };
function apply(m: Msg): number {
  switch (m.kind) {
    case "reset": return 0;
    case "set": return m.value;
  }
}
console.log(apply({ kind: "reset" }), apply({ kind: "set", value: 5 }));`,
    expected: "0 5",
  },
  {
    name: "UN-DISC6 multi-field variant",
    src: `type Ev = { kind: "move"; x: number; y: number } | { kind: "stop" };
function dx(e: Ev): number {
  switch (e.kind) {
    case "move": return e.x + e.y;
    case "stop": return 0;
  }
}
console.log(dx({ kind: "move", x: 3, y: 4 }), dx({ kind: "stop" }));`,
    expected: "7 0",
  },
  {
    name: "UN-DISC7 discriminant named `type` (Fork-N2 precedence)",
    src: `type T = { type: "a"; n: number } | { type: "b"; n: number };
function get(t: T): number {
  switch (t.type) {
    case "a": return t.n;
    case "b": return t.n * 10;
  }
}
console.log(get({ type: "a", n: 5 }), get({ type: "b", n: 5 }));`,
    expected: "5 50",
  },
  {
    name: "UN-DISC8 String-bearing variant (derive PartialEq, not Copy)",
    src: `type R = { kind: "ok"; msg: string } | { kind: "err"; code: number };
function show(r: R): string {
  switch (r.kind) {
    case "ok": return r.msg;
    case "err": return "err";
  }
}
console.log(show({ kind: "ok", msg: "hi" }), show({ kind: "err", code: 1 }));`,
    expected: "hi err",
  },
  // ── 1c: anonymous synthesis + non-ident-safe literal hardening ──────────────
  {
    name: "UN-ANON1 anonymous discriminated union in a parameter",
    src: `function pick(sh: { kind: "c"; r: number } | { kind: "s"; side: number }): number {
  switch (sh.kind) {
    case "c": return sh.r;
    case "s": return sh.side;
  }
}
console.log(pick({ kind: "c", r: 5 }), pick({ kind: "s", side: 3 }));`,
    expected: "5 3",
    extra: ({ rust }) => expect(rust).toContain("__anonymous_union_"),
  },
  {
    name: "UN-ANON2 sanitize collision → ordinal disambiguation, exact round-trip",
    src: `type K = "has-dash" | "has_dash";
const a: K = "has-dash";
const b: K = "has_dash";
console.log(a, b);`,
    expected: "has-dash has_dash",
  },
  {
    name: "UN-ANON3 empty-string literal → Empty variant, exact match",
    src: `type K = "" | "x";
const e: K = "";
console.log(e === "", e === "x");`,
    expected: "true false",
  },
  // ── null / undefined composition (reuses 042/091 Option path) ────────────────
  {
    name: "UN-NULL2 `T | undefined` → Option<enum>, None prints undefined",
    src: `type Dir = "north" | "south";
const m: Dir | undefined = undefined;
console.log(m);`,
    expected: "undefined",
  },
  {
    name: "UN-NULL2b Option<enum> holding a value prints via Display",
    src: `type Dir = "north" | "south";
const m: Dir | undefined = "north";
console.log(m);`,
    expected: "north",
  },
  // ── 1d: named-interface discriminated unions (D) → newtype-variant enums ──────
  {
    name: "UN-NAMED1 named-interface members via switch → newtype variants",
    src: `interface Circle { kind: "circle"; r: number }
interface Square { kind: "square"; s: number }
type Shape = Circle | Square;
function area(sh: Shape): number {
  switch (sh.kind) {
    case "circle": return sh.r * sh.r;
    case "square": return sh.s * sh.s;
  }
}
console.log(area({ kind: "circle", r: 2 }), area({ kind: "square", s: 3 }));`,
    expected: "4 9",
    extra: ({ rust }) => expect(rust).toContain("Circle(Circle)"),
  },
  {
    name: "UN-NAMED2 String field read out of a newtype variant",
    src: `interface Ok { kind: "ok"; msg: string }
interface Err { kind: "err"; code: number }
type R = Ok | Err;
function show(r: R): string {
  switch (r.kind) {
    case "ok": return r.msg;
    case "err": return "e";
  }
}
console.log(show({ kind: "ok", msg: "hi" }), show({ kind: "err", code: 1 }));`,
    expected: "hi e",
  },
  {
    name: "UN-NAMED3 construct from a named value + if/else-if ladder",
    src: `interface Circle { kind: "circle"; r: number }
interface Square { kind: "square"; s: number }
type Shape = Circle | Square;
const c: Circle = { kind: "circle", r: 5 };
const sh: Shape = c;
function area(x: Shape): number {
  if (x.kind === "circle") return x.r * x.r;
  else return x.s * x.s;
}
console.log(area(sh));`,
    expected: "25",
  },
  {
    name: "UN-NAMED4 inline (anonymous) named-interface union in a parameter",
    src: `interface At { kind: "at"; p: number }
interface Origin { kind: "origin" }
function nx(n: At | Origin): number {
  switch (n.kind) {
    case "at": return n.p;
    case "origin": return 0;
  }
}
console.log(nx({ kind: "at", p: 7 }), nx({ kind: "origin" }));`,
    expected: "7 0",
    extra: ({ rust }) => expect(rust).toContain("__anonymous_union_"),
  },
  // ── 1d: primitive / mixed-type unions (F) → newtype variants via `typeof` ─────
  {
    name: "UN-PRIM1 string|number if-ladder narrows via typeof",
    src: `type SN = string | number;
function describe(x: SN): string {
  if (typeof x === "string") return x;
  else return "n" + x;
}
console.log(describe("hello"), describe(2));`,
    expected: "hello n2",
    extra: ({ rust }) => {
      expect(rust).toContain("Str(String)");
      expect(rust).toContain("Num(f64)");
    },
  },
  {
    name: "UN-PRIM2 switch(typeof x) over string|number",
    src: `type SN = string | number;
function kind(x: SN): string {
  switch (typeof x) {
    case "string": return "STR";
    case "number": return "NUM";
  }
}
console.log(kind("a"), kind(1));`,
    expected: "STR NUM",
  },
  {
    name: "UN-PRIM3 three-way string|number|boolean",
    src: `type V = string | number | boolean;
function t(x: V): string {
  if (typeof x === "string") return "s";
  else if (typeof x === "number") return "n";
  else return "b";
}
console.log(t("x"), t(3), t(true));`,
    expected: "s n b",
  },
  {
    name: "UN-PRIM4 mixed string|Point narrows the object arm via typeof",
    src: `interface Point { x: number; y: number; }
type SP = string | Point;
function show(v: SP): string {
  if (typeof v === "string") return v;
  else return "" + v.x;
}
const p: Point = { x: 7, y: 2 };
console.log(show("hi"), show(p));`,
    expected: "hi 7",
  },
  {
    name: "UN-PRIM5 construct from identifiers into a Vec<union>",
    src: `type SN = string | number;
const a: string = "hello";
const b: number = 42;
const xs: SN[] = [a, b];
function pr(x: SN): string {
  if (typeof x === "string") return x;
  else return "" + x;
}
console.log(pr(xs[0]), pr(xs[1]));`,
    expected: "hello 42",
  },
  // ── 1e: non-discriminated object unions (E) → struct variants via `in` ────────
  {
    name: "UN-NONDISC1 {a}|{b} narrows via `in`",
    src: `type AB = { a: number } | { b: string };
function show(x: AB): string {
  if ("a" in x) return "" + x.a;
  else return x.b;
}
console.log(show({ a: 1 }), show({ b: "hi" }));`,
    expected: "1 hi",
    extra: ({ rust }) => expect(rust).toContain("enum"),
  },
  {
    name: "UN-NONDISC2 multi-field variant names (sorted field set)",
    src: `type Rec = { name: string; age: number } | { k: string; v: string };
function get(r: Rec): string {
  if ("age" in r) return "" + r.age;
  else return r.k + r.v;
}
console.log(get({ name: "x", age: 9 }), get({ k: "k", v: "b" }));`,
    expected: "9 kb",
  },
  {
    name: "UN-NONDISC3 three-way `in`-ladder",
    src: `type T = { a: number } | { b: number } | { c: number };
function pick(x: T): number {
  if ("a" in x) return x.a;
  else if ("b" in x) return x.b;
  else return x.c;
}
console.log(pick({ a: 1 }), pick({ b: 2 }), pick({ c: 3 }));`,
    expected: "1 2 3",
  },
]);

// ── Fail-loud residual boundary (design §9) ───────────────────────────────────
test("UN-FL1 recursive union (self-referential field) stays fail-loud → #59", () => {
  // A variant field referencing the union itself needs #59's boxed recursive-value
  // model; series 118 (#82) tailors the message to point there (was a bare throw).
  const src = `type Tree = { kind: "leaf"; v: number } | { kind: "node"; child: Tree };
const t: Tree = { kind: "leaf", v: 1 };
console.log("ok");`;
  expect(() => compile(src)).toThrow(/recursive[\s\S]*#59/);
});

test("UN-FL5 non-union non-trivial type alias (tuple) stays fail-loud", () => {
  const src = `type Pair = [number, number];
const p: Pair = [1, 2];
console.log(p[0]);`;
  expect(() => compile(src)).toThrow();
});

test("UN-FL6 mixed literal + object union (G) is now supported (graduated by #82)", () => {
  // Series 118 (#82) graduated G to a single-level mixed enum (unit variants for the
  // literals + struct variants for the discriminated objects). Differentials live in
  // `union-residuals.test.ts` (UNR-MIX*); this only pins that it no longer throws.
  const src = `type S = "loading" | { kind: "done"; data: number };
const s: S = "loading";
console.log("ok");`;
  expect(() => compile(src)).not.toThrow();
});
