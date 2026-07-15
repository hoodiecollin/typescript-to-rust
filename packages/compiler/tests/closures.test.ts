/**
 * Specs for series 027-cl — value-position closures over arrays (the "hard gate"
 * for 027). A single-param arrow passed to `map`/`filter`/`forEach` lowers to a
 * Rust iterator chain:
 *   xs.map(x => e)     → xs.iter().map(|&x| e).collect::<Vec<_>>()
 *   xs.filter(x => c)  → xs.iter().filter(|&&x| c).copied().collect::<Vec<_>>()
 *   xs.forEach(x => s) → for &x in xs.iter() { s }
 *
 * First slice: `Array<number>` (Copy elements). Differential-verified.
 */

import { defineDifferential } from "./_support/differential";

defineDifferential("closures", [
  {
    name: "map doubles each element",
    src: `const xs: Array<number> = [1, 2, 3];
const ys: Array<number> = xs.map(x => x * 2);
console.log(ys[2]);`,
    expected: "6",
  },
  {
    name: "filter keeps a predicate's matches",
    src: `const xs: Array<number> = [1, 2, 3, 4];
const big: Array<number> = xs.filter(x => x > 2);
console.log(big.length);`,
    expected: "2",
  },
  {
    name: "forEach runs a side effect per element",
    src: `const xs: Array<number> = [1, 2, 3];
xs.forEach(x => console.log(x));`,
    expected: "1\n2\n3",
  },
  {
    name: "map body can capture an outer binding",
    src: `const factor: number = 10;
const xs: Array<number> = [1, 2, 3];
const ys: Array<number> = xs.map(x => x * factor);
console.log(ys[1]);`,
    expected: "20",
  },
  {
    name: "a forEach block body with a statement",
    src: `const xs: Array<number> = [2, 4];
let total: number = 0;
xs.forEach(x => { total = total + x; });
console.log(total);`,
    expected: "6",
  },
]);
