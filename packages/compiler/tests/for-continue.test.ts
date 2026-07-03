/**
 * Specs for unblocking `continue` in a C-style `for` (series 018). Drives the
 * public `emit(...)` entry and asserts that an own `continue` runs the `update`
 * before continuing, `break` is unchanged, and the green/deferred cases hold. The
 * cargo-backed BEHAVES proof lives in compiler.test.ts. IDs map to
 * docs/work/018-for-continue/specs.md.
 *
 * RED against the existing fail-loud rejection in `lowerFor` (an own `continue`
 * in a C-style for throws "unsound while-desugar — deferred") until the
 * inline-update desugar lands.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

const occurrences = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1;

describe("for-continue: unblock continue in a C-style for", () => {
  test("FORCONT1 an own continue inlines the update before it", () => {
    const rust = compile(
      `function run(): number { let sum: number = 0;` +
        ` for (let i = 0; i < 5; i = i + 1) { if (i === 2) { continue; } sum = sum + i; }` +
        ` return sum; }`,
    );
    expect(rust).toContain("continue;");
    // update at the continue site AND at the loop bottom → at least twice.
    expect(occurrences(rust, "i = i + 1;")).toBeGreaterThanOrEqual(2);
  });

  test("FORCONT2 a break in the same for stays a bare break", () => {
    const rust = compile(
      `function run(): number { let s: number = 0;` +
        ` for (let i = 0; i < 9; i = i + 1) { if (i === 4) { break; } if (i === 2) { continue; } s = s + i; }` +
        ` return s; }`,
    );
    expect(rust).toContain("break;");
  });

  test("FORCONT3 (green control) a for without a continue is unchanged (one update)", () => {
    const rust = compile(
      `function run(): number { let s: number = 0;` +
        ` for (let i = 0; i < 3; i = i + 1) { s = s + i; } return s; }`,
    );
    expect(occurrences(rust, "i = i + 1")).toBe(1);
  });

  test("FORCONT4 a for with no update but a continue no longer throws", () => {
    expect(() =>
      compile(
        `function run(): number { let s: number = 0; let i: number = 0;` +
          ` for (; i < 3;) { i = i + 1; if (i === 2) { continue; } s = s + i; }` +
          ` return s; }`,
      ),
    ).not.toThrow();
  });
});
