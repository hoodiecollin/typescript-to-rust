/**
 * Specs for series 039 — native array iteration adapters (`some`/`every`/
 * `reduce`). These map cleanly to Rust iterator adapters (Route N, 029 catalog):
 *   xs.some(x => p)          → xs.iter().any(|&x| p)
 *   xs.every(x => p)         → xs.iter().all(|&x| p)
 *   xs.reduce((a, x) => e, i)→ xs.iter().fold(i, |a, &x| e)
 * The `reduce` callback introduces the two-param closure shape. Differential:
 * emitted Rust compiles AND matches the TS run. IDs map to specs.md.
 */

import { expect, test } from "bun:test";
import { UnsupportedError } from "../src/emitter";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("array-adapters", [
  {
    name: "ADP1 some → any (true)",
    src: `const xs: Array<number> = [1, 2, 3];
console.log(xs.some(x => x > 2));`,
    expected: "true",
  },
  {
    name: "ADP2 some → any (false)",
    src: `const xs: Array<number> = [1, 2, 3];
console.log(xs.some(x => x > 5));`,
    expected: "false",
  },
  {
    name: "ADP3 every → all (true)",
    src: `const xs: Array<number> = [1, 2, 3];
console.log(xs.every(x => x > 0));`,
    expected: "true",
  },
  {
    name: "ADP4 every → all (false)",
    src: `const xs: Array<number> = [1, 2, 3];
console.log(xs.every(x => x > 1));`,
    expected: "false",
  },
  {
    name: "ADP5 reduce sum from 0",
    src: `const xs: Array<number> = [1, 2, 3];
console.log(xs.reduce((acc, x) => acc + x, 0));`,
    expected: "6",
  },
  {
    name: "ADP6 reduce product from a non-zero init",
    src: `const xs: Array<number> = [1, 2, 3, 4];
console.log(xs.reduce((acc, x) => acc * x, 1));`,
    expected: "24",
  },
]);

test("ADP7 routing is native (any/all/fold), not tslib", () => {
  const some = compile(
    `const xs: Array<number> = [1];\nconsole.log(xs.some(x => x > 0));`,
  );
  const every = compile(
    `const xs: Array<number> = [1];\nconsole.log(xs.every(x => x > 0));`,
  );
  const reduce = compile(
    `const xs: Array<number> = [1];\nconsole.log(xs.reduce((a, x) => a + x, 0));`,
  );
  expect(some).toContain(".any(");
  expect(every).toContain(".all(");
  expect(reduce).toContain(".fold(");
  expect(some + every + reduce).not.toContain("tslib");
});

test("ADP8 reduce without an init arg is fail-loud", () => {
  expect(() =>
    compile(
      `const xs: Array<number> = [1, 2, 3];\nconst s = xs.reduce((acc, x) => acc + x);`,
    ),
  ).toThrow(UnsupportedError);
});

test("ADP9 a user class method named reduce is a native call, not hijacked", () => {
  const src = `class Box {
  n: number;
  constructor(n: number) { this.n = n; }
  reduce(): number { return this.n; }
}
const b: Box = new Box(5);
console.log(b.reduce());`;
  const rust = compile(src);
  expect(rust).toContain("b.reduce()");
  expect(rust).not.toContain(".fold(");
});
