/**
 * Specs for series 083 slice 1/3 — the unified `receiverTypeOf` backbone. Proves
 * `.toString()` end-to-end for `this.field` / `getX()` / identifier / `local.field`
 * receivers (RT*), zero-regression on existing collection/string receivers
 * (RT-REG*), and fail-loud on unmodeled receiver shapes (RT-FL*). IDs map to
 * docs/work/083-library-methods-oracle/specs.md.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("receiver-oracle", [
  {
    name: "RT1 this.count.toString() (an f64 field)",
    src: `class C {
  count: number;
  constructor(count: number) { this.count = count; }
  show(): string { return this.count.toString(); }
}
const c: C = new C(3);
console.log(c.show());`,
    expected: "3",
    extra: ({ rust }) => expect(rust).toContain("tslib::number::to_js_string(self.count)"),
  },
  {
    name: "RT2 getName().toUpperCase() — inferred return via the oracle tier",
    src: `function getName(): string { return "abc"; }
console.log(getName().toUpperCase());`,
    expected: "ABC",
    extra: ({ rust }) => expect(rust).toContain(".to_uppercase()"),
  },
  {
    name: "RT3 local.field string method (p.name.toUpperCase())",
    src: `interface Person { name: string; }
const p: Person = { name: "ada" };
console.log(p.name.toUpperCase());`,
    expected: "ADA",
    extra: ({ rust }) => expect(rust).toContain(".to_uppercase()"),
  },
  {
    name: "RT4 identifier string method (s.toUpperCase())",
    src: `const s: string = "hi";
console.log(s.toUpperCase());`,
    expected: "HI",
  },
  {
    name: "RT-REG1 identifier Map receiver lowers unchanged",
    src: `const m: Map<string, number> = new Map<string, number>();
m.set("a", 1);
console.log(m.has("a"), m.get("a") ?? -1);`,
    expected: "true 1",
    extra: ({ rust }) => {
      expect(rust).toContain(".contains_key(");
      expect(rust).toContain(".cloned()");
    },
  },
  {
    name: "RT-REG2 string .length → char count (098); array .length stays .len()",
    src: `const s: string = "abcd";
const xs: Array<number> = [1, 2, 3];
console.log(s.length, xs.length);`,
    expected: "4 3",
    extra: ({ rust }) => {
      expect(rust).toContain("s.chars().count()");
      expect(rust).toContain("xs.len()");
    },
  },
]);

test("RT-FL1 a method on an unmodeled (boolean) receiver stays fail-loud", () => {
  // `b.valueOf()` on a boolean is not a modeled primitive method → no primitive
  // route claimed → generic method fallthrough emits `b.valueOf()`, which is
  // not valid Rust. The point: `tryPrimitiveMethod` returns null (does NOT
  // hijack it into a wrong String/f64 route) — fail-loud posture preserved.
  const src = `const b: boolean = true;
console.log(b.valueOf());`;
  const rust = compile(src);
  // Emitted as a raw generic method (invalid Rust) — never rerouted.
  expect(rust).toContain(".valueOf()");
  expect(rust).not.toContain("to_uppercase");
  expect(rust).not.toContain("to_js_string");
});
