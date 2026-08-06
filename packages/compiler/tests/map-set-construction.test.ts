/**
 * Specs for series 072 — non-empty `Map`/`Set` construction (`new Map([...])` /
 * `new Set([...])`), graduating one of the two 061 deferrals (issue #37). Emits
 * `IndexMap::from`/`IndexSet::from` for a literal argument and an
 * `.into_iter().collect()` for an array-typed variable argument, reusing the 061
 * key policy (`String`/integer/`OrderedFloat<f64>`).
 *
 * The other 061 deferral — `this.field`/`localVar.field` collection receivers —
 * was already shipped by series 082's `collectionOf` oracle cut-over (`ORAC1`–
 * `ORAC4` in `type-oracle.test.ts`), so 072 adds no new routing; the FLD spec here
 * is construction-focused (it seeds a class-field map non-empty, then reads it).
 *
 * `compile` threads the source text so the oracle is active (matching 082). Each
 * spec differential-matches (compile → cargo run → TS-via-Bun). IDs map to
 * series 072.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("map-set-construction", [
  {
    name: "MAPC1 `new Map([[k,v],…])` (no type args) → IndexMap::from",
    src: `const m: Map<string, number> = new Map([["a", 1], ["b", 2]]);
console.log(m.size);
console.log(m.get("a") ?? -1, m.get("b") ?? -1, m.get("z") ?? -1);`,
    expected: "2\n1 2 -1",
    extra: ({ rust }) => expect(rust).toContain("IndexMap::<String, f64>::from(["),
  },
  {
    name: "MAPC2 dup-key keeps last value, first position (JS-faithful)",
    src: `const m: Map<number, string> = new Map([[1, "a"], [1, "b"], [2, "c"]]);
console.log(m.size);
console.log(m.get(1) ?? "?", m.get(2) ?? "?");
for (const [k, v] of m) { console.log(k, v); }`,
    expected: "2\nb c\n1 b\n2 c",
  },
  {
    name: "MAPC3 `new Map<number,string>([[1,'one'],[2.5,'half']])` fractional keys",
    src: `const m: Map<number, string> = new Map<number, string>([[1, "one"], [2.5, "half"]]);
console.log(m.get(1) ?? "?", m.get(2.5) ?? "?", m.get(9) ?? "?");
console.log(m.size);`,
    expected: "one half ?\n2",
    extra: ({ rust }) => expect(rust).toContain("OrderedFloat"),
  },
  {
    name: "SETC1 `new Set([1,1,2])` dedupes numerically → IndexSet::from",
    src: `const s: Set<number> = new Set([1, 1, 2]);
console.log(s.size, s.has(1), s.has(9));`,
    expected: "2 true false",
    extra: ({ rust }) => {
      expect(rust).toContain("IndexSet::");
      expect(rust).toContain("::from([");
    },
  },
  {
    name: "SETC2 `new Set(['a','b','a'])` dedupes → IndexSet::<String>::from",
    src: `const s: Set<string> = new Set(["a", "b", "a"]);
console.log(s.size, s.has("a"), s.has("z"));`,
    expected: "2 true false",
    extra: ({ rust }) => expect(rust).toContain("IndexSet::<String>::from(["),
  },
  {
    name: "SETVAR `new Set(items)` where items is a string array variable → collect",
    src: `const items: Array<string> = ["a", "b", "a"];
const s: Set<string> = new Set(items);
console.log(s.size, s.has("a"));`,
    expected: "2 true",
    extra: ({ rust }) => {
      expect(rust).toContain(".into_iter()");
      expect(rust).toContain("collect::<IndexSet<String>>()");
    },
  },
  {
    name: "SETVARN `new Set(items)` where items is a number array → OrderedFloat wrap",
    src: `const items: Array<number> = [1, 1, 2];
const s: Set<number> = new Set(items);
console.log(s.size, s.has(1), s.has(9));`,
    expected: "2 true false",
    extra: ({ rust }) => {
      expect(rust).toContain("OrderedFloat");
      expect(rust).toContain("collect::<IndexSet<OrderedFloat<f64>>>()");
    },
  },
  {
    name: "FLDC1 class-field map seeded non-empty in the constructor",
    src: `class C {
  m: Map<string, number>;
  constructor() { this.m = new Map([["a", 1], ["b", 2]]); }
  total(): number { return (this.m.get("a") ?? 0) + (this.m.get("b") ?? 0); }
  report(): void { console.log(this.m.size); }
}
const c: C = new C();
c.report();
console.log(c.total());`,
    expected: "2\n3",
    extra: ({ rust }) => expect(rust).toContain("IndexMap::<String, f64>::from(["),
  },
]);

test("MAPVAR `new Map(entries)` (tuple-array variable) is fail-loud (unmodeled TSTupleType)", () => {
  // The Map variable path needs `Array<[K,V]>` element typing, but `TSTupleType`
  // is not in the accepted dialect surface (design open detail) — so it stays
  // fail-loud where the Set (`Array<T>`) variable path succeeds. Non-array Map
  // args are fail-loud too (FLC2).
  const src = `const entries: Array<[string, number]> = [["a", 1]];
const m: Map<string, number> = new Map(entries);`;
  expect(() => compile(src)).toThrow();
});

test("FLC1 `new Map([])` with no type args is fail-loud (un-inferable)", () => {
  const src = `const m: Map<string, number> = new Map([]);`;
  expect(() => compile(src)).toThrow();
});

test("FLC2 `new Map(other)` with a non-array (Map) argument is fail-loud", () => {
  const src = `const other: Map<string, number> = new Map<string, number>();
const m: Map<string, number> = new Map(other);`;
  expect(() => compile(src)).toThrow();
});

test("FLC3 empty `new Map<K,V>()` is byte-for-byte unchanged (regression)", () => {
  const src = `const m: Map<string, number> = new Map<string, number>();
m.set("a", 1);
console.log(m.size);`;
  const rust = compile(src);
  expect(rust).toContain("IndexMap::<String, f64>::new()");
  expect(rust).not.toContain("::from([");
});
