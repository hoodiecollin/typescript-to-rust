/**
 * Unit tests for the ownership/mutability analysis (side-table spike). These
 * pin the inference rules directly; the fixture tests then prove the emitted
 * Rust actually compiles.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import {
  type ModuleAnalysis,
  SCRIPT_SCOPE,
  analyzeModule,
} from "../src/analysis";
import type { Program } from "../src/ast";

function analyze(src: string): ModuleAnalysis {
  return analyzeModule(parseSync("t.ts", src).program as unknown as Program);
}

describe("parameter ownership inference", () => {
  test("read-only non-Copy param → &T (ref)", () => {
    const a = analyze(
      `function f(arr: Array<number>): void { console.log(arr.length); }`,
    );
    expect(a.fns.get("f")?.params[0]?.ownership).toBe("ref");
  });

  test("mutated param → &mut T (refMut)", () => {
    const a = analyze(`function f(arr: Array<number>): void { arr.push(0); }`);
    expect(a.fns.get("f")?.params[0]?.ownership).toBe("refMut");
  });

  test("unused param → T (move)", () => {
    const a = analyze(`function f(arr: Array<number>): void {}`);
    expect(a.fns.get("f")?.params[0]?.ownership).toBe("move");
  });

  test("Copy param (number) is always by value", () => {
    const a = analyze(`function f(n: number): number { return n + 1; }`);
    const p = a.fns.get("f")?.params[0];
    expect(p?.isCopy).toBe(true);
    expect(p?.ownership).toBe("move");
  });
});

describe("local mutability inference", () => {
  test("reassigned local is mut", () => {
    const a = analyze(`let x: number = 0; x = 1;`);
    expect(a.mut.get(SCRIPT_SCOPE)?.has("x")).toBe(true);
  });

  test("never-mutated local is not mut", () => {
    const a = analyze(`const x: number = 0;`);
    expect(a.mut.get(SCRIPT_SCOPE)?.has("x")).toBe(false);
  });

  test("local passed at a &mut position becomes mut", () => {
    const a = analyze(
      `function g(arr: Array<number>): void { arr.push(0); }\n` +
        `const numbers: Array<number> = [1]; g(numbers);`,
    );
    expect(a.mut.get(SCRIPT_SCOPE)?.has("numbers")).toBe(true);
  });

  test("local passed at a move position stays immutable", () => {
    const a = analyze(
      `function g(arr: Array<number>): void {}\n` +
        `const numbers: Array<number> = [1]; g(numbers);`,
    );
    expect(a.mut.get(SCRIPT_SCOPE)?.has("numbers")).toBe(false);
  });
});
