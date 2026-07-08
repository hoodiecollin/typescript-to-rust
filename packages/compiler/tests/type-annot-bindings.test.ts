/**
 * Specs for series 046a — untyped scalar bindings. An untyped `let`/`const` is
 * allowed iff its initializer is a *statically-obvious* scalar literal (number /
 * string / boolean); every other untyped binding (call, binary, unary-negative,
 * `null`/`undefined`, bare identifier) now fails loud with `UnsupportedError`
 * instead of silently leaking an un-checked `ty = null` to Rust's inference.
 *
 * The gate only *validates* — it leaves `ty = null` untouched, so the usize/i64
 * refinement in `numeric.ts` still keys on the binding name (TYP8).
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

describe("046a untyped scalar bindings lower", () => {
  test("TYP1 an untyped number binding lowers (Rust infers f64)", async () => {
    const src = `const n = 5;\nconsole.log(n);`;
    await behaves(src, "5");
    // No type annotation is emitted — Rust infers the binding.
    expect(compile(src)).toContain("let n = 5");
    expect(compile(src)).not.toContain("let n:");
  });

  test("TYP2 an untyped string binding lowers (String)", async () => {
    await behaves(`const s = "hi";\nconsole.log(s);`, "hi");
  });

  test("TYP3 an untyped boolean binding lowers (bool)", async () => {
    await behaves(`const b = true;\nconsole.log(b);`, "true");
  });
});

describe("046a untyped non-literal bindings fail loud", () => {
  test("TYP4 a call initializer with no annotation is rejected", () => {
    expect(() =>
      compile(`function f(): number { return 1; }\nconst x = f();`),
    ).toThrow(UnsupportedError);
  });

  test("TYP5 a binary-expression initializer with no annotation is rejected", () => {
    expect(() => compile(`const a = 1;\nconst b = 2;\nconst x = a + b;`)).toThrow(
      UnsupportedError,
    );
  });

  test("TYP6 a unary-negative initializer with no annotation is rejected", () => {
    expect(() => compile(`const x = -5;`)).toThrow(UnsupportedError);
  });

  test("TYP7 `null`/`undefined` initializers with no annotation are rejected", () => {
    expect(() => compile(`const x = null;`)).toThrow(UnsupportedError);
    expect(() => compile(`const y = undefined;`)).toThrow(UnsupportedError);
  });
});

describe("046a numeric-refinement interaction", () => {
  test("TYP8 an untyped trivial-literal index still refines to usize", async () => {
    const src = `const i = 0;\nconst arr = [10, 20];\nconsole.log(arr[i]);`;
    await behaves(src, "10");
    // The gate left `ty = null`, so the usize fixpoint could still retype `i`.
    expect(compile(src)).toContain("let i: usize = 0");
  });
});
