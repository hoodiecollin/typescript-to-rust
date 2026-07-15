/**
 * Specs for series 081 slices 1 + 2 — class generics (issue #40). Introduces type
 * parameters into the type system for the first time: `class Box<T>` →
 * `struct Box<T>` / `impl<T> Box<T>` (monomorphized, derive-driven bounds,
 * inference-only construction), store/move/clone/return `T`, multiple params, a
 * generic method `<U>`, and `<T extends I>` → `struct Box<T: I<Name>>` binding the
 * behavioral-interface trait (071 `traitNameOf`), a bounded `T` calling interface
 * methods. Operators-on-`T`, explicit call-site type args, class/multi bounds stay
 * fail-loud (slice 3 / #44).
 *
 * IDs map to docs/work/081-class-generics/specs.md (CG1–CG13).
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";
import { UnsupportedError } from "../src/lower";

const BOX = `class Box<T> {
  v: T;
  constructor(v: T) { this.v = v; }
  get(): T { return this.v; }
}`;

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
const BOXED = `class Boxed<T extends Shape> {
  v: T;
  constructor(v: T) { this.v = v; }
  area(): number { return this.v.area(); }
}`;

defineDifferential("class-generics", [
  {
    name: "CG1 `Box<T>` → struct Box<T> / impl<T>, Box<f64> by inference",
    src: `${BOX}\nconsole.log(new Box(5).get());`,
    expected: "5",
    extra: ({ rust }) => {
      expect(rust).toContain("struct Box<T>");
      // The inherent impl carries a derive-driven `Clone` bound (methods clone the T field).
      expect(rust).toContain("impl<T: Clone> Box<T>");
      expect(rust).not.toContain("Box::<");
    },
  },
  {
    name: "CG2 same Box<T> over a string (Box<String> by inference)",
    src: `${BOX}\nconsole.log(new Box("hi").get());`,
    expected: "hi",
  },
  {
    name: "CG3 store / move / clone / return T (two instantiations)",
    src: `${BOX}
const a: Box<number> = new Box(7);
const b: Box<string> = new Box("z");
console.log(a.get());
console.log(b.get());`,
    expected: "7\nz",
    extra: ({ rust }) => {
      expect(rust).toContain("Box<f64>");
      expect(rust).toContain("Box<String>");
    },
  },
  {
    name: "CG4 generic method `first<U>` on a non-generic class",
    src: `class C {
  first<U>(xs: U[]): U { return xs[0]; }
}
console.log(new C().first([3, 4]));`,
    expected: "3",
    extra: ({ rust }) => expect(rust).toContain("fn first<U: Clone>"),
  },
  {
    name: "CG5 multiple params `Pair<A, B>`",
    src: `class Pair<A, B> {
  a: A;
  b: B;
  constructor(a: A, b: B) { this.a = a; this.b = b; }
  fst(): A { return this.a; }
  snd(): B { return this.b; }
}
const p: Pair<number, string> = new Pair(1, "x");
console.log(p.fst());
console.log(p.snd());`,
    expected: "1\nx",
    extra: ({ rust }) => {
      expect(rust).toContain("struct Pair<A, B>");
      expect(rust).toContain("impl<A: Clone, B: Clone> Pair<A, B>");
    },
  },
  {
    name: "CG6 `Boxed<T extends Shape>` → struct Boxed<T: IShape>, bounded T calls area()",
    src: `${SHAPE}\n${CIRCLE}\n${BOXED}\nconsole.log(new Boxed(new Circle(2)).area());`,
    expected: "12",
    extra: ({ rust }) => {
      expect(rust).toContain("struct Boxed<T: IShape>");
      expect(rust).toContain("impl<T: IShape + Clone> Boxed<T>");
    },
  },
  {
    name: "CG7 bound monomorphized per satisfier (two classes)",
    src: `${SHAPE}\n${CIRCLE}\n${SQUARE}\n${BOXED}
console.log(new Boxed(new Circle(2)).area());
console.log(new Boxed(new Square(3)).area());`,
    expected: "12\n9",
  },
]);

test("CG8 a mixed-operand operator on a bare T fails loud (retargeted by 088)", () => {
  // Series 088 graduated operators over a **same-`T`** pair to the tslib
  // JS-operator trait layer (`a + b` where `a,b: T` now lowers). What stays loud is
  // the **mixed-operand** JS coercion case — a `T` and a non-`T` operand — the
  // definition site can't know the coercion. (See generic-operators.test.ts GOP1-8
  // for the full retarget.)
  const src = `class Box<T> {
  v: T;
  constructor(v: T) { this.v = v; }
  bump(): T { return this.v + 1; }
}
console.log(new Box(1).bump());`;
  expect(() => compile(src)).toThrow(UnsupportedError);
});

test("CG9 explicit call-site type arg on new fails loud", () => {
  const src = `${BOX}\nconsole.log(new Box<string>("hi").get());`;
  expect(() => compile(src)).toThrow(UnsupportedError);
});

test("CG10 explicit type arg on a generic fn call fails loud", () => {
  const src = `function identity<A>(x: A): A { return x; }
console.log(identity<number>(5));`;
  expect(() => compile(src)).toThrow(UnsupportedError);
});

test("CG11 a class as a bound fails loud", () => {
  const src = `${CIRCLE}
class Box<T extends Circle> {
  v: T;
  constructor(v: T) { this.v = v; }
}
console.log("x");`;
  expect(() => compile(src)).toThrow(UnsupportedError);
});

test("CG12 a multi-bound fails loud", () => {
  const src = `interface A { a(): number }
interface B { b(): number }
class Box<T extends A & B> {
  v: T;
  constructor(v: T) { this.v = v; }
}
console.log("x");`;
  expect(() => compile(src)).toThrow(UnsupportedError);
});

test("CG13 a non-generic class is byte-for-byte unchanged", () => {
  const src = `class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) { this.x = x; this.y = y; }
  sum(): number { return this.x + this.y; }
}
console.log(new Point(1, 2).sum());`;
  const rust = compile(src);
  expect(rust).toContain("struct Point {");
  expect(rust).toContain("impl Point {");
  expect(rust).not.toContain("Point<");
  expect(rust).not.toContain("impl<");
});
