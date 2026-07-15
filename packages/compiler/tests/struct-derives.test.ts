/**
 * Specs for series 037b — struct trait derivation + struct moves.
 *
 * A generated data struct (from an `interface` or `class`) carries an on-demand
 * `#[derive(...)]` computed from field eligibility (`derives.ts`): `Clone` (so the
 * ownership pass can clone a moved-then-reused struct) + `Debug` (so
 * `console.log(struct)` can render — the printing itself is issue #22). Structs
 * join the movable set exactly when they derive `Clone`, kept in lockstep with the
 * emitter via the shared cloneability test.
 *
 * Differential: emitted Rust compiles AND matches the TS run; derive/clone
 * placement is asserted on the emitted source. See
 * docs/work/037-ownership-cfg-liveness/specs.md.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("struct-derives", [
  {
    name: "D1 an interface struct moved then reused is cloned + behaves",
    src: `interface Point { x: number; y: number; }
const a: Point = { x: 1, y: 2 };
const b: Point = a;
console.log(a.x);
console.log(b.x);`,
    expected: "1\n1",
    extra: ({ rust }) => {
      expect(rust).toContain("#[derive(Clone, Debug, PartialEq)]");
      expect(rust).toContain("a.clone()");
    },
  },
  {
    name: "D2 a class instance moved then reused is cloned + behaves",
    src: `class Counter {
  count: number;
  constructor(c: number) { this.count = c; }
}
const a: Counter = new Counter(5);
const b: Counter = a;
console.log(a.count);
console.log(b.count);`,
    expected: "5\n5",
    extra: ({ rust }) => expect(rust).toContain("a.clone()"),
  },
  {
    name: "D5 a loop-carried struct move is cloned (037a engine + 037b movability)",
    src: `interface Point { x: number; y: number; }
function px(p: Point): number { return 1; }
const a: Point = { x: 1, y: 2 };
let total: number = 0;
for (let i = 0; i < 3; i = i + 1) {
  total = total + px(a);
}
console.log(total);`,
    expected: "3",
    extra: ({ rust }) => expect(rust).toContain("px(a.clone())"),
  },
]);

test("D3 the derive line is present on a generated class struct", () => {
  const rust = compile(`class Counter {
  count: number;
  constructor(c: number) { this.count = c; }
}
const a: Counter = new Counter(5);
console.log(a.count);`);
  expect(rust).toContain("#[derive(Clone, Debug, PartialEq)]\nstruct Counter {");
});

test("D4 a struct last use stays bare (no needless clone)", () => {
  const rust = compile(`interface Point { x: number; y: number; }
const a: Point = { x: 1, y: 2 };
const b: Point = a;
console.log(b.x);`);
  expect(rust).not.toContain("a.clone()");
  expect(rust).toContain("= a;");
});

test("D6 enum and error-class derives are unchanged (regression)", () => {
  const enumRust = compile(`enum Color { Red, Green }
const c: Color = Color.Red;
console.log(c === Color.Red);`);
  expect(enumRust).toContain("#[derive(Clone, Copy, PartialEq)]");

  const errRust = compile(`class MyError extends Error {
  constructor(message: string) { super(message); }
}
function boom(): void { throw new MyError("x"); }
boom();`);
  // A custom error class is an AppError enum variant (series 049), not a data
  // struct — it carries no data-struct derive clause.
  expect(errRust).toContain("enum AppError {");
  expect(errRust).toContain("MyError { message: String },");
  expect(errRust).not.toContain("#[derive(Clone, Debug)]\nstruct MyError");
});
