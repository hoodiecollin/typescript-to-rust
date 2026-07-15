/**
 * Specs for series 071 increment 1 — behavioral-interface trait synthesis +
 * `implements` conformance + param dispatch (the load-bearing #43 slice; unblocks
 * #40). A standalone behavioral/mixed interface synthesizes `trait I<Name>`;
 * `class C implements I` gets `impl I<Name> for C` (method forwarders + 059
 * getters); a param typed as the interface is `&impl I<Name>` with trait dispatch.
 *
 * IDs map to docs/work/071-trait-struct-model/specs.md (BINT1–BINT11).
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

const SHAPE = `interface Shape { area(): number }`;
const CIRCLE = `class Circle implements Shape {
  r: number;
  constructor(r: number) { this.r = r; }
  area(): number { return this.r * this.r * 3; }
}`;
const SQUARE = `class Square implements Shape {
  s: number;
  constructor(s: number) { this.s = s; }
  area(): number { return this.s * this.s; }
}`;
const F = `function f(s: Shape): number { return s.area(); }`;

// Mixed interface (data field + method). Numeric to keep the differential off the
// orthogonal String-concat-of-a-field emitter gap (pre-existing, not a 071 concern).
const NAMED = `interface Named { id: number; bump(): number }`;
const PERSON = `class Person implements Named {
  id: number;
  constructor(i: number) { this.id = i; }
  bump(): number { return this.id + 1; }
}`;

describe("071.1 behavioral-interface trait synthesis + implements", () => {
  test("BINT1 pure-behavioral interface → `trait IShape { fn area }`, no struct", () => {
    const rust = compile(`${SHAPE}\n${CIRCLE}\n${F}\nconsole.log(f(new Circle(2)));`);
    expect(rust).toContain("trait IShape {");
    expect(rust).toContain("fn area(&self) -> f64");
    expect(rust).not.toContain("struct Shape");
  });

  test("BINT2 mixed interface → trait with by-value getter + method", () => {
    const rust = compile(
      `${NAMED}\n${PERSON}\nfunction g(x: Named): number { return x.bump() + x.id; }\nconsole.log(g(new Person(10)));`,
    );
    expect(rust).toContain("trait INamed {");
    expect(rust).toContain("fn id(&self) -> f64");
    expect(rust).toContain("fn bump(&self) -> f64");
  });

  test("BINT3 `class Circle implements Shape` → `impl IShape for Circle` (forwarder)", () => {
    const rust = compile(`${SHAPE}\n${CIRCLE}\n${F}\nconsole.log(f(new Circle(2)));`);
    expect(rust).toContain("impl IShape for Circle {");
  });

  test("BINT4 mixed impl carries getter + method forwarder", () => {
    const rust = compile(
      `${NAMED}\n${PERSON}\nfunction g(x: Named): number { return x.bump() + x.id; }\nconsole.log(g(new Person(10)));`,
    );
    expect(rust).toContain("impl INamed for Person {");
  });

  test("BINT5 param dispatch: f(s: Shape) → &impl IShape; differential", async () => {
    await behaves(
      `${SHAPE}\n${CIRCLE}\n${F}\nconsole.log(f(new Circle(2)));`,
      "12",
    );
  });

  test("BINT6 mixed dispatch: method + field-getter through the trait; differential", async () => {
    await behaves(
      `${NAMED}\n${PERSON}\nfunction g(x: Named): number { return x.bump() + x.id; }\nconsole.log(g(new Person(10)));`,
      "21",
    );
  });

  test("BINT7 two classes implement one interface, each monomorphic; differential", async () => {
    await behaves(
      `${SHAPE}\n${CIRCLE}\n${SQUARE}\n${F}\nconsole.log(f(new Circle(2)));\nconsole.log(f(new Square(4)));`,
      "12\n16",
    );
  });

  test("BINT11 regression: pure-data interface + object literal unchanged", async () => {
    await behaves(
      `interface Point { x: number; y: number }\nconst p: Point = { x: 1, y: 2 };\nconsole.log(p.x + p.y);`,
      "3",
    );
  });
});

describe("071.2 heterogeneous dispatch, pure-data implements, object-literal synthesis", () => {
  test("BINT14 heterogeneous behavioral-interface array → `Vec<Box<dyn IShape>>`; differential", async () => {
    const src = `${SHAPE}\n${CIRCLE}\n${SQUARE}\nconst xs: Array<Shape> = [new Circle(2), new Square(4)];\nfor (const x of xs) { console.log(x.area()); }`;
    const rust = compile(src);
    expect(rust).toContain("Box<dyn IShape>");
    await behaves(src, "12\n16");
  });

  test("BINT15 `implements` a pure-data interface → plain struct, no trait; differential", async () => {
    const src = `interface PureData { x: number; y: number }\nclass P implements PureData {\n  x: number; y: number;\n  constructor() { this.x = 1; this.y = 2; }\n}\nconsole.log(new P().x + new P().y);`;
    const rust = compile(src);
    // No trait/impl is synthesized for a data-only interface (nothing to dispatch).
    expect(rust).not.toContain("IPureData");
    expect(rust).toContain("struct P");
    await behaves(src, "3");
  });

  test("BINT12 object literal (non-capturing) → per-literal struct + fn-ptr field; differential", async () => {
    const src = `${SHAPE}\nconst s: Shape = { area: () => 5 };\nconsole.log(s.area());`;
    const rust = compile(src);
    expect(rust).toContain("struct Shape__lit1");
    expect(rust).toContain("impl IShape for Shape__lit1");
    await behaves(src, "5");
  });

  test("BINT13 object literal with a capturing method literal → fail-loud", () => {
    expect(() =>
      compile(
        `${SHAPE}\nconst r = 3;\nconst s: Shape = { area: () => r * 2 };\nconsole.log(s.area());`,
      ),
    ).toThrow(UnsupportedError);
  });
});
