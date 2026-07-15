/**
 * Specs for series 059 — struct / interface deferrals.
 *
 * `interface B extends A` is trait-based (a getter trait `IA`, `impl IA` for each
 * struct, base-typed params as `&impl IA`) so a `B` passes where an `A` is
 * expected. `readonly` fields reject assignment (`DialectError`). Object-literal
 * arguments lower against the callee's struct param type. Local struct field
 * mutation marks the binding `mut`.
 */

import { expect, test } from "bun:test";
import { DialectError } from "../src/lower";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("struct-interface-deferrals", [
  {
    name: "interface extends → trait-based polymorphism (pass a B where A expected)",
    src: `interface A { x: number; }
interface B extends A { y: number; }
function useA(a: A): number { return a.x; }
const b: B = { x: 3, y: 4 };
console.log(useA(b));`,
    expected: "3",
    extra: ({ rust }) => {
      expect(rust).toContain("trait IA");
      expect(rust).toContain("impl IA for B");
      expect(rust).toContain("fn useA(a: &impl IA)");
    },
  },
  {
    name: "multi-level extends flattens base fields through the chain",
    src: `interface A { x: number; }
interface B extends A { y: number; }
interface C extends B { z: number; }
function sum(a: A, b: B): number { return a.x + b.x + b.y; }
const c: C = { x: 1, y: 2, z: 3 };
console.log(sum(c, c));`,
    expected: "4",
  },
  {
    name: "readonly field construction is allowed",
    src: `interface P { readonly id: number; name: string; }
const p: P = { id: 7, name: "a" };
console.log(p.id);`,
    expected: "7",
  },
  {
    name: "object-literal argument lowers against the callee's struct param type",
    src: `interface Point { x: number; y: number; }
function dist(p: Point): number { return p.x * p.x + p.y * p.y; }
console.log(dist({ x: 3, y: 4 }));`,
    expected: "25",
    extra: ({ rust }) => expect(rust).toContain("Point { x: 3.0, y: 4.0 }"),
  },
  {
    name: "local struct field mutation → `let mut`",
    src: `interface Point { x: number; y: number; }
const p: Point = { x: 1, y: 2 };
p.x = 9;
console.log(p.x);`,
    expected: "9",
    extra: ({ rust }) => expect(rust).toContain("let mut p"),
  },
]);

test("a concretely-typed binding reads its field directly (not a getter)", () => {
  const rust = compile(`interface A { x: number; }
const a: A = { x: 10 };
console.log(a.x);`);
  // `a` is a concrete `A`, so the read is a plain field access, no getter call.
  expect(rust).toContain("a.x");
  expect(rust).not.toContain("a.x()");
});

test("readonly field assignment → DialectError", () => {
  expect(() =>
    compile(`interface P { readonly id: number; name: string; }
const p: P = { id: 1, name: "a" };
p.id = 5;`),
  ).toThrow(DialectError);
});
