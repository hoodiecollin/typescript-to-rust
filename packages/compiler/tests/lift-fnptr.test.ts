/**
 * Specs for series 048c — `fn`-pointer values (LIFT9–12). A function-type
 * annotation `(n: number) => number` lowers to a bare `fn`-pointer `fn(f64) ->
 * f64` (a `Copy` value, passed by value). A non-capturing top-level fn / normalized
 * arrow passed as an argument coerces to that pointer. The fail-loud boundary: an
 * inline arrow that captures an outer local as a function *value* has no pointer
 * form (`UnsupportedError`), and the shipped mutable-capture `forEach` still works
 * (it is not lifted — decision 2026-07-08).
 *
 * IDs map to docs/work/048-lambda-lifting-closures/specs.md.
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

describe("048c fn-pointer values", () => {
  test("LIFT9 a function-value param → fn(f64) -> f64; bare fn coerces", async () => {
    const src = `function double(n: number): number { return n * 2; }
function apply(f: (n: number) => number, x: number): number { return f(x); }
console.log(apply(double, 5));`;
    await behaves(src, "10");
    const rust = compile(src);
    expect(rust).toContain("f: fn(f64) -> f64");
    expect(rust).toContain("apply(double, 5.0)");
  });

  test("LIFT10 a non-capturing normalized arrow coerces to the pointer", async () => {
    const src = `function apply(f: (n: number) => number, x: number): number { return f(x); }
const inc = (n: number): number => n + 1;
console.log(apply(inc, 5));`;
    await behaves(src, "6");
    // 015's normalized arrow is a free `fn inc`, which coerces to `fn(f64) -> f64`.
    expect(compile(src)).toContain("fn inc(n: f64) -> f64");
  });

  test("LIFT11 mutable-capture forEach still works (not lifted, not rejected)", async () => {
    await behaves(
      `let total = 0;
[1, 2, 3].forEach(x => { total = total + x; });
console.log(total);`,
      "6",
    );
  });

  test("LIFT12 a capturing arrow passed as a value is fail-loud", () => {
    expect(() =>
      compile(
        `function apply(f: (n: number) => number, x: number): number { return f(x); }
const y = 3;
console.log(apply(x => x + y, 5));`,
      ),
    ).toThrow(UnsupportedError);
  });
});
