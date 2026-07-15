/**
 * Specs for series 047b — under `"use rc"`, struct `===`/`!==` is **identity**
 * (`Rc::ptr_eq`) not structural: an aliased handle is equal, a fresh equal value
 * is not. Because an `rc` binding has a stable heap home, this restores exactly
 * JS identity semantics — so the differential vs. Bun agrees (contrast the 047a
 * structural divergence, where the same field values give the opposite result).
 *
 * IDs map to docs/work/047-struct-equality/specs.md.
 */

import { expect } from "bun:test";
import { defineDifferential } from "./_support/differential";

const C = `class C {
  n: number;
  constructor(n: number) { this.n = n; }
}`;

defineDifferential("struct-eq-rc", [
  {
    name: "EQ6 aliased handle is identity-equal; a fresh equal value is not",
    src: `"use rc";
${C}
const a: C = new C(1);
const b: C = a;
const c: C = new C(1);
console.log(a === b);
console.log(a === c);`,
    expected: "true\nfalse",
    extra: ({ rust }) => expect(rust).toContain("Rc::ptr_eq"),
  },
  {
    name: "EQ7 !== under use rc emits !Rc::ptr_eq and is the complement",
    src: `"use rc";
${C}
const a: C = new C(1);
const b: C = a;
const c: C = new C(1);
console.log(a !== b);
console.log(a !== c);`,
    expected: "false\ntrue",
    extra: ({ rust }) => expect(rust).toContain("!Rc::ptr_eq"),
  },
]);
