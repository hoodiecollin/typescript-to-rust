/**
 * Specs for series 025 — esoteric-feature support. Each construct graduates from
 * fail-loud (024 default-deny) to a real, differential-verified lowering:
 *
 *   025a — parameter properties (`constructor(public x: T)`) → field + assign.
 *   025b — `enum E { A, B }` → Rust `enum` (+ `switch` over it → `match`).
 *   025c — `using r = acquire()` + `[Symbol.dispose]()` → RAII `Drop`.
 *
 * Green specs assert the emitted Rust compiles AND its stdout matches the TS run.
 */

import { defineDifferential } from "./_support/differential";

defineDifferential("esoteric", [
  {
    name: "a `public` ctor param becomes a field and is read back",
    src: `class Point {
  constructor(public x: number, public y: number) {}
  sum(): number { return this.x + this.y; }
}
const p: Point = new Point(3, 4);
console.log(p.sum());`,
    expected: "7",
  },
  {
    name: "param properties mix with an explicit field",
    src: `class Box {
  area: number;
  constructor(public w: number, public h: number) {
    this.area = w * h;
  }
}
const b: Box = new Box(3, 5);
console.log(b.area);`,
    expected: "15",
  },
  {
    name: "a C-like enum value prints its discriminant via a match",
    src: `enum Color { Red, Green, Blue }
function code(c: Color): number {
  switch (c) {
    case Color.Red: return 0;
    case Color.Green: return 1;
    default: return 2;
  }
}
console.log(code(Color.Green));`,
    expected: "1",
  },
  {
    name: "a disposable resource runs its dispose at scope exit",
    src: `class Guard {
  constructor(public label: string) {}
  [Symbol.dispose]() { console.log(this.label); }
}
function work(): void {
  using a = new Guard("a");
  using b = new Guard("b");
  console.log("body");
}
work();`,
    expected: "body\nb\na",
  },
]);
