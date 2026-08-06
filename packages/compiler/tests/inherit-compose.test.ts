/**
 * Specs for series 053a — class inheritance, composition data-reuse + `super`.
 * `class B extends A` gains a synthetic `base: A` embed (composition); `super(args)`
 * → `base: A::new(args)`; `super.m()` → `self.base.m()`; an inherited-field read
 * `b.x` → `b.base.x` (own-vs-inherited classification, multi-level hops). A subclass
 * constructor with no `super(...)` is fail-loud.
 *
 * IDs map to series 053 (INH1–INH6).
 */

import { expect, test } from "bun:test";
import { UnsupportedError } from "../src/errors";
import { compile, defineDifferential } from "./_support/differential";

const ANIMAL = `class Animal {
  name: string;
  constructor(name: string) { this.name = name; }
  describe(): string { return this.name; }
}`;

defineDifferential("inherit-compose", [
  {
    name: "INH2 `super(name)` builds `base: Animal::new(name)`; inherited field prints",
    src: `${ANIMAL}
class Dog extends Animal {
  breed: string;
  constructor(name: string, breed: string) {
    super(name);
    this.breed = breed;
  }
  bark(): string { return "woof"; }
}
const d: Dog = new Dog("Rex", "Lab");
console.log(d.name);`,
    expected: "Rex",
  },
  {
    name: "INH3 inherited-field read hops to `.base`; own-field read stays direct",
    src: `${ANIMAL}
class Dog extends Animal {
  breed: string;
  constructor(name: string, breed: string) {
    super(name);
    this.breed = breed;
  }
  bark(): string { return "woof"; }
}
const d: Dog = new Dog("Rex", "Lab");
console.log(d.name);
console.log(d.breed);`,
    expected: "Rex\nLab",
  },
  {
    name: "INH4 `super.describe()` reuses the base method",
    src: `${ANIMAL}
class Dog extends Animal {
  breed: string;
  constructor(name: string, breed: string) {
    super(name);
    this.breed = breed;
  }
  label(): string { return super.describe(); }
}
const d: Dog = new Dog("Rex", "Lab");
console.log(d.label());`,
    expected: "Rex",
  },
  {
    name: "INH5 a two-level chain hops twice for the top-base field",
    src: `${ANIMAL}
class Dog extends Animal {
  breed: string;
  constructor(name: string, breed: string) {
    super(name);
    this.breed = breed;
  }
  bark(): string { return "woof"; }
}
class Puppy extends Dog {
  weeks: number;
  constructor(name: string, breed: string, weeks: number) {
    super(name, breed);
    this.weeks = weeks;
  }
  info(): string { return this.name; }
}
const p: Puppy = new Puppy("Rex", "Lab", 5);
console.log(p.info());
console.log(p.name);`,
    expected: "Rex\nRex",
  },
]);

test("INH1 subclass embeds the base as a `base` field", () => {
  const rust = compile(`${ANIMAL}
class Dog extends Animal {
  breed: string;
  constructor(name: string, breed: string) {
    super(name);
    this.breed = breed;
  }
  bark(): string { return "woof"; }
}`);
  expect(rust).toContain("struct Dog {");
  expect(rust).toContain("base: Animal,");
  expect(rust).toContain("breed: String,");
  expect(rust).toContain("impl Dog {");
});

test("INH6 a subclass constructor without `super(...)` is fail-loud", () => {
  expect(() =>
    compile(`${ANIMAL}
class Dog extends Animal {
  breed: string;
  constructor(name: string, breed: string) {
    this.breed = breed;
  }
  bark(): string { return "woof"; }
}
const d: Dog = new Dog("Rex", "Lab");
console.log(d.breed);`),
  ).toThrow(UnsupportedError);
});
