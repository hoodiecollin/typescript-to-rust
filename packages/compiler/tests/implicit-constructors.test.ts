/**
 * Specs for series 070 — implicit / non-field-init constructors. Graduates issue
 * #36 / the 060 constructor deferral: a class without an explicit field-initializing
 * constructor now lowers to a valid `struct` + synthesized `new`. Each field's
 * construction value is ctor-assigned → field initializer → `Option<T>`/`None`
 * (via series 066). `protected`, decorators, and honest-value-less fields stay
 * fail-loud.
 *
 * Each behaving spec differential-matches (compile → cargo run == TS-via-Bun ==
 * expected). IDs → docs/work/070-implicit-constructors/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { lower } from "../src/lower";
import { defineDifferential } from "./_support/differential";

function rejects(src: string, re?: RegExp): void {
  expect(() =>
    lower(parseSync("t.ts", src).program as unknown as Program),
  ).toThrow(re);
}

defineDifferential("implicit-constructors", [
  {
    name: "IC1 no constructor, field initializer → synthesized new()",
    src: `class A { x = 5 }
const a: A = new A();
console.log(a.x);`,
    expected: "5",
    extra: ({ rust }) => {
      expect(rust).toContain("fn new() -> A");
      expect(rust).toContain("x: 5.0");
    },
  },
  {
    name: "IC2 no constructor, annotated string field initializer",
    src: `class C { label: string = "hi" }
const c: C = new C();
console.log(c.label);`,
    expected: "hi",
  },
  {
    name: "IC3 empty constructor, no fields",
    src: `class B { constructor() {} }
const b: B = new B();
console.log("ok");`,
    expected: "ok",
    extra: ({ rust }) => {
      expect(rust).toContain("fn new() -> B");
    },
  },
  {
    name: "IC4 partial ctor: uninitialized field falls back to its initializer",
    src: `class P {
  x: number;
  y = 0;
  constructor(x: number) { this.x = x; }
}
const p: P = new P(7);
console.log(p.x, p.y);`,
    expected: "7 0",
  },
  {
    name: "IC5 no ctor assignment, no initializer → Option<T>/None",
    src: `class Q { x: number; }
const q: Q = new Q();
console.log(q.x ?? 7);`,
    expected: "7",
    extra: ({ rust }) => {
      expect(rust).toContain("x: Option<f64>");
      expect(rust).toContain("x: None");
    },
  },
  {
    name: "IC6 partial ctor with an uninitialized non-init field → None",
    src: `class R {
  a: number;
  b: number;
  constructor(a: number) { this.a = a; }
}
const r: R = new R(3);
console.log(r.a, r.b ?? 9);`,
    expected: "3 9",
    extra: ({ rust }) => {
      expect(rust).toContain("b: Option<f64>");
    },
  },
  {
    name: "IC7 several field initializers, no ctor",
    src: `class S { x = 1; y = 2; z = 3 }
const s: S = new S();
console.log(s.x, s.y, s.z);`,
    expected: "1 2 3",
  },
  {
    name: "IC8 initializer for an annotated optional field → Some",
    src: `class T { flag: boolean | undefined = true }
const t: T = new T();
console.log(t.flag ?? false);`,
    expected: "true",
    extra: ({ rust }) => {
      expect(rust).toContain("flag: Option<bool>");
    },
  },
  {
    name: "IC-R4 an unassigned struct-typed field becomes Option<T>/None (design Decision)",
    src: `interface Point { x: number; }
class C { p: Point; }
const c: C = new C();
if (c.p === undefined) { console.log("absent"); } else { console.log("present"); }`,
    expected: "absent",
    extra: ({ rust }) => {
      expect(rust).toContain("p: Option<Point>");
    },
  },
]);

// ── Fail-loud residuals ───────────────────────────────────────────────────
describe("070 implicit constructors — fail-loud residuals", () => {
  test("IC-R1 a protected field in an implicit-ctor class is fail-loud", () => {
    rejects(`class C { protected x = 5 }`, /protected/i);
  });

  test("IC-R2 a class decorator stays fail-loud", () => {
    rejects(`@sealed class C { x = 5 }`);
  });

  test("IC-R3 a this-/cross-field-referencing initializer is fail-loud", () => {
    rejects(`class C { x = 1; y = this.x; }`);
  });
});
