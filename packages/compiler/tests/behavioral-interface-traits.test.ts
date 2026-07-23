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
import { UnsupportedError } from "../src/errors";
import { compile, defineDifferential } from "./_support/differential";

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

defineDifferential("behavioral-interface-traits", [
  {
    name: "BINT5 param dispatch: f(s: Shape) → &impl IShape; differential",
    src: `${SHAPE}\n${CIRCLE}\n${F}\nconsole.log(f(new Circle(2)));`,
    expected: "12",
  },
  {
    name: "BINT6 mixed dispatch: method + field-getter through the trait; differential",
    src: `${NAMED}\n${PERSON}\nfunction g(x: Named): number { return x.bump() + x.id; }\nconsole.log(g(new Person(10)));`,
    expected: "21",
  },
  {
    name: "BINT7 two classes implement one interface, each monomorphic; differential",
    src: `${SHAPE}\n${CIRCLE}\n${SQUARE}\n${F}\nconsole.log(f(new Circle(2)));\nconsole.log(f(new Square(4)));`,
    expected: "12\n16",
  },
  {
    name: "BINT11 regression: pure-data interface + object literal unchanged",
    src: `interface Point { x: number; y: number }\nconst p: Point = { x: 1, y: 2 };\nconsole.log(p.x + p.y);`,
    expected: "3",
  },
  {
    name: "BINT14 heterogeneous behavioral-interface array → `Vec<Box<dyn IShape>>`; differential",
    src: `${SHAPE}\n${CIRCLE}\n${SQUARE}\nconst xs: Array<Shape> = [new Circle(2), new Square(4)];\nfor (const x of xs) { console.log(x.area()); }`,
    expected: "12\n16",
    extra: ({ rust }) => {
      expect(rust).toContain("Box<dyn IShape>");
    },
  },
  {
    name: "BINT15 `implements` a pure-data interface → plain struct, no trait; differential",
    src: `interface PureData { x: number; y: number }\nclass P implements PureData {\n  x: number; y: number;\n  constructor() { this.x = 1; this.y = 2; }\n}\nconsole.log(new P().x + new P().y);`,
    expected: "3",
    extra: ({ rust }) => {
      // No trait/impl is synthesized for a data-only interface (nothing to dispatch).
      expect(rust).not.toContain("IPureData");
      expect(rust).toContain("struct P");
    },
  },
  {
    name: "BINT12 object literal (non-capturing) → per-literal struct + fn-ptr field; differential",
    src: `${SHAPE}\nconst s: Shape = { area: () => 5 };\nconsole.log(s.area());`,
    expected: "5",
    extra: ({ rust }) => {
      expect(rust).toContain("struct Shape__lit1");
      expect(rust).toContain("impl IShape for Shape__lit1");
    },
  },
]);

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

  test("BINT13 object literal with a capturing method literal → fail-loud", () => {
    expect(() =>
      compile(
        `${SHAPE}\nconst r = 3;\nconst s: Shape = { area: () => r * 2 };\nconsole.log(s.area());`,
      ),
    ).toThrow(UnsupportedError);
  });
});
