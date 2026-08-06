/**
 * Specs for series 061 — HashMap operations & `Map`/`Set` classes. Graduates the
 * fail-loud deferral in issue #21: the `Map<K,V>` and `Set<T>` classes (backed by
 * `IndexMap`/`IndexSet` for JS insertion-order fidelity), the record query ops
 * (`k in obj`, `delete obj[k]`, variable-key `Option` reads), scalar-`f64` keys via
 * `OrderedFloat` (faithful to JS SameValueZero), and gated struct keys.
 *
 * Each spec differential-matches (compile → cargo run → TS-via-Bun) and pins the
 * refined emitted shape. IDs map to series 061.
 */

import { describe, expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("map-set", [
  {
    name: "MAP1 `Map<string, number>` set/get/has/delete/size",
    src: `const m: Map<string, number> = new Map<string, number>();
m.set("a", 1);
m.set("b", 2);
console.log(m.size);
console.log(m.has("a"), m.has("z"));
console.log((m.get("a") ?? -1), (m.get("z") ?? -1));
m.delete("a");
console.log(m.size, m.has("a"));`,
    expected: "2\ntrue false\n1 -1\n1 false",
    extra: ({ rust }) => {
      expect(rust).toContain("IndexMap::<String, f64>::new()");
      expect(rust).toContain('.insert("a".to_string(), 1.0)');
      expect(rust).toContain(".contains_key(");
      expect(rust).toContain(".cloned()");
      expect(rust).toContain(".shift_remove(");
    },
  },
  {
    name: "MAP2 `Map` iteration preserves JS insertion order",
    src: `const m: Map<string, number> = new Map<string, number>();
m.set("z", 1);
m.set("a", 2);
m.set("m", 3);
for (const [k, v] of m) { console.log(k, v); }`,
    expected: "z 1\na 2\nm 3",
  },
  {
    name: "MAP3 `Map<number, V>` integer + fractional keys (OrderedFloat)",
    src: `const m: Map<number, string> = new Map<number, string>();
m.set(1, "one");
m.set(2.5, "two-and-half");
console.log((m.get(1) ?? "?"), (m.get(2.5) ?? "?"), (m.get(9) ?? "?"));
console.log(m.size);`,
    expected: "one two-and-half ?\n2",
    extra: ({ rust }) => {
      expect(rust).toContain("OrderedFloat");
    },
  },
  {
    name: "SET1 `Set<string>` add/has/delete/size/iter",
    src: `const s: Set<string> = new Set<string>();
s.add("a");
s.add("b");
s.add("a");
console.log(s.size, s.has("a"), s.has("z"));
for (const x of s) { console.log(x); }
s.delete("a");
console.log(s.size, s.has("a"));`,
    expected: "2 true false\na\nb\n1 false",
    extra: ({ rust }) => {
      expect(rust).toContain("IndexSet::<String>::new()");
      expect(rust).toContain(".contains(");
    },
  },
  {
    name: "SET2 `Set<number>` collapses -0/+0 and dedupes NaN (SameValueZero)",
    src: `const s: Set<number> = new Set<number>();
s.add(0);
s.add(-0);
s.add(NaN);
s.add(NaN);
console.log(s.size);`,
    expected: "2",
    extra: ({ rust }) => {
      expect(rust).toContain("IndexSet::<OrderedFloat<f64>>::new()");
    },
  },
  {
    name: "REC1 `k in obj` → `contains_key`",
    src: `const obj: Record<string, number> = { a: 1, b: 2 };
const k: string = "a";
console.log((k in obj), ("z" in obj));`,
    expected: "true false",
    extra: ({ rust }) => {
      expect(rust).toContain(".contains_key(");
    },
  },
  {
    name: "REC2 `delete obj[k]` → `shift_remove`",
    src: `const obj: Record<string, number> = { a: 1, b: 2 };
delete obj["a"];
console.log(("a" in obj), ("b" in obj));`,
    expected: "false true",
    extra: ({ rust }) => {
      expect(rust).toContain(".shift_remove(");
    },
  },
  {
    name: "REC3 variable-key read → `Option`",
    src: `const obj: Record<string, number> = { a: 1 };
const k: string = "a";
const miss: string = "z";
console.log((obj[k] ?? -1), (obj[miss] ?? -1));`,
    expected: "1 -1",
    extra: ({ rust }) => {
      expect(rust).toContain(".get(");
      expect(rust).toContain(".cloned()");
    },
  },
]);

describe("061 Map / Set / record query ops", () => {
  test("FL1 a struct key with a direct `f64` field is now graduated (series 074)", () => {
    // Was fail-loud in 061 (its own issue #30); series 074 synthesizes a
    // SameValueZero key newtype instead. A struct key with an `f64` nested inside a
    // *sub-struct* field stays fail-loud (074's interim residual, see F64K11).
    const src = `interface P { x: number; y: number; }
const m: Map<P, string> = new Map<P, string>();`;
    const rust = compile(src);
    expect(rust).toContain("struct PKey(P);");
    expect(rust).toContain("IndexMap::<PKey, String>::new()");
  });
});
