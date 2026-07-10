/**
 * Specs for series 059 — struct / interface deferrals.
 *
 * `interface B extends A` is trait-based (a getter trait `IA`, `impl IA` for each
 * struct, base-typed params as `&impl IA`) so a `B` passes where an `A` is
 * expected. `readonly` fields reject assignment (`DialectError`). Object-literal
 * arguments lower against the callee's struct param type. Local struct field
 * mutation marks the binding `mut`.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { runRust } from "../src/harness";
import { DialectError } from "../src/lower";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

function runTs(src: string): string {
  const proc = Bun.spawnSync(["bun", "run", "-"], {
    stdin: new TextEncoder().encode(src),
  });
  return new TextDecoder().decode(proc.stdout).trim();
}

async function behaves(src: string, expected: string): Promise<void> {
  const rust = compile(src);
  const rr = await runRust(rust);
  expect(rr.ok).toBe(true);
  expect(rr.stdout.trim()).toBe(runTs(src));
  expect(rr.stdout.trim()).toBe(expected);
}

describe("059 struct / interface deferrals", () => {
  test("interface extends → trait-based polymorphism (pass a B where A expected)", async () => {
    const src = `interface A { x: number; }
interface B extends A { y: number; }
function useA(a: A): number { return a.x; }
const b: B = { x: 3, y: 4 };
console.log(useA(b));`;
    await behaves(src, "3");
    const rust = compile(src);
    expect(rust).toContain("trait IA");
    expect(rust).toContain("impl IA for B");
    expect(rust).toContain("fn useA(a: &impl IA)");
  });

  test("multi-level extends flattens base fields through the chain", async () => {
    await behaves(
      `interface A { x: number; }
interface B extends A { y: number; }
interface C extends B { z: number; }
function sum(a: A, b: B): number { return a.x + b.x + b.y; }
const c: C = { x: 1, y: 2, z: 3 };
console.log(sum(c, c));`,
      "4",
    );
  });

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

  test("readonly field construction is allowed", async () => {
    await behaves(
      `interface P { readonly id: number; name: string; }
const p: P = { id: 7, name: "a" };
console.log(p.id);`,
      "7",
    );
  });

  test("object-literal argument lowers against the callee's struct param type", async () => {
    const src = `interface Point { x: number; y: number; }
function dist(p: Point): number { return p.x * p.x + p.y * p.y; }
console.log(dist({ x: 3, y: 4 }));`;
    await behaves(src, "25");
    expect(compile(src)).toContain("Point { x: 3.0, y: 4.0 }");
  });

  test("local struct field mutation → `let mut`", async () => {
    const src = `interface Point { x: number; y: number; }
const p: Point = { x: 1, y: 2 };
p.x = 9;
console.log(p.x);`;
    await behaves(src, "9");
    expect(compile(src)).toContain("let mut p");
  });
});
