/**
 * Specs for series 104 — iterator chain fusion (#89). A single-use
 * `map`/`filter`/`reduce` chain fuses into one lazy `xs.iter().map(…).filter(…)
 * .fold(…)` with no intervening `.collect::<Vec<_>>()`; LLVM then fuses it into a
 * single allocation-free pass. `refineIterFusion` gates fusion on G1 (the
 * intermediate is dead-out, via `computeLiveOut`) and G3 (no source/forwarded-free-var
 * mutation between producer and consumer); G2 (callback purity) is free — the
 * series-048 numeric-surface lift can't produce an impure callback. When the chain's
 * source is a dead-out local, the head lowers to `into_iter()` (3c). The differential
 * harness cargo-compiles and runs each program, so every shape assertion is also a
 * COMPILES/BEHAVES proof. IDs map to docs/work/104-iterator-fusion/specs.md.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

const occurrences = (hay: string, needle: string): number =>
  hay.split(needle).length - 1;

defineDifferential("iter-fusion", [
  {
    name: "IF1 map/filter/reduce fuses into one chain with no intermediate Vec",
    src: `const xs: number[] = [];
for (let i: number = 0; i < 6; i = i + 1) { xs.push(i); }
const doubled: number[] = xs.map((v: number): number => v * 2 + 1);
const kept: number[] = doubled.filter((v: number): boolean => v % 5 !== 0);
const total: number = kept.reduce((a: number, b: number): number => a + b, 0);
console.log(total);`,
    // 1,3,5,7,9,11 → drop 5 → 1+3+7+9+11 = 31
    expected: "31",
    extra: ({ rust }) => {
      // One fused chain: map → filter → fold, no intermediate collect / lets.
      expect(rust).toContain(
        ".map(|v| __cb_map_1(v)).filter(|v| __cb_filter_2(*v)).fold(",
      );
      expect(rust).not.toContain("let doubled");
      expect(rust).not.toContain("let kept");
      expect(rust).not.toContain("collect::<Vec<_>>()");
    },
  },
  {
    name: "IF2 a two-stage map/filter fuses to one collect",
    src: `const xs: number[] = [1, 2, 3, 4, 5];
const doubled: number[] = xs.map((v: number): number => v * 2);
const kept: number[] = doubled.filter((v: number): boolean => v > 4);
console.log(kept.length);`,
    // [2,4,6,8,10] → >4 → [6,8,10] → 3
    expected: "3",
    extra: ({ rust }) => {
      // Fused to a single lazy chain terminated by one collect; no `doubled` let.
      expect(rust).not.toContain("let doubled");
      expect(occurrences(rust, "collect::<Vec<_>>()")).toBe(1);
      // xs is dead after the chain → 3c moves it via into_iter (bare element).
      expect(rust).toContain(
        "xs.into_iter().map(|v| __cb_map_1(v)).filter(|v| __cb_filter_2(*v)).collect::<Vec<_>>()",
      );
    },
  },
  {
    name: "IF3 a dead-out source lowers the fused head to into_iter (3c)",
    src: `const xs: number[] = [];
for (let i: number = 0; i < 6; i = i + 1) { xs.push(i); }
const doubled: number[] = xs.map((v: number): number => v * 2 + 1);
const total: number = doubled.reduce((a: number, b: number): number => a + b, 0);
console.log(total);`,
    // (1+3+5+7+9+11) = 36
    expected: "36",
    extra: ({ rust }) => {
      expect(rust).toContain("xs.into_iter().map(|v| __cb_map_1(v)).fold(");
      expect(rust).not.toContain("xs.iter()");
      expect(rust).not.toContain("let doubled");
    },
  },
  {
    name: "IF3b a live source keeps the fused head on iter() (borrow, not move)",
    src: `const xs: number[] = [];
for (let i: number = 0; i < 6; i = i + 1) { xs.push(i); }
const doubled: number[] = xs.map((v: number): number => v * 2 + 1);
const total: number = doubled.reduce((a: number, b: number): number => a + b, 0);
console.log(total);
console.log(xs.length);`,
    expected: "36\n6",
    extra: ({ rust }) => {
      // `xs` is read after the chain → borrow with iter(), element derefs `*v`.
      expect(rust).toContain("xs.iter().map(|v| __cb_map_1(*v)).fold(");
      expect(rust).not.toContain("into_iter");
    },
  },
  {
    name: "IF4 an intermediate observed later is not fused (G1)",
    src: `const xs: number[] = [1, 2, 3, 4];
const doubled: number[] = xs.map((v: number): number => v * 2);
console.log(doubled.length);
const total: number = doubled.reduce((a: number, b: number): number => a + b, 0);
console.log(total);`,
    // len 4; sum [2,4,6,8] = 20
    expected: "4\n20",
    extra: ({ rust }) => {
      // `doubled` is live-out (its .length is read) → kept eager, .collect() remains.
      expect(rust).toContain("let doubled");
      expect(rust).toContain("collect::<Vec<_>>()");
    },
  },
  {
    name: "IF6a a source mutated in the gap blocks fusion (G3)",
    src: `const xs: number[] = [1, 2, 3];
const doubled: number[] = xs.map((v: number): number => v * 2);
xs.push(99);
const total: number = doubled.reduce((a: number, b: number): number => a + b, 0);
console.log(total);`,
    // doubled captured before the push → [2,4,6] = 12 (NOT including 99*2)
    expected: "12",
    extra: ({ rust }) => {
      expect(rust).toContain("let doubled");
      expect(rust).toContain("collect::<Vec<_>>()");
    },
  },
  {
    name: "IF6b a forwarded free var reassigned in the gap blocks fusion (G3)",
    src: `const xs: number[] = [1, 2, 3];
let k: number = 2;
const doubled: number[] = xs.map((v: number): number => v + k);
k = 5;
const total: number = doubled.reduce((a: number, b: number): number => a + b, 0);
console.log(total);`,
    // map captures k=2 → [3,4,5] = 12 (NOT k=5 → [6,7,8]=21)
    expected: "12",
    extra: ({ rust }) => {
      expect(rust).toContain("let doubled");
      expect(rust).toContain("collect::<Vec<_>>()");
    },
  },
  {
    name: "IF8 a lone map with no downstream adapter is unchanged",
    src: `const xs: number[] = [1, 2, 3];
const doubled: number[] = xs.map((v: number): number => v * 2);
console.log(doubled.length);`,
    expected: "3",
    extra: ({ rust }) => {
      expect(rust).toContain(
        "xs.iter().map(|v| __cb_map_1(*v)).collect::<Vec<_>>()",
      );
    },
  },
]);

test("IF-G2 a non-numeric callback is fail-loud at lift time (before fusion)", () => {
  const src = `function helper(x: number): number { return x + 1; }
const xs: number[] = [1, 2, 3];
const doubled: number[] = xs.map((v: number): number => helper(v));
const total: number = doubled.reduce((a: number, b: number): number => a + b, 0);
console.log(total);`;
  expect(() => compile(src)).toThrow(/too complex to lift/);
});
