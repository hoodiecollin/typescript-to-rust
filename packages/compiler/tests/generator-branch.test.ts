/**
 * Specs for series 052b — conditional / branch yields (GEN5-7). Adds branch
 * blocks to the generator CFG: an `if`/`else` whose arms yield routes to distinct
 * resume states, and a local live across a yield on only one branch is carried
 * (a struct field) without disturbing the other branch.
 *
 * IDs map to series 052.
 */

import { defineDifferential } from "./_support/differential";

defineDifferential("generator-branch", [
  {
    name: "GEN5 (differential) a conditional-yield generator picks the right branch",
    src: `function* pick(p: boolean): Generator<number> {
  if (p) { yield 1; } else { yield 2; }
}
for (const x of pick(true)) { console.log(x); }
for (const x of pick(false)) { console.log(x); }`,
    expected: "1\n2",
  },
  {
    name: "GEN6 (differential) a yield guarded by an `if` inside a loop yields only the passing elements",
    src: `function* evens(n: number): Generator<number> {
  for (let i = 0; i < n; i = i + 1) {
    if (i % 2 === 0) { yield i; }
  }
}
for (const x of evens(5)) { console.log(x); }`,
    expected: "0\n2\n4",
  },
  {
    name: "GEN7 (differential) a local live across a yield on only one branch is carried correctly",
    src: `function* g(p: boolean, n: number): Generator<number> {
  if (p) {
    let a: number = 0;
    while (a < n) { yield a; a = a + 1; }
  } else {
    yield 99;
  }
}
for (const x of g(true, 3)) { console.log(x); }
for (const x of g(false, 3)) { console.log(x); }`,
    expected: "0\n1\n2\n99",
  },
]);
