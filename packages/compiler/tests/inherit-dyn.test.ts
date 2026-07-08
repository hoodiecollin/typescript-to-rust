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

describe("053c: class inheritance — dyn dispatch + accessors", () => {
  test("INH12 heterogeneous array → `Vec<Box<dyn IAnimal>>`, dispatches per element", async () => {
    const src = `${ANIMAL}
${DOG}
${CAT}
const zoo: Array<Animal> = [new Dog("Rex"), new Cat("Tom")];
for (const a of zoo) {
  console.log(a.speak());
}`;
    const rust = compile(src);
    expect(rust).toContain("Box<dyn IAnimal>");
    await behaves(src, "woof\nmeow");
  });

  test("INH13 a base-field read through a `dyn` uses the trait accessor", async () => {
    const src = `${ANIMAL}
${DOG}
${CAT}
const zoo: Array<Animal> = [new Dog("Rex"), new Cat("Tom")];
for (const a of zoo) {
  console.log(a.name);
}`;
    const rust = compile(src);
    expect(rust).toContain("fn name(&self) -> &String");
    await behaves(src, "Rex\nTom");
  });

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

  test("INH16 `implements` / interface conformance stays fail-loud", () => {
    expect(() =>
      compile(`interface Speaker { speak(): string; }
class Robot implements Speaker {
  speak(): string { return "beep"; }
}
const r: Robot = new Robot();
console.log(r.speak());`),
    ).toThrow(UnsupportedError);
  });
});
