/**
 * Specs for series 037a — ownership analysis via CFG + backward liveness.
 *
 * Replaces the straight-line `refineMoves` (034) heuristic (last *textual* use)
 * with real liveness over a control-flow graph. This fixes the two shapes the
 * heuristic gets wrong:
 *   - a **loop-carried move** (live across the back-edge) — straight-line leaves it
 *     bare → cargo E0382; the engine clones it;
 *   - a **branch join** — straight-line over-clones a move that's dead after a
 *     mutually-exclusive branch; the engine proves it dead and leaves it bare.
 *
 * The pass still only ever *adds* clones (fail-loud preserved). Differential:
 * emitted Rust compiles AND matches the TS run; clone *placement* is asserted on
 * the emitted source. See series 037.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("ownership-cfg", [
  {
    name: "L1 owned-arg move inside a for, no textual use after, is cloned",
    // Straight-line sees `score(s)`'s single occurrence as a last use → bare move
    // → E0382 on iteration 2. The back-edge makes `s` live at the loop bottom.
    src: `function score(s: string): number { return 1; }
const s: string = "hi";
let total: number = 0;
for (let i = 0; i < 3; i = i + 1) {
  total = total + score(s);
}
console.log(total);`,
    expected: "3",
    extra: ({ rust }) => expect(rust).toContain("score(s.clone())"),
  },
  {
    name: "L2 `let`-alias move inside a while is cloned",
    src: `function score(s: string): number { return 1; }
const s: string = "hello";
let total: number = 0;
let i: number = 0;
while (i < 3) {
  const t: string = s;
  total = total + score(t);
  i = i + 1;
}
console.log(total);`,
    expected: "3",
    // `const t = s` inside the loop moves `s` each iteration → must clone.
    extra: ({ rust }) => expect(rust).toContain("s.clone()"),
  },
  {
    name: "B1 mutually-exclusive branches: a then-move dead after the join is NOT cloned",
    // `s` is moved in the `then` and only *read* in the mutually-exclusive `else`;
    // nothing uses it after the join. Straight-line (document order) sees the
    // else-read as a later use and clones needlessly. Liveness proves it dead.
    src: `function score(s: string): number { return 1; }
const s: string = "hi";
const flag: boolean = true;
if (flag) {
  console.log(score(s));
} else {
  console.log(s);
}`,
    expected: "1",
    extra: ({ rust }) => expect(rust).not.toContain("s.clone()"),
  },
  {
    name: "B2 a move read after the join is still cloned",
    src: `function score(s: string): number { return 1; }
const s: string = "hi";
const flag: boolean = true;
let out: number = 0;
if (flag) {
  out = score(s);
}
console.log(out);
console.log(s.length);`,
    expected: "1\n2",
    extra: ({ rust }) => expect(rust).toContain("score(s.clone())"),
  },
  {
    name: "P2 straight-line reuse is still cloned + behaves",
    src: `const a: string = "hello";
const b: string = a;
console.log(a);
console.log(b);`,
    expected: "hello\nhello",
    extra: ({ rust }) => expect(rust).toContain("a.clone()"),
  },
  {
    name: "P3 nested loops exercise the fixpoint — move cloned",
    src: `function score(s: string): number { return 1; }
const s: string = "hi";
let total: number = 0;
let i: number = 0;
while (i < 2) {
  let j: number = 0;
  while (j < 2) {
    total = total + score(s);
    j = j + 1;
  }
  i = i + 1;
}
console.log(total);`,
    expected: "4",
    extra: ({ rust }) => expect(rust).toContain("score(s.clone())"),
  },
]);

test("P1 a straight-line last use stays bare (no needless clone)", () => {
  const rust = compile(`const a: string = "x";
const b: string = a;
console.log(b);`);
  expect(rust).not.toContain("a.clone()");
  expect(rust).toContain("= a;");
});
