/**
 * Specs for series 083 slice 2 — the `&str`-key borrow fix. A `string` **param**
 * lowers to `&str`; a Map/Set lookup used to wrap it as `&(&str)` = `&&str`
 * (E0277). The fix drops the outer borrow for an already-`&str` key. Owned /
 * literal / OrderedFloat / structKey keys keep their `&`-wrapped path (regression).
 * IDs map to series 083.
 */

import { expect } from "bun:test";
import { defineDifferential } from "./_support/differential";

defineDifferential("library-methods-key", [
  {
    name: "KEY1 m.get(k) with a string param over Map<string,V> — bare key",
    src: `function lookup(m: Map<string, number>, k: string): number {
  return m.get(k) ?? -1;
}
const m: Map<string, number> = new Map<string, number>();
m.set("a", 1);
console.log(lookup(m, "a"), lookup(m, "z"));`,
    expected: "1 -1",
    extra: ({ rust }) => {
      // Bare `k`, never `&k` (which would be `&&str`).
      expect(rust).toContain(".get(k)");
      expect(rust).not.toContain(".get(&k)");
    },
  },
  {
    name: "KEY2 m.has(k) / m.delete(k) with a string param — bare key",
    src: `function del(m: Map<string, number>, k: string): boolean {
  const had: boolean = m.has(k);
  m.delete(k);
  return had;
}
const m: Map<string, number> = new Map<string, number>();
m.set("a", 1);
console.log(del(m, "a"), m.has("a"));`,
    expected: "true false",
    extra: ({ rust }) => {
      expect(rust).toContain(".contains_key(k)");
      expect(rust).toContain(".shift_remove(k)");
    },
  },
  {
    name: "KEY3 s.has(k) with a string param over Set<string> — bare key",
    src: `function seen(s: Set<string>, k: string): boolean {
  return s.has(k);
}
const s: Set<string> = new Set<string>();
s.add("x");
console.log(seen(s, "x"), seen(s, "y"));`,
    expected: "true false",
    extra: ({ rust }) => expect(rust).toContain(".contains(k)"),
  },
  {
    name: "KEY-REG1 a literal / owned key keeps its &-wrapped path (regression)",
    src: `const m: Map<string, number> = new Map<string, number>();
m.set("a", 1);
console.log(m.has("a"));
const owned: string = "a";
console.log(m.has(owned));`,
    expected: "true\ntrue",
    extra: ({ rust }) => {
      // A string literal and an owned `String` local stay `&`-wrapped.
      expect(rust).toContain('.contains_key(&"a"');
      expect(rust).toContain(".contains_key(&owned)");
    },
  },
]);
