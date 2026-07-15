/**
 * Specs for series 042c — Option equality + narrowing. `x === undefined`/`null`
 * → `x.is_none()`; `!==` → `x.is_some()`; `if (x !== undefined) { …x… }` →
 * `if let Some(x) = x { … }` (x is the inner T in the block); the `=== undefined`
 * form narrows the else branch. Differential + shape assertions. IDs → specs.md.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("option-narrow", [
  {
    name: "NRW2 is_none / is_some behave",
    src: `const a: number | undefined = 5;
const b: number | undefined = undefined;
console.log(a === undefined, b === undefined);`,
    expected: "false true",
  },
  {
    name: "NRW3 if (x !== undefined) narrows to if let Some",
    src: `const x: number | undefined = 7;
if (x !== undefined) {
  console.log(x + 1);
} else {
  console.log(-1);
}`,
    expected: "8",
    extra: ({ rust }) => expect(rust).toContain("if let Some(x) = x"),
  },
  {
    name: "NRW4 narrowing takes the else path when None",
    src: `const x: number | undefined = undefined;
if (x !== undefined) {
  console.log(x + 1);
} else {
  console.log(-1);
}`,
    expected: "-1",
  },
  {
    name: "NRW5 === undefined narrows the else branch (branches swap)",
    src: `const x: number | undefined = 3;
if (x === undefined) {
  console.log(0);
} else {
  console.log(x * 2);
}`,
    expected: "6",
  },
  {
    name: "NRW6 null narrows the same as undefined",
    src: `const x: number | null = 4;
if (x !== null) {
  console.log(x + 10);
} else {
  console.log(0);
}`,
    expected: "14",
  },
]);

test("NRW1 === undefined → is_none(), !== undefined → is_some()", () => {
  const rust = compile(`const x: number | undefined = 5;
console.log(x === undefined);
console.log(x !== undefined);`);
  expect(rust).toContain(".is_none()");
  expect(rust).toContain(".is_some()");
});
