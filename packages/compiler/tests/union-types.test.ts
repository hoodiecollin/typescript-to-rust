/**
 * Specs for series 093 — union types → Rust `enum`. Design + spec IDs:
 * docs/work/093-union-types/{design,specs}.md. Differentials (emitted Rust runs;
 * stdout === TS-via-Bun) unless a plain `test()` fail-loud pin.
 *
 * Grows stage-by-stage (design §10): a spec is added only once its stage compiles,
 * because a `compile()` throw in the shared `beforeAll` crashes the whole file.
 * Currently populated: **1a** (literal unions A/B) + fail-loud residual pins.
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
]);

// ── Fail-loud residual boundary (design §9) ───────────────────────────────────
test("UN-FL1 recursive union (self-referential field) stays fail-loud → follow-up", () => {
  // A variant field referencing the union itself isn't registered when its fields
  // lower, so it fails loud (a follow-up adds pre-registration + `Box`, design §9).
  const src = `type Tree = { kind: "leaf"; v: number } | { kind: "node"; child: Tree };
const t: Tree = { kind: "leaf", v: 1 };
console.log("ok");`;
  expect(() => compile(src)).toThrow();
});

test("UN-FL5 non-union non-trivial type alias (tuple) stays fail-loud", () => {
  const src = `type Pair = [number, number];
const p: Pair = [1, 2];
console.log(p[0]);`;
  expect(() => compile(src)).toThrow();
});
