/**
 * Specs for series 074 — struct `Map`/`Set` keys with `f64` fields. Graduates the
 * 061 struct-key `f64`-field residual (issue #30): a struct used as a key that
 * carries a (direct) `f64` field routes to a synthesized SameValueZero **key
 * newtype** `<Struct>Key(<Struct>)` with custom `Hash`/`PartialEq`/`Eq` that wrap
 * each `f64` leaf in `OrderedFloat` at hash/eq time. The user struct keeps its raw
 * `f64` fields (arithmetic untouched) and its `===`-faithful derived `PartialEq`
 * (NaN≠NaN); the newtype is the collection's key (NaN=NaN, `-0`/`+0` collapse).
 *
 * Two oracles. JS `Map`/`Set` key on *object identity*, so a differential vs. Bun
 * only holds when the TS program reuses the *same* key binding — those specs use
 * `behaves`. The structural SameValueZero win (distinct-but-equal keys dedupe,
 * `NaN` keys collide, `-0`/`+0` collapse) is the documented divergence from JS
 * object-identity keying — pinned directly on the Rust run via `rustBehaves`.
 * IDs map to series 074.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { runRust } from "../src/harness";
import { lower } from "../src/lower";
import { compile, defineDifferential } from "./_support/differential";

/** Rust-only: the structural SameValueZero divergence from JS object-identity keying. */
async function rustBehaves(src: string, expected: string): Promise<void> {
  const rr = await runRust(compile(src));
  expect(rr.ok).toBe(true);
  expect(rr.stdout.trim()).toBe(expected);
}

function rejects(src: string, re: RegExp): void {
  expect(() =>
    lower(parseSync("t.ts", src).program as unknown as Program),
  ).toThrow(re);
}

defineDifferential("struct-f64-keys", [
  {
    name: "F64K1 `Map<Point, V>` set/get/has/delete/size (shared ref, differential)",
    src: `interface Point { x: number; y: number; }
const m: Map<Point, string> = new Map<Point, string>();
const a: Point = { x: 1.5, y: 2.5 };
m.set(a, "origin");
console.log(m.size);
console.log(m.has(a));
console.log((m.get(a) ?? "?"));
m.delete(a);
console.log(m.size, m.has(a));`,
    expected: "1\ntrue\norigin\n0 false",
    extra: ({ rust }) => {
      expect(rust).toContain("struct PointKey(Point);");
      expect(rust).toContain("IndexMap::<PointKey, String>::new()");
      expect(rust).toContain("m.insert(PointKey(a"); // moved or cloned by ownership
      expect(rust).toContain("&PointKey(a.clone())"); // lookup clones into the temp
    },
  },
  {
    name: "F64K5 arithmetic on the raw f64 field is untouched (differential)",
    src: `interface Point { x: number; y: number; }
const m: Map<Point, number> = new Map<Point, number>();
const a: Point = { x: 3.0, y: 4.0 };
m.set(a, 10);
console.log(a.x * 2, a.y + 1);
console.log((m.get(a) ?? -1));`,
    expected: "6 5\n10",
    // The field stays raw f64 — no OrderedFloat unwrap at the arithmetic site.
    extra: ({ rust }) => expect(rust).toContain("a.x * 2.0"),
  },
  {
    name: "F64K7 `Map<Point,V>` iteration unwraps the key newtype (differential)",
    src: `interface Point { x: number; y: number; }
const m: Map<Point, string> = new Map<Point, string>();
const a: Point = { x: 1.5, y: 2.5 };
const b: Point = { x: 9.0, y: 8.0 };
m.set(a, "a");
m.set(b, "b");
for (const [k, v] of m) { console.log(k.x, k.y, v); }`,
    expected: "1.5 2.5 a\n9 8 b",
    extra: ({ rust }) => expect(rust).toContain("for (PointKey(k), v) in m.iter()"),
  },
  {
    name: "F64K8 `Set<Point>` iteration unwraps the newtype element (differential)",
    src: `interface Point { x: number; y: number; }
const s: Set<Point> = new Set<Point>();
const a: Point = { x: 1.5, y: 2.5 };
s.add(a);
for (const p of s) { console.log(p.x, p.y); }`,
    expected: "1.5 2.5",
    extra: ({ rust }) => expect(rust).toContain("for PointKey(p) in s.iter()"),
  },
]);

describe("074 struct Map/Set keys with f64 fields", () => {
  test("F64K2 the synthesized newtype carries custom SameValueZero impls", () => {
    const rust = compile(
      `interface Point { x: number; y: number; }
const m: Map<Point, number> = new Map<Point, number>();`,
    );
    expect(rust).toContain("use ordered_float::OrderedFloat;");
    expect(rust).toContain("impl PartialEq for PointKey {");
    expect(rust).toContain("OrderedFloat(self.0.x) == OrderedFloat(o.0.x)");
    expect(rust).toContain("impl Eq for PointKey {}");
    expect(rust).toContain("impl std::hash::Hash for PointKey {");
    expect(rust).toContain("OrderedFloat(self.0.x).hash(s);");
    // The user struct is unchanged: raw f64 fields, derived (NaN≠NaN) PartialEq.
    expect(rust).toContain("#[derive(Clone, Debug, PartialEq)]\nstruct Point");
  });

  test("F64K3 distinct-but-structurally-equal keys dedupe (SameValueZero, Rust-only)", async () => {
    const src = `interface Point { x: number; y: number; }
const s: Set<Point> = new Set<Point>();
const a: Point = { x: 1.5, y: 2.5 };
const b: Point = { x: 1.5, y: 2.5 };
s.add(a);
s.add(b);
console.log(s.size);`;
    // Two distinct objects, structurally equal → one key in Rust (JS keeps two).
    await rustBehaves(src, "1");
  });

  test("F64K4 NaN-field keys collide and -0/+0 collapse (SameValueZero, Rust-only)", async () => {
    const src = `interface Point { x: number; y: number; }
const s: Set<Point> = new Set<Point>();
const nanA: Point = { x: NaN, y: 0 };
const nanB: Point = { x: NaN, y: 0 };
const negZero: Point = { x: 0, y: -0 };
const posZero: Point = { x: 0, y: 0 };
s.add(nanA);
s.add(nanB);
s.add(negZero);
s.add(posZero);
console.log(s.size);`;
    // NaN == NaN (one key) and -0 collapses with +0 (one key) → size 2.
    await rustBehaves(src, "2");
  });

  test("F64K6 `===` on Point stays NaN≠NaN while the key dedupes NaN (both hold)", async () => {
    const src = `interface Point { x: number; y: number; }
const s: Set<Point> = new Set<Point>();
const p: Point = { x: NaN, y: 1 };
const q: Point = { x: NaN, y: 1 };
s.add(p);
s.add(q);
console.log(p === q);
console.log(s.size);`;
    // `p === q` is false (derived NaN≠NaN PartialEq); yet the two keys collide.
    await rustBehaves(src, "false\n1");
    const rust = compile(src);
    expect(rust).toContain("p == q"); // Point's own derived PartialEq
    expect(rust).toContain("struct PointKey(Point);");
  });

  test("F64K9 mixed f64 + non-f64 fields: non-f64 uses plain ==/.hash", async () => {
    const src = `interface Tagged { id: number; score: number; label: string; }
const m: Map<Tagged, number> = new Map<Tagged, number>();`;
    const rust = compile(src);
    // `score`/`id` are f64 leaves (OrderedFloat); `label` is a String (plain).
    expect(rust).toContain("OrderedFloat(self.0.score)");
    expect(rust).toContain("self.0.label == o.0.label");
    expect(rust).toContain("self.0.label.hash(s);");
  });

  test("F64K10 a key struct WITHOUT any f64 keeps the 061 derive path (regression)", () => {
    const src = `interface Key { name: string; }
const m: Map<Key, number> = new Map<Key, number>();`;
    const rust = compile(src);
    // No newtype; the struct itself derives Hash/Eq (061), keyed on `Key`.
    expect(rust).not.toContain("KeyKey");
    expect(rust).toContain("#[derive(Clone, Debug, PartialEq, Eq, Hash)]");
    expect(rust).toContain("IndexMap::<Key, f64>::new()");
  });

  test("F64K11 an f64 nested inside a sub-struct field of a key is fail-loud", () => {
    rejects(
      `interface Inner { v: number; }
interface Outer { inner: Inner; }
const m: Map<Outer, string> = new Map<Outer, string>();`,
      /nested|sub-struct|collection/i,
    );
  });

  test("F64K12 an f64 inside a Vec/Option field of a key is fail-loud (first-slice residual)", () => {
    // A direct scalar `f64` is graduated; an `f64` reached through a collection
    // needs an element-wise OrderedFloat wrap this slice doesn't emit → fail-loud.
    rejects(
      `interface Path { pts: Array<number>; }
const s: Set<Path> = new Set<Path>();`,
      /nested|collection|sub-struct/i,
    );
  });
});
