/**
 * Specs for series 042a — the Option/nullability core. `T | undefined` /
 * `T | null` / optional params → `Option<T>`; `undefined`/`null` → `None`; a
 * plain value flowing into an Option slot is `Some`-wrapped; `x ?? d` →
 * `x.unwrap_or(d)` (graduates #7). Differential: emitted Rust compiles AND
 * matches the TS run. IDs map to specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit, UnsupportedError } from "../src/emitter";
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

describe("042a Option core + ??", () => {
  test("OPT1 a present optional flows through ?? (Some-coercion)", async () => {
    const src = `const x: number | undefined = 5;
console.log(x ?? 0);`;
    await behaves(src, "5");
    const rust = compile(src);
    expect(rust).toContain("Option<f64>");
    expect(rust).toContain("Some(5.0)");
    expect(rust).toContain(".unwrap_or(");
  });

  test("OPT2 undefined → None, ?? yields the fallback", async () => {
    const src = `const x: number | undefined = undefined;
console.log(x ?? 0);`;
    await behaves(src, "0");
    expect(compile(src)).toContain("None");
  });

  test("OPT3 null also maps to None", async () => {
    await behaves(
      `const s: string | null = null;
console.log(s ?? "fb");`,
      "fb",
    );
  });

  test("OPT4 ?? passes a present value through", async () => {
    await behaves(
      `const x: number | undefined = 3;
console.log(x ?? 9);`,
      "3",
    );
  });

  test("OPT5 an optional param lowers to Option and supports ??", async () => {
    const src = `function pick(x?: number): number {
  return x ?? 42;
}
console.log(pick());`;
    await behaves(src, "42");
    expect(compile(src)).toContain("x: Option<f64>");
  });

  test("OPT6 a union of two real types is fail-loud", () => {
    expect(() =>
      compile(`const x: number | string = 5;`),
    ).toThrow(UnsupportedError);
  });
});
