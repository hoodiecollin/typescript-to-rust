/**
 * Specs for series 047c — scalars are untouched by the directive scopes, and the
 * two fail-loud upgrades that replace an opaque cargo `E0369` with a clean
 * dialect signal: a struct whose type is not `PartialEq`-eligible (an fn-pointer
 * field), and an identity/discipline mismatch under `"use rc"`.
 *
 * IDs map to series 047.
 */

import { describe, expect, test } from "bun:test";
import { UnsupportedError } from "../src/errors";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("struct-eq-edge", [
  {
    name: "EQ8 scalars compare with == inside a use rc scope (directives only affect structs)",
    src: `"use rc";
console.log(1 === 1);
console.log("a" === "b");`,
    expected: "true\nfalse",
    extra: ({ rust }) => {
      expect(rust).toContain("==");
    },
  },
]);

describe("047c scalars unchanged + fail-loud upgrades", () => {
  test("EQ9 a struct with a non-PartialEq field compared with === is a clean UnsupportedError", () => {
    const src = `function double(n: number): number { return n * 2; }
interface Handler { fn: (n: number) => number; }
const a: Handler = { fn: double };
const b: Handler = { fn: double };
console.log(a === b);`;
    expect(() => compile(src)).toThrow(UnsupportedError);
  });

  test("EQ10 an identity/discipline mismatch under use rc is a clean UnsupportedError", () => {
    const src = `"use rc";
class C { n: number; constructor(n: number) { this.n = n; } }
const a: C = new C(1);
console.log(a === new C(2));`;
    expect(() => compile(src)).toThrow(UnsupportedError);
  });
});
