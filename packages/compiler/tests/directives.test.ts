/**
 * Specs for series 028a — the `"use panic"` per-scope directive. A leading
 * string-literal directive switches a scope's `throw` translation from the
 * default `Result`/`?` fallibility model (021–023) to `panic!` — the function is
 * NOT `-> Result`, and callers need not `?`.
 *
 * An unrecognized `"use …"` directive fails loud (`DialectError`), never a
 * silent no-op.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { DialectError } from "../src/errors";
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

describe("028a use panic", () => {
  const risky = `function risky(bad: boolean): number {
  "use panic";
  if (bad) throw new Error("boom");
  return 42;
}
console.log(risky(false));`;

  test("throw in a `use panic` scope compiles + behaves on the success path", async () => {
    await behaves(risky, "42");
  });

  test("the fn is infallible (no Result), the throw is a panic!, no directive string leaks", () => {
    const rust = compile(risky);
    expect(rust).toContain("panic!");
    expect(rust).toContain("fn risky(bad: bool) -> f64");
    expect(rust).not.toContain("Result");
    expect(rust).not.toContain('"use panic"');
  });

  test("a caller of a `use panic` fn does not `?`-propagate", () => {
    const rust = compile(risky);
    // main stays a plain `fn main()` — no `-> Result`, no `?` on the call.
    expect(rust).toContain("fn main() {");
    expect(rust).not.toContain("risky(false)?");
  });

  test("an unrecognized directive fails loud", () => {
    expect(() => compile(`function f(): void { "use frobnicate"; }`)).toThrow(
      DialectError,
    );
  });
});
