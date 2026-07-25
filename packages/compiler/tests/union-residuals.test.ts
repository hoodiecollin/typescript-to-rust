/**
 * Specs for series 118 — union-type residuals (graduate #82). Design + spec IDs:
 * docs/work/118-union-residuals/{design,specs}.md. Follow-up to series 093 (#63):
 * graduates three deferred residuals to real support — (d) fielded/literal union as
 * a Map/Set key, (f) two named structs with no shared discriminant (`in`-narrowed
 * newtype enum), (c) mixed literal + object union (G) via a single-level mixed
 * `match` — and hardens (e) narrowing on a non-discriminant field (silent → loud).
 * Recursive (a) and generic (b) unions stay fail-loud, re-tailored to epic #59.
 *
 * Differentials (emitted Rust runs; stdout === TS-via-Bun) unless a plain `test()`
 * fail-loud pin. Union narrowing (like 093's) needs the explicit `else` form; a
 * `Map.get` `Option` is printed via `?? default` (a bare `console.log(Option)` is a
 * pre-existing gap, orthogonal to this series).
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("union-residuals", [
  // ── (d) fielded / literal union as a Map key / Set element ──────────────────
  {
    name: "UNR-KEY1 literal union as a Map key → Hash+Eq derives",
    src: `type Dir = "n" | "s";
const m = new Map<Dir, number>();
m.set("n", 1);
m.set("s", 2);
console.log(m.get("n") ?? -1, m.get("s") ?? -1);`,
    expected: "1 2",
    extra: ({ rust }) => expect(rust).toMatch(/#\[derive\([^)]*Hash[^)]*\)\]\s*(pub )?enum Dir/),
  },
  {
    name: "UNR-KEY2 numeric-literal union as a Set element",
    src: `type Bit = 0 | 1;
const s = new Set<Bit>();
s.add(1);
console.log(s.has(1), s.has(0));`,
    expected: "true false",
  },
  {
    // A fielded (object) key: JS Maps key objects by *reference*, Rust IndexMap keys
    // *structurally*. The faithful differential uses the same key value for set + get
    // (reference-equal in JS AND structurally-equal in Rust → both agree).
    name: "UNR-KEY3 fielded discriminated union as a Map key (String field → Hash+Eq)",
    src: `type K = { kind: "a"; name: string } | { kind: "b"; name: string };
const m = new Map<K, number>();
const k: K = { kind: "a", name: "x" };
m.set(k, 1);
console.log(m.get(k) ?? -1);`,
    expected: "1",
  },
  {
    name: "UNR-KEY4 union key dedup via Eq + Hash",
    src: `type Dir = "n" | "s";
const s = new Set<Dir>();
s.add("n");
s.add("n");
console.log(s.size);`,
    expected: "1",
  },

  // ── (f) two named structs, no shared discriminant → in-narrowed newtype enum ──
  {
    name: "UNR-NND1 named-non-disc union: object-literal construction + in-narrow",
    src: `interface Foo { a: number }
interface Bar { b: string }
type FB = Foo | Bar;
function f(x: FB): string {
  if ("a" in x) return "" + x.a;
  else return x.b;
}
console.log(f({ a: 1 }), f({ b: "z" }));`,
    expected: "1 z",
    extra: ({ rust }) => expect(rust).toContain("Foo(Foo)"),
  },
  {
    name: "UNR-NND2 named-non-disc union: construct from a named value",
    src: `interface Foo { a: number }
interface Bar { b: string }
type FB = Foo | Bar;
function one(x: FB): number {
  if ("a" in x) return x.a;
  else return 0;
}
const foo: Foo = { a: 5 };
const x: FB = foo;
console.log(one(x));`,
    expected: "5",
  },
  {
    name: "UNR-NND3 anonymous inline named-non-disc union + trailing-else last variant",
    src: `interface Foo { a: number }
interface Bar { b: string }
function g(x: Foo | Bar): string {
  if ("a" in x) return "" + x.a;
  else return x.b;
}
console.log(g({ a: 1 }), g({ b: "z" }));`,
    expected: "1 z",
    extra: ({ rust }) => expect(rust).toContain("__anonymous_union_"),
  },

  // ── (c) mixed literal + object union (G) → single-level mixed match ──────────
  {
    name: "UNR-MIX1 mixed union: literal-equality rung + object trailing-else",
    src: `type State = "loading" | { kind: "done"; result: number };
function f(s: State): number {
  if (s === "loading") return -1;
  else return s.result;
}
console.log(f("loading"), f({ kind: "done", result: 7 }));`,
    expected: "-1 7",
    extra: ({ rust }) => expect(rust).toContain("enum State"),
  },
  {
    name: "UNR-MIX2 mixed union: multiple literal rungs + object trailing-else",
    src: `type S2 = "a" | "b" | { kind: "n"; v: number };
function f(s: S2): number {
  if (s === "a") return 1;
  else if (s === "b") return 2;
  else return s.v;
}
console.log(f("a"), f("b"), f({ kind: "n", v: 5 }));`,
    expected: "1 2 5",
  },
  {
    name: "UNR-MIX3 mixed union: value-eq beside field-eq rungs → one flat match",
    src: `type S3 = "idle" | { kind: "run"; pid: number } | { kind: "stop"; code: number };
function f(s: S3): number {
  if (s === "idle") return 0;
  else if (s.kind === "run") return s.pid;
  else return s.code;
}
console.log(f("idle"), f({ kind: "run", pid: 4 }), f({ kind: "stop", code: 9 }));`,
    expected: "0 4 9",
  },
  {
    name: "UNR-MIX4 anonymous inline mixed union",
    src: `function h(s: "on" | { kind: "dim"; level: number }): number {
  if (s === "on") return 100;
  else return s.level;
}
console.log(h("on"), h({ kind: "dim", level: 3 }));`,
    expected: "100 3",
    extra: ({ rust }) => expect(rust).toContain("__anonymous_union_"),
  },
  {
    name: "UNR-MIX5 mixed union stored heterogeneously in a Vec",
    src: `type State = "loading" | { kind: "done"; result: number };
function score(s: State): number {
  if (s === "loading") return -1;
  else return s.result;
}
const arr: State[] = ["loading", { kind: "done", result: 2 }];
let total = 0;
for (const item of arr) total += score(item);
console.log(total);`,
    expected: "1",
  },

  // ── null / undefined composition (reuses 042) ───────────────────────────────
  {
    name: "UNR-NULL1 mixed union | undefined → Option<enum>, narrow None then delegate",
    src: `type State = "loading" | { kind: "done"; result: number };
function label(st: State): number {
  if (st === "loading") return -1;
  else return st.result;
}
function f(opt: State | undefined): number {
  if (opt === undefined) return -2;
  else return label(opt);
}
const l: State = "loading";
const d: State = { kind: "done", result: 4 };
console.log(f(undefined), f(l), f(d));`,
    expected: "-2 -1 4",
  },
]);

// ── Fail-loud residual boundary ───────────────────────────────────────────────

// (e) narrowing a discriminated union on a NON-discriminant field → transpiler-loud
// (was a silent mis-lowering: discriminatedScrutinee returned null and fell back).
test("UNR-NDN-FL1 non-discriminant narrow → loud 'narrow on the discriminant'", () => {
  const src = `type Shape = { kind: "circle"; r: number } | { kind: "square"; s: number };
function f(sh: Shape): number {
  if (sh.r === 2) return 1;
  return 0;
}
console.log(f({ kind: "circle", r: 2 }));`;
  expect(() => compile(src)).toThrow(/narrow on the discriminant 'kind'/);
});

// (a) recursive / self-referential union → retained loud, tailored to #59.
test("UNR-REC-FL1 recursive union stays loud, message points at #59", () => {
  const src = `type Tree = { kind: "leaf"; v: number } | { kind: "node"; child: Tree };
const t: Tree = { kind: "leaf", v: 1 };
console.log("ok");`;
  expect(() => compile(src)).toThrow(/recursive[\s\S]*#59/);
});

// (b) generic union (type-params × unions) → retained loud, tailored to #59.
test("UNR-GEN-FL1 generic union stays loud, message points at #59", () => {
  const src = `type Wrap<T> = { some: T } | { none: true };
const w: Wrap<number> = { some: 1 };
console.log("ok");`;
  expect(() => compile(src)).toThrow(/generic union[\s\S]*#59/);
});

// (d) fielded union with an f64 payload as a key → loud, union-tailored message.
test("UNR-KEY-FL1 fielded union with an f64 payload as a Map key → loud", () => {
  const src = `type P = { kind: "a"; n: number } | { kind: "b"; n: number };
const m = new Map<P, number>();
m.set({ kind: "a", n: 1 }, 10);
console.log("ok");`;
  expect(() => compile(src)).toThrow(/union '.*' used as a Map key/);
});

// (f) two named structs sharing every field → no distinguishing field, ambiguous
// `in`-narrow → unregistered → fail-loud (boundary characterization).
test("UNR-NND-FL1 named union with no distinguishing field stays fail-loud", () => {
  const src = `interface P { x: number }
interface Q { x: number }
type PQ = P | Q;
const v: PQ = { x: 1 };
console.log("ok");`;
  expect(() => compile(src)).toThrow();
});

// (c) mixed union whose object part has no shared discriminant → narrowed message.
test("UNR-MIX-FL1 mixed union, object part with no discriminant → loud", () => {
  const src = `type Bad = "x" | { a: number };
const b: Bad = "x";
console.log("ok");`;
  expect(() => compile(src)).toThrow(/object part has no shared discriminant/);
});
