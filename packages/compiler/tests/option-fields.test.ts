/**
 * Specs for series 042b — optional struct fields. `field?: T` (and
 * `field: T | undefined`) → an `Option<T>` struct field; a struct literal
 * `Some`-wraps a provided value and fills an omitted optional field with `None`.
 * Differential: emitted Rust compiles AND matches the TS run. IDs → specs.md.
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

describe("042b optional struct fields", () => {
  test("OFL1 an optional field lowers to Option<T>", () => {
    const rust = compile(`interface Config { timeout?: number; }
const c: Config = { timeout: 30 };
console.log(c.timeout ?? 10);`);
    expect(rust).toContain("timeout: Option<f64>");
    expect(rust).toContain("Some(30.0)");
  });

  test("OFL2 a provided optional field is Some, an omitted one is None", async () => {
    await behaves(
      `interface Config { timeout?: number; }
const c: Config = { timeout: 30 };
const d: Config = {};
console.log(c.timeout ?? 10, d.timeout ?? 10);`,
      "30 10",
    );
    expect(
      compile(`interface Config { timeout?: number; }
const d: Config = {};
console.log(d.timeout ?? 10);`),
    ).toContain("timeout: None");
  });

  test("OFL3 T | undefined field form also lowers to Option", async () => {
    await behaves(
      `interface Box { label: string | undefined; }
const b: Box = { label: "hi" };
console.log(b.label ?? "none");`,
      "hi",
    );
  });
});
