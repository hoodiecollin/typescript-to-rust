/**
 * Specs for series 052d — generator state-machine fail-loud residuals
 * (GEN10-12). The owned Option-A model captures every carried value **by value**
 * in the struct, so the hard cases are the ones that can't be owned across a
 * suspend (a borrowed/non-owned param) or have no clean state-machine encoding
 * (a `yield` inside a `try`/`catch`). GEN12 guards that the 035 straight-line
 * path is not regressed.
 *
 * IDs map to series 052.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

describe("052d generator state machines — fail-loud residuals", () => {
  test("GEN10 (fail-loud) a non-owned (borrowed) value carried across a yield is rejected", () => {
    // The owned generator struct can't hold a borrow across a suspend (it would
    // need a lifetime-bearing / self-referential struct). A borrowed param — the
    // concrete manifestation in the owned model — stays `UnsupportedError`.
    const src = `function* g(s: string, n: number): Generator<string> {
  for (let i = 0; i < n; i = i + 1) { yield s; }
}
for (const x of g("a", 2)) { console.log(x); }`;
    expect(() => compile(src)).toThrow(/borrowed \(non-owned\) parameter/);
  });

  test("GEN11 (fail-loud) a `yield` inside a `try`/`catch` stays UnsupportedError", () => {
    const src = `function* g(n: number): Generator<number> {
  for (let i = 0; i < n; i = i + 1) {
    try { yield i; } catch (e) { console.log("err"); }
  }
}
for (const x of g(2)) { console.log(x); }`;
    expect(() => compile(src)).toThrow(/state-machine generator/);
  });

  test("GEN12 (regression) the 035 straight-line finite generator stays `vec![…].into_iter()`, not a state machine", () => {
    const src = `function* g(): Generator<number> { yield 1; yield 2; yield 3; }
for (const x of g()) { console.log(x); }`;
    const rust = compile(src);
    expect(rust).toContain("into_iter");
    expect(rust).not.toContain("match self.state");
  });
});
