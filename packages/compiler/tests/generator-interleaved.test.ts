/**
 * Specs for series 052c — interleaved / multiple loops + non-yield statements
 * (GEN8-9). Stress tests across-yield liveness of a mutated accumulator and
 * state numbering across multiple loop regions with a lazy side-effecting
 * statement between them.
 *
 * IDs map to series 052.
 */

import { defineDifferential } from "./_support/differential";

defineDifferential("generator-interleaved", [
  {
    name: "GEN8 (differential) a mutated accumulator carried across yields",
    src: `function* sums(n: number): Generator<number> {
  let sum: number = 0;
  for (let i = 0; i < n; i = i + 1) { sum = sum + i; yield sum; }
}
for (const x of sums(4)) { console.log(x); }`,
    expected: "0\n1\n3\n6",
  },
  {
    name: "GEN9 (differential) two sequential loops with a lazy statement between them",
    src: `function* two(n: number): Generator<number> {
  for (let i = 0; i < n; i = i + 1) { yield i; }
  console.log("mid");
  for (let j = 0; j < n; j = j + 1) { yield j + 10; }
}
for (const x of two(2)) { console.log(x); }`,
    // Lazy consumption: 0, 1, then "mid" prints as the generator crosses into
    // the second loop, then 10, 11. TS and Rust agree on this interleaving.
    expected: "0\n1\nmid\n10\n11",
  },
]);
