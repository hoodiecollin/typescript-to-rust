/**
 * Specs for series 063 — value-yielding `try`/`catch` + control-flow escape. The
 * escaping/value-yielding `try`/`catch` lowers to a Rust **labeled block** (not the
 * 021 IIFE closure), so native `return`/`break`/`continue` in the arms escape the
 * enclosing fn/loop; `?`/`throw` in the `try` body become `break '<label> Err(…)`.
 * `try`/`finally` with no `catch` runs `finally` then propagates. `finally`
 * combined with an escaping jump stays fail-loud (carrier-enum follow-on).
 *
 * Each spec differential-matches (compile → cargo run → TS-via-Bun). IDs map to
 * series 063.
 */

import { expect } from "bun:test";
import { defineDifferential } from "./_support/differential";

const RISKY = `function risky(n: number): number {
  if (n < 0) { throw new Error("neg"); }
  return n * 2;
}
`;

defineDifferential("value-yielding-try", [
  {
    name: "VY1 `try { return f() } catch { return d }` yields via native return",
    src: `${RISKY}function classify(n: number): number {
  try { return risky(n); } catch (e) { return -1; }
}
console.log(classify(5), classify(-1));`,
    expected: "10 -1",
    extra: ({ rust }) => {
      expect(rust).toContain("'try_0: {");
      expect(rust).toContain("break 'try_0 Err(");
    },
  },
  {
    name: "VY2 the catch value flows through a native return",
    src: `${RISKY}function safe(n: number): number {
  try { const v: number = risky(n); return v + 1; } catch (e) { return 0; }
}
console.log(safe(3), safe(-5));`,
    expected: "7 0",
  },
  {
    name: "ESC1 `break` inside `try` escapes the enclosing loop",
    src: `${RISKY}function countUntilBad(xs: Array<number>): number {
  let count: number = 0;
  for (let i = 0; i < xs.length; i = i + 1) {
    try { risky(xs[i]); } catch (e) { break; }
    count = count + 1;
  }
  return count;
}
console.log(countUntilBad([1, 2, -3, 4]));`,
    expected: "2",
    extra: ({ rust }) => expect(rust).toContain("break;"),
  },
  {
    name: "ESC2 `continue` inside `try` advances the enclosing loop",
    src: `${RISKY}function countOk(xs: Array<number>): number {
  let ok: number = 0;
  for (let i = 0; i < xs.length; i = i + 1) {
    try { risky(xs[i]); } catch (e) { continue; }
    ok = ok + 1;
  }
  return ok;
}
console.log(countOk([1, -2, 3, -4, 5]));`,
    expected: "3",
  },
  {
    name: "FIN1 `try`/`finally` with no catch runs finally then propagates",
    src: `${RISKY}function work(n: number): number {
  let result: number = 0;
  try { result = risky(n); } finally { console.log("cleanup"); }
  return result;
}
function driver(): number {
  try { return work(-1); } catch (e) { return 42; }
}
console.log(work(3));
console.log(driver());`,
    expected: "cleanup\n6\ncleanup\n42",
  },
  {
    name: "RETHROW re-throw in catch (no finally) propagates",
    src: `${RISKY}function pass(n: number): number {
  try { return risky(n); } catch (e) { throw new Error("wrapped"); }
}
function driver(n: number): number {
  try { return pass(n); } catch (e) { return -7; }
}
console.log(driver(4), driver(-1));`,
    expected: "8 -7",
  },
  {
    name: "FL1 `finally` combined with an escaping return is now the 073 carrier",
    // 063's sole deferred residual — graduated by series 073 to the control
    // carrier (differential coverage lives in value-yielding-try-finally.test.ts).
    src: `${RISKY}function bad(n: number): number {
  try { return risky(n); } catch (e) { return 0; } finally { console.log("f"); }
}
console.log(bad(1));`,
    expected: "f\n2",
    extra: ({ rust }) => expect(rust).toContain("enum Ctrl"),
  },
]);
