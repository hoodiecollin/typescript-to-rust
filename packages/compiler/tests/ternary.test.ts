/**
 * Specs for series 094 — ternary `cond ? a : b` → Rust `if`/`else` **expression**.
 * Design + spec IDs: docs/work/094-ternary/{design,specs}.md. Differentials
 * (emitted Rust runs; stdout === TS-via-Bun) unless a plain `test()` fail-loud pin.
 *
 * Covers: homogeneous arms (typed + untyped), nested/chained, bare-statement,
 * arithmetic-operand parenthesization, truthy (non-bool) test; typed-context
 * coercion (Option, declared named union); heterogeneous → auto-synthesized
 * printable primitive union; and the non-primitive-untyped fail-loud residual.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("ternary", [
  // ── homogeneous (the common case) ──────────────────────────────────────────
  {
    name: "TERN1 typed number arms → if/else expression",
    src: `const big: boolean = true;
const n: number = big ? 100 : 0;
console.log(n);`,
    expected: "100",
    extra: ({ rust }) => {
      expect(rust).toContain("if ");
      expect(rust).toContain("else");
    },
  },
  {
    name: "TERN2 typed string arms round-trip",
    src: `const ok: boolean = false;
const s: string = ok ? "yes" : "no";
console.log(s);`,
    expected: "no",
  },
  {
    name: "TERN3 untyped position, homogeneous number locals",
    src: `const c: boolean = true;
const x: number = 7;
const y: number = 9;
console.log(c ? x : y);`,
    expected: "7",
  },
  {
    name: "TERN4 nested/chained ternary picks the right arm",
    src: `const a: boolean = false;
const b: boolean = true;
const n: number = a ? 1 : b ? 2 : 3;
console.log(n);`,
    expected: "2",
  },
  {
    name: "TERN5 bare-statement ternary runs the taken side",
    src: `function lo(): void { console.log("lo"); }
function hi(): void { console.log("hi"); }
const big: boolean = true;
big ? hi() : lo();`,
    expected: "hi",
  },
  {
    name: "TERN6 ternary as an arithmetic operand (parenthesized emission)",
    src: `const c: boolean = true;
const n: number = 1 + (c ? 2 : 3);
console.log(n);`,
    expected: "3",
  },
  {
    name: "TERN7 truthy (non-bool) test routes through is_truthy",
    src: `const n: number = 0;
const s: string = n ? "a" : "b";
console.log(s);`,
    expected: "b",
  },

  // ── typed context: coercion through lowerTyped ─────────────────────────────
  {
    name: "TERN8 Option target: present arm Some-wrapped, undefined → None",
    src: `const c: boolean = true;
const x: number | undefined = c ? 5 : undefined;
console.log(x ?? -1);`,
    expected: "5",
  },
  {
    name: "TERN9 declared union target: literal arms coerce to variants",
    src: `type Dir = "north" | "south";
const goNorth: boolean = true;
const d: Dir = goNorth ? "north" : "south";
console.log(d);`,
    expected: "north",
    extra: ({ rust }) => expect(rust).toContain("Dir::North"),
  },
  {
    name: "TERN10 typed-return ternary",
    src: `function pick(b: boolean): number { return b ? 1 : 2; }
console.log(pick(false));`,
    expected: "2",
  },

  // ── heterogeneous → auto-synthesized printable primitive union (§4) ─────────
  {
    name: "TERN11 heterogeneous untyped arms synthesize a printable union",
    src: `const c: boolean = true;
console.log(c ? 1 : "a");`,
    expected: "1",
    extra: ({ rust }) => expect(rust).toContain("__anonymous_union_"),
  },
  {
    name: "TERN12 declared string|number union target coerces arms (no synthesis)",
    src: `const c: boolean = false;
const x: string | number = c ? 1 : "a";
console.log(x);`,
    expected: "a",
  },
]);

test("TERN-FL1 heterogeneous untyped ternary with a non-primitive arm is fail-loud", () => {
  const src = `interface Point { x: number; }
const c: boolean = true;
const p: Point = { x: 1 };
console.log(c ? p : "a");`;
  expect(() => compile(src)).toThrow(/heterogeneous ternary .* non-primitive arm/);
});
