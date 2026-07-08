/**
 * Specs for series 046b — homogeneous scalar arrays. The untyped-binding
 * exception widens from scalar literals to a *non-empty, same-`typeof`*
 * scalar-literal array (`[1, 2, 3]` → `Vec<f64>`, `["a", "b"]` → `Vec<String>`,
 * `[true, false]` → `Vec<bool>`). Empty, heterogeneous, and non-scalar-element
 * arrays stay fail-loud — their element type is not statically obvious in one
 * pass.
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

describe("046b homogeneous scalar arrays lower untyped", () => {
  test("TYP9 an untyped number array → Vec<f64>", async () => {
    const src = `const xs = [1, 2, 3];\nconsole.log(xs.length);`;
    await behaves(src, "3");
    expect(compile(src)).toContain("vec![1.0, 2.0, 3.0]");
  });

  test("TYP10 an untyped string array → Vec<String>", async () => {
    await behaves(`const ss = ["a", "b"];\nconsole.log(ss[0]);`, "a");
  });

  test("TYP11 an untyped bool array → Vec<bool>", async () => {
    await behaves(`const bs = [true, false];\nconsole.log(bs.length);`, "2");
  });
});

describe("046b non-obvious arrays fail loud", () => {
  test("TYP12 an empty array with no annotation is rejected", () => {
    expect(() => compile(`const xs = [];`)).toThrow(UnsupportedError);
  });

  test("TYP13 a mixed/heterogeneous array is rejected", () => {
    expect(() => compile(`const xs = [1, "a"];`)).toThrow(UnsupportedError);
  });

  test("TYP14 a non-scalar-element array is rejected", () => {
    expect(() => compile(`const xs = [[1, 2], [3]];`)).toThrow(UnsupportedError);
    expect(() =>
      compile(`function f(): number { return 1; }\nconst xs = [f(), f()];`),
    ).toThrow(UnsupportedError);
  });
});
