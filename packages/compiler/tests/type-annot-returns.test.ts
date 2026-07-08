/**
 * Specs for series 046c — mandatory return types. A *missing* return type used
 * to default silently to `-> ()`; it now fails loud (`UnsupportedError`) on
 * functions, methods, and `const`-bound arrows. An explicit `: void` still
 * lowers to `-> ()`, and an annotated return still works.
 *
 * IDs map to docs/work/046-type-annotation-enforcement/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { runRust } from "../src/harness";
import { UnsupportedError } from "../src/lower";

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

describe("046c missing return types fail loud", () => {
  test("TYP15 a function with no return type is rejected", () => {
    expect(() => compile(`function f(x: number) { return x; }`)).toThrow(
      UnsupportedError,
    );
  });

  test("TYP18 a method with no return type is rejected", () => {
    expect(() =>
      compile(`class C { m(x: number) { return x; } }`),
    ).toThrow(UnsupportedError);
  });

  test("TYP19 a const-bound arrow with no return type is rejected", () => {
    expect(() => compile(`const f = (x: number) => x;`)).toThrow(
      UnsupportedError,
    );
  });
});

describe("046c explicit and annotated returns still lower", () => {
  test("TYP16 an explicit `: void` lowers to a unit fn (return arrow elided)", async () => {
    const src = `function log(x: number): void { console.log(x); }\nlog(7);`;
    await behaves(src, "7");
    // `: void` → `UNIT`; the emitter idiomatically elides a `-> ()` return.
    expect(compile(src)).toContain("fn log(x: f64) {");
    expect(compile(src)).not.toContain("->");
  });

  test("TYP17 an annotated return still works (regression)", async () => {
    await behaves(
      `function f(x: number): number { return x; }\nconsole.log(f(2));`,
      "2",
    );
  });

  test("TYP20 an annotated arrow still lowers", async () => {
    await behaves(`const f = (x: number): number => x;\nconsole.log(f(3));`, "3");
  });
});
