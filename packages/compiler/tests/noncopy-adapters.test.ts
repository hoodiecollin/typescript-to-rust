/**
 * Specs for series 115 — non-Copy element adapter chains (issue #96, a series-057
 * residual). Design + spec IDs: docs/work/115-noncopy-adapters/{design,specs}.md.
 *
 * Graduates: `reduce` over a non-Copy element (borrow the element like map/filter),
 * `forEach` over a non-Copy element (`for p in …` not `for &p`), and element-type
 * resolution through a `split` receiver so `s.split(sep).map/reduce/forEach` lift.
 * Differentials (emitted Rust runs; stdout === TS-via-Bun).
 */

import { defineDifferential } from "./_support/differential";

defineDifferential("noncopy-adapters", [
  // ── reduce over non-Copy (string[] elements) ────────────────────────────────
  {
    name: "NC1 reduce count-fold over string[] (f64 acc, borrowed element)",
    src: `const parts: string[] = ["a", "bb", "ccc"];
const n = parts.reduce((acc, p) => acc + 1, 0);
console.log(n);`,
    expected: "3",
  },
  {
    name: "NC2 reduce string-accumulator over string[]",
    src: `const parts: string[] = ["a", "b", "c"];
const joined = parts.reduce((acc, p) => acc + p, "");
console.log(joined);`,
    expected: "abc",
  },
  {
    name: "NC3 reduce reading element length (borrowed &String)",
    src: `const parts: string[] = ["a", "bb", "ccc"];
const total = parts.reduce((acc, p) => acc + p.length, 0);
console.log(total);`,
    expected: "6",
  },

  // ── forEach over non-Copy ───────────────────────────────────────────────────
  {
    name: "NC4 forEach over string[] binds &String (not for &p)",
    src: `const parts: string[] = ["a", "bb", "ccc"];
let total = 0;
parts.forEach(p => { total += p.length; });
console.log(total);`,
    expected: "6",
  },

  // ── split receiver (the #88 unblock) ────────────────────────────────────────
  // NB `parts.map(…).reduce(…)` (a non-split adapter *chain*) is blocked one layer
  // up by adapter-result element typing — a Copy-agnostic gap (it fails for
  // `xs.map(x=>x*2).reduce(…)` too), filed separately as #100. #96's non-Copy
  // borrowing does not reach it; the split receiver below is the case #96/#88 own.
  {
    name: "NC7 split→map lifts (split element resolved to String)",
    src: `const s = "a,bb,ccc";
const flags = s.split(",").map(p => p === "bb");
console.log(flags[0], flags[1]);`,
    expected: "false true",
  },
  {
    name: "NC7b split→reduce lifts",
    src: `const s = "a,bb,ccc";
const total = s.split(",").reduce((acc, p) => acc + p.length, 0);
console.log(total);`,
    expected: "6",
  },
  {
    name: "NC7c split→forEach lifts",
    src: `const s = "a,bb,ccc";
let total = 0;
s.split(",").forEach(p => { total += p.length; });
console.log(total);`,
    expected: "6",
  },
]);
