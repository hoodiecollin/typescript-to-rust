/**
 * Specs for series 053b — class inheritance, shared trait + method override.
 * A base class extended by a subclass synthesizes a `trait IA` carrying the base
 * methods as default bodies; `impl IA for Base` (empty, uses defaults) and
 * `impl IA for Sub` (overrides + forwarders). A monomorphic base-typed param is
 * `impl IA` (static dispatch, no `dyn`). `super.m()` reuses the base body.
 *
 * IDs map to docs/work/053-class-inheritance/specs.md (INH7–INH11).
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { runRust } from "../src/harness";

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

const ANIMAL = `class Animal {
  name: string;
  constructor(name: string) { this.name = name; }
  speak(): string { return "..."; }
  describe(): string { return this.name; }
}`;

const DOG = `class Dog extends Animal {
  breed: string;
  constructor(name: string, breed: string) {
    super(name);
    this.breed = breed;
  }
  speak(): string { return "woof"; }
}`;

describe("053b: class inheritance — shared trait + override", () => {
  test("INH7 an extended base synthesizes `trait IAnimal` + per-class impls", () => {
    const rust = compile(`${ANIMAL}
${DOG}`);
    expect(rust).toContain("trait IAnimal {");
    expect(rust).toContain("impl IAnimal for Animal {");
    expect(rust).toContain("impl IAnimal for Dog {");
  });

  test("INH8 reuse + override: base uses default, subclass uses its override", async () => {
    await behaves(
      `${ANIMAL}
${DOG}
const a: Animal = new Animal("generic");
const d: Dog = new Dog("Rex", "Lab");
console.log(a.speak());
console.log(d.speak());`,
      "...\nwoof",
    );
  });

  test("INH9 a non-overridden method reuses the default via the forwarder", async () => {
    await behaves(
      `${ANIMAL}
${DOG}
const d: Dog = new Dog("Rex", "Lab");
console.log(d.describe());`,
      "Rex",
    );
  });

  test("INH10 a monomorphic base-typed param is `impl IAnimal` (static dispatch)", async () => {
    const src = `${ANIMAL}
${DOG}
function greet(a: Animal): string { return a.speak(); }
const d: Dog = new Dog("Rex", "Lab");
console.log(greet(d));`;
    const rust = compile(src);
    expect(rust).toContain("impl IAnimal");
    expect(rust).not.toContain("dyn IAnimal");
    await behaves(src, "woof");
  });

  test("INH11 `super.speak()` inside an override reuses the base body (not self-recursion)", async () => {
    // `Loud` overrides `speak` and calls `super.speak()`. If `super.speak()`
    // lowered to `self.speak()` it would recurse forever; reaching `Animal`'s
    // body prints its sound — the differential the `super` path must produce.
    await behaves(
      `${ANIMAL}
class Loud extends Animal {
  constructor(name: string) { super(name); }
  speak(): string { return super.speak(); }
}
const l: Loud = new Loud("x");
console.log(l.speak());`,
      "...",
    );
  });
});
