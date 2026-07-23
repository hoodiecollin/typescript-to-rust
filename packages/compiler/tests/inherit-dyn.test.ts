/**
 * Specs for series 053c — class inheritance, polymorphism via `dyn IA` +
 * accessors. A heterogeneous base-typed array `[new Dog(), new Cat()]` lowers to
 * `Vec<Box<dyn IAnimal>>` and dispatches per-element (vtable). A shared/base
 * field read through a `dyn` routes through an on-demand trait accessor
 * `a.name()`; accessors are gated (a pure reuse+override program emits none). A
 * subclass-only field through a `dyn` (a downcast) stays fail-loud, as does
 * `implements` / multiple inheritance.
 *
 * IDs map to docs/work/053-class-inheritance/specs.md (INH12–INH16).
 */

import { describe, expect, test } from "bun:test";
import { UnsupportedError } from "../src/errors";
import { compile, defineDifferential } from "./_support/differential";

const ANIMAL = `class Animal {
  name: string;
  constructor(name: string) { this.name = name; }
  speak(): string { return "..."; }
}`;

const DOG = `class Dog extends Animal {
  constructor(name: string) { super(name); }
  speak(): string { return "woof"; }
}`;

const CAT = `class Cat extends Animal {
  constructor(name: string) { super(name); }
  speak(): string { return "meow"; }
}`;

defineDifferential("inherit-dyn", [
  {
    name: "INH12 heterogeneous array → `Vec<Box<dyn IAnimal>>`, dispatches per element",
    src: `${ANIMAL}
${DOG}
${CAT}
const zoo: Array<Animal> = [new Dog("Rex"), new Cat("Tom")];
for (const a of zoo) {
  console.log(a.speak());
}`,
    expected: "woof\nmeow",
    extra: ({ rust }) => expect(rust).toContain("Box<dyn IAnimal>"),
  },
  {
    name: "INH13 a base-field read through a `dyn` uses the trait accessor",
    src: `${ANIMAL}
${DOG}
${CAT}
const zoo: Array<Animal> = [new Dog("Rex"), new Cat("Tom")];
for (const a of zoo) {
  console.log(a.name);
}`,
    expected: "Rex\nTom",
    extra: ({ rust }) => expect(rust).toContain("fn name(&self) -> &String"),
  },
  // INH16 was a 053c fail-loud residual: `implements` conformance on a
  // constructor-less class. Both halves have since graduated — behavioral-interface
  // trait synthesis (071) and implicit constructors (070) — so this now compiles
  // to a valid `impl ISpeaker for Robot` + synthesized `new()` and runs.
  {
    name: "INH16 `implements` on an implicit-ctor class behaves (071 + 070)",
    src: `interface Speaker { speak(): string; }
class Robot implements Speaker {
  speak(): string { return "beep"; }
}
const r: Robot = new Robot();
console.log(r.speak());`,
    expected: "beep",
  },
]);

describe("053c: class inheritance — dyn dispatch + accessors", () => {
  test("INH14 accessors are gated: a pure reuse+override program emits none", () => {
    const rust = compile(`${ANIMAL}
${DOG}
const d: Dog = new Dog("Rex");
console.log(d.speak());`);
    expect(rust).not.toContain("fn name(&self) -> &String");
  });

  test("INH15 a subclass-only field through a `dyn` (a downcast) is fail-loud", () => {
    expect(() =>
      compile(`${ANIMAL}
class Dog extends Animal {
  breed: string;
  constructor(name: string, breed: string) {
    super(name);
    this.breed = breed;
  }
  speak(): string { return "woof"; }
}
${CAT}
const zoo: Array<Animal> = [new Dog("Rex", "Lab"), new Cat("Tom")];
for (const a of zoo) {
  console.log(a.breed);
}`),
    ).toThrow(UnsupportedError);
  });
});
