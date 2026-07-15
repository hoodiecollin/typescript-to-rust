/**
 * Specs for series 053b — class inheritance, shared trait + method override.
 * A base class extended by a subclass synthesizes a `trait IA` carrying the base
 * methods as default bodies; `impl IA for Base` (empty, uses defaults) and
 * `impl IA for Sub` (overrides + forwarders). A monomorphic base-typed param is
 * `impl IA` (static dispatch, no `dyn`). `super.m()` reuses the base body.
 *
 * IDs map to docs/work/053-class-inheritance/specs.md (INH7–INH11).
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

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

defineDifferential("inherit-trait", [
  {
    name: "INH8 reuse + override: base uses default, subclass uses its override",
    src: `${ANIMAL}
${DOG}
const a: Animal = new Animal("generic");
const d: Dog = new Dog("Rex", "Lab");
console.log(a.speak());
console.log(d.speak());`,
    expected: "...\nwoof",
  },
  {
    name: "INH9 a non-overridden method reuses the default via the forwarder",
    src: `${ANIMAL}
${DOG}
const d: Dog = new Dog("Rex", "Lab");
console.log(d.describe());`,
    expected: "Rex",
  },
  {
    name: "INH10 a monomorphic base-typed param is `impl IAnimal` (static dispatch)",
    src: `${ANIMAL}
${DOG}
function greet(a: Animal): string { return a.speak(); }
const d: Dog = new Dog("Rex", "Lab");
console.log(greet(d));`,
    expected: "woof",
    extra: ({ rust }) => {
      expect(rust).toContain("impl IAnimal");
      expect(rust).not.toContain("dyn IAnimal");
    },
  },
  {
    // `Loud` overrides `speak` and calls `super.speak()`. If `super.speak()`
    // lowered to `self.speak()` it would recurse forever; reaching `Animal`'s
    // body prints its sound — the differential the `super` path must produce.
    name: "INH11 `super.speak()` inside an override reuses the base body (not self-recursion)",
    src: `${ANIMAL}
class Loud extends Animal {
  constructor(name: string) { super(name); }
  speak(): string { return super.speak(); }
}
const l: Loud = new Loud("x");
console.log(l.speak());`,
    expected: "...",
  },
]);

test("INH7 an extended base synthesizes `trait IAnimal` + per-class impls", () => {
  const rust = compile(`${ANIMAL}
${DOG}`);
  expect(rust).toContain("trait IAnimal {");
  expect(rust).toContain("impl IAnimal for Animal {");
  expect(rust).toContain("impl IAnimal for Dog {");
});
