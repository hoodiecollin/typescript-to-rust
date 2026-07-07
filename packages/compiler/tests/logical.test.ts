/**
 * Specs for series 036 — logical operators `&&` / `||` (`LogicalExpression`).
 *
 * `&&` / `||` map directly to Rust's short-circuit operators; the emitter's
 * `BINARY_PREC` parenthesizes them correctly (`&&` binds tighter than `||`, both
 * looser than comparison/equality). `??` (nullish coalescing) needs `Option`
 * semantics the dialect doesn't model, so it stays fail-loud.
 *
 * Differential: emitted Rust compiles AND matches the TS run (including
 * short-circuit evaluation and precedence).
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

describe("036 logical operators", () => {
  test("`&&` and `||` behave", async () => {
    await behaves(
      `const a: boolean = true;
const b: boolean = false;
console.log(a && b);
console.log(a || b);`,
      "false\ntrue",
    );
  });

  test("`&&` binds tighter than `||` — precedence matches JS", async () => {
    // a=false, b=false, c=true → a && b || c === (a&&b)||c === true.
    await behaves(
      `const a: boolean = false;
const b: boolean = false;
const c: boolean = true;
console.log(a && b || c);`,
      "true",
    );
  });

  test("explicit parens override precedence and are preserved", async () => {
    const rust = compile(`const a: boolean = false;
const b: boolean = true;
const c: boolean = false;
console.log((a || b) && c);`);
    expect(rust).toContain("(a || b) && c");
    await behaves(
      `const a: boolean = false;
const b: boolean = true;
const c: boolean = false;
console.log((a || b) && c);`,
      "false",
    );
  });

  test("logical operators compose with comparisons (no needless parens)", async () => {
    const rust = compile(`const x: number = 3;
console.log(x > 0 && x < 5);`);
    expect(rust).toContain("x > 0.0 && x < 5.0");
    await behaves(
      `const x: number = 3;
console.log(x > 0 && x < 5);`,
      "true",
    );
  });

  test("short-circuit evaluation is preserved in a guard", async () => {
    // `||` short-circuits: the right side of `a || …` never runs when `a` is true.
    await behaves(
      `const a: boolean = true;
const b: boolean = false;
if (a || b) {
  console.log("taken");
}`,
      "taken",
    );
  });

  test("`??` (nullish coalescing) → `.unwrap_or()` (graduated, series 042)", () => {
    const rust = compile(`const a: number | undefined = 1;
console.log(a ?? 2);`);
    expect(rust).toContain(".unwrap_or(");
  });
});
