/**
 * Specs for series 053a — class inheritance, composition data-reuse + `super`.
 * `class B extends A` gains a synthetic `base: A` embed (composition); `super(args)`
 * → `base: A::new(args)`; `super.m()` → `self.base.m()`; an inherited-field read
 * `b.x` → `b.base.x` (own-vs-inherited classification, multi-level hops). A subclass
 * constructor with no `super(...)` is fail-loud.
 *
 * IDs map to docs/work/053-class-inheritance/specs.md (INH1–INH6).
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { runRust } from "../src/harness";
import { UnsupportedError } from "../src/lower";

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
  describe(): string { return this.name; }
}`;

describe("053a: class inheritance — composition + super", () => {
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

  test("INH2 `super(name)` builds `base: Animal::new(name)`; inherited field prints", async () => {
    await behaves(
      `${ANIMAL}
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
      "Rex",
    );
  });

  test("INH3 inherited-field read hops to `.base`; own-field read stays direct", async () => {
    await behaves(
      `${ANIMAL}
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
      "Rex\nLab",
    );
  });

  test("INH4 `super.describe()` reuses the base method", async () => {
    await behaves(
      `${ANIMAL}
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
      "Rex",
    );
  });

  test("INH5 a two-level chain hops twice for the top-base field", async () => {
    await behaves(
      `${ANIMAL}
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
      "Rex\nRex",
    );
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
});
