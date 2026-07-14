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
 * docs/work/073-finally-escape-carrier/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { runRust } from "../src/harness";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

function runTs(src: string): string {
  const proc = Bun.spawnSync(["bun", "run", "-"], {
    stdin: new TextEncoder().encode(src),
  });
  return new TextDecoder().decode(proc.stdout).trim();
}

async function behaves(src: string, expected: string): Promise<void> {
  const rust = compile(src);
  const rr = await runRust(rust);
  expect(rr.ok).toBe(true);
  expect(rr.stdout.trim()).toBe(runTs(src));
  expect(rr.stdout.trim()).toBe(expected);
}

const RISKY = `function risky(n: number): number {
  if (n < 0) { throw new Error("neg"); }
  return n * 2;
}
`;

describe("073 finally + escaping jump (carrier)", () => {
  test("CR1 `try { return f() } finally { F }` runs finally then returns", async () => {
    const src = `${RISKY}function work(n: number): number {
  try { return risky(n); } finally { console.log("cleanup"); }
}
function driver(n: number): number {
  try { return work(n); } catch (e) { return 42; }
}
console.log(driver(3));
console.log(driver(-1));`;
    await behaves(src, "cleanup\n6\ncleanup\n42");
    // The carrier lowering, not the labeled-block finally path.
    expect(compile(src)).toContain("enum Ctrl");
  });

  test("CR2 `try/finally` no catch, body throws → finally then propagate", async () => {
    const src = `${RISKY}function work(n: number): number {
  try { return risky(n); } finally { console.log("fin"); }
}
function driver(): number {
  try { return work(-1); } catch (e) { return 7; }
}
console.log(driver());`;
    await behaves(src, "fin\n7");
  });

  test("CB1 `break outer` inside try runs finally then breaks", async () => {
    const src = `function scan(xs: Array<number>): number {
  let seen: number = 0;
  outer: for (let i = 0; i < xs.length; i = i + 1) {
    try {
      if (xs[i] === 0) { break outer; }
    } finally { console.log("step"); }
    seen = seen + 1;
  }
  return seen;
}
console.log(scan([5, 6, 0, 9]));`;
    await behaves(src, "step\nstep\nstep\n2");
  });

  test("CC1 `continue outer` inside try runs finally then continues", async () => {
    const src = `function count(xs: Array<number>): number {
  let ok: number = 0;
  outer: for (let i = 0; i < xs.length; i = i + 1) {
    try {
      if (xs[i] < 0) { continue outer; }
    } finally { console.log("f"); }
    ok = ok + 1;
  }
  return ok;
}
console.log(count([1, -2, 3, -4, 5]));`;
    await behaves(src, "f\nf\nf\nf\nf\n3");
  });

  test("CB2 unlabeled `break` inside try runs finally then breaks", async () => {
    const src = `function sumUntilZero(xs: Array<number>): number {
  let sum: number = 0;
  for (let i = 0; i < xs.length; i = i + 1) {
    try {
      if (xs[i] === 0) { break; }
      sum = sum + xs[i];
    } finally { console.log("f"); }
  }
  return sum;
}
console.log(sumUntilZero([3, 4, 0, 9]));`;
    await behaves(src, "f\nf\nf\n7");
  });

  test("CX1 catch-arm return + finally runs catch, finally, then returns", async () => {
    const src = `${RISKY}function safe(n: number): number {
  try { return risky(n); } catch (e) { return 1; } finally { console.log("f"); }
}
console.log(safe(4));
console.log(safe(-1));`;
    await behaves(src, "f\n8\nf\n1");
  });

  test("CS1 self-escaping finally return masks the pending return", async () => {
    const src = `function pick(): number {
  try { return 1; } finally { return 2; }
}
console.log(pick());`;
    await behaves(src, "2");
  });

  test("CS2 self-escaping finally throw masks the pending return", async () => {
    const src = `function pick(): number {
  try { return 1; } finally { throw new Error("boom"); }
}
function driver(): number {
  try { return pick(); } catch (e) { return -9; }
}
console.log(driver());`;
    await behaves(src, "-9");
  });

  test("CN1 nested finally+escape runs inner then outer finally", async () => {
    const src = `function work(): number {
  try {
    try { return 1; } finally { console.log("F1"); }
  } finally { console.log("F2"); }
}
function driver(): number {
  try { return work(); } catch (e) { return 0; }
}
console.log(driver());`;
    await behaves(src, "F1\nF2\n1");
  });

  test("RG1 `finally` without an escape stays on 063's labeled block", async () => {
    const src = `${RISKY}function work(n: number): number {
  let result: number = 0;
  try { result = risky(n); } finally { console.log("cleanup"); }
  return result;
}
console.log(work(3));`;
    await behaves(src, "cleanup\n6");
    expect(compile(src)).not.toContain("enum Ctrl");
  });

  test("RG2 an escape without a `finally` stays on 063's labeled block", async () => {
    const src = `${RISKY}function classify(n: number): number {
  try { return risky(n); } catch (e) { return -1; }
}
console.log(classify(5), classify(-1));`;
    await behaves(src, "10 -1");
    expect(compile(src)).not.toContain("enum Ctrl");
  });
});
