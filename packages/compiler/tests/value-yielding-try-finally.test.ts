/**
 * Specs for series 073 — `finally` combined with an escaping jump (the committed
 * carrier-enum follow-on to 063). The finally+escape construct lowers to a
 * per-construct control **carrier** enum (`Normal | Return(V) | Err(E) |
 * Break(t) | Continue(t)`); the `finally` body runs natively, once, before a
 * dispatch site replays the recorded escape. A self-escaping `finally`
 * pre-empts the pending action (it runs first). Everything else stays on 063's
 * labeled block.
 *
 * Each spec differential-matches (compile → cargo run → TS-via-Bun). IDs map to
 * series 073.
 */

import { expect } from "bun:test";
import { defineDifferential } from "./_support/differential";

const RISKY = `function risky(n: number): number {
  if (n < 0) { throw new Error("neg"); }
  return n * 2;
}
`;

defineDifferential("value-yielding-try-finally", [
  {
    name: "CR1 `try { return f() } finally { F }` runs finally then returns",
    src: `${RISKY}function work(n: number): number {
  try { return risky(n); } finally { console.log("cleanup"); }
}
function driver(n: number): number {
  try { return work(n); } catch (e) { return 42; }
}
console.log(driver(3));
console.log(driver(-1));`,
    expected: "cleanup\n6\ncleanup\n42",
    // The carrier lowering, not the labeled-block finally path.
    extra: ({ rust }) => expect(rust).toContain("enum Ctrl"),
  },
  {
    name: "CR2 `try/finally` no catch, body throws → finally then propagate",
    src: `${RISKY}function work(n: number): number {
  try { return risky(n); } finally { console.log("fin"); }
}
function driver(): number {
  try { return work(-1); } catch (e) { return 7; }
}
console.log(driver());`,
    expected: "fin\n7",
  },
  {
    name: "CB1 `break outer` inside try runs finally then breaks",
    src: `function scan(xs: Array<number>): number {
  let seen: number = 0;
  outer: for (let i = 0; i < xs.length; i = i + 1) {
    try {
      if (xs[i] === 0) { break outer; }
    } finally { console.log("step"); }
    seen = seen + 1;
  }
  return seen;
}
console.log(scan([5, 6, 0, 9]));`,
    expected: "step\nstep\nstep\n2",
  },
  {
    name: "CC1 `continue outer` inside try runs finally then continues",
    src: `function count(xs: Array<number>): number {
  let ok: number = 0;
  outer: for (let i = 0; i < xs.length; i = i + 1) {
    try {
      if (xs[i] < 0) { continue outer; }
    } finally { console.log("f"); }
    ok = ok + 1;
  }
  return ok;
}
console.log(count([1, -2, 3, -4, 5]));`,
    expected: "f\nf\nf\nf\nf\n3",
  },
  {
    name: "CB2 unlabeled `break` inside try runs finally then breaks",
    src: `function sumUntilZero(xs: Array<number>): number {
  let sum: number = 0;
  for (let i = 0; i < xs.length; i = i + 1) {
    try {
      if (xs[i] === 0) { break; }
      sum = sum + xs[i];
    } finally { console.log("f"); }
  }
  return sum;
}
console.log(sumUntilZero([3, 4, 0, 9]));`,
    expected: "f\nf\nf\n7",
  },
  {
    name: "CX1 catch-arm return + finally runs catch, finally, then returns",
    src: `${RISKY}function safe(n: number): number {
  try { return risky(n); } catch (e) { return 1; } finally { console.log("f"); }
}
console.log(safe(4));
console.log(safe(-1));`,
    expected: "f\n8\nf\n1",
  },
  {
    name: "CS1 self-escaping finally return masks the pending return",
    src: `function pick(): number {
  try { return 1; } finally { return 2; }
}
console.log(pick());`,
    expected: "2",
  },
  {
    name: "CS2 self-escaping finally throw masks the pending return",
    src: `function pick(): number {
  try { return 1; } finally { throw new Error("boom"); }
}
function driver(): number {
  try { return pick(); } catch (e) { return -9; }
}
console.log(driver());`,
    expected: "-9",
  },
  {
    name: "CN1 nested finally+escape runs inner then outer finally",
    src: `function work(): number {
  try {
    try { return 1; } finally { console.log("F1"); }
  } finally { console.log("F2"); }
}
function driver(): number {
  try { return work(); } catch (e) { return 0; }
}
console.log(driver());`,
    expected: "F1\nF2\n1",
  },
  {
    name: "RG1 `finally` without an escape stays on 063's labeled block",
    src: `${RISKY}function work(n: number): number {
  let result: number = 0;
  try { result = risky(n); } finally { console.log("cleanup"); }
  return result;
}
console.log(work(3));`,
    expected: "cleanup\n6",
    extra: ({ rust }) => expect(rust).not.toContain("enum Ctrl"),
  },
  {
    name: "RG2 an escape without a `finally` stays on 063's labeled block",
    src: `${RISKY}function classify(n: number): number {
  try { return risky(n); } catch (e) { return -1; }
}
console.log(classify(5), classify(-1));`,
    expected: "10 -1",
    extra: ({ rust }) => expect(rust).not.toContain("enum Ctrl"),
  },
]);
