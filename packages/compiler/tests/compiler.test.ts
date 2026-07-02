/**
 * Compiler tests, driven by the verification harness.
 *
 * Oracle = a real Rust toolchain, in two tiers:
 *   1. COMPILES — emit Rust for a fixture, assert `cargo check` accepts it.
 *   2. BEHAVES  — run a complete TS program and the emitted Rust, assert their
 *                 stdout matches (differential testing).
 *
 * `SUPPORTED` lists the fixtures the emitter handles today; they must compile.
 * Every other fixture under `fixtures/` is a dialect target not yet implemented
 * and is registered as `test.todo`, so it shows up as pending work and flips to
 * a real test the moment the feature lands. There is no hand-written `.rs`
 * golden file anywhere — that oracle is gone.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { checkRust, runRust, summarizeErrors } from "../src/harness";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

/** Fixtures whose emitted Rust must compile today. */
const SUPPORTED = new Set([
  "01_variables/01_primitives",
  "01_variables/02_mutability",
  "02_control_flow/01_if_else",
  "02_control_flow/02_while_loop",
  "02_control_flow/03_for_loop",
  "02_control_flow/04_for_of_loop",
  "02_control_flow/05_switch",
  "03_functions/01_basic",
  "04_data_structures/01_arrays",
  "04_data_structures/02_records",
  "04_data_structures/03_variable_index",
  "10_ownership/01_borrow",
  "10_ownership/02_mut_borrow",
  "10_ownership/03_move",
  "10_ownership/04_str_borrow",
]);

function listFixtures(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFixtures(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

function emitFixture(tsPath: string): string {
  const source = readFileSync(tsPath, "utf8");
  const parsed = parseSync(tsPath, source);
  return emit(parsed.program as unknown as Program);
}

describe("fixtures compile (tier 1: COMPILES)", () => {
  const fixtures = listFixtures(FIXTURES_DIR).sort();

  for (const tsPath of fixtures) {
    const name = relative(FIXTURES_DIR, tsPath).replace(/\.ts$/, "");

    if (!SUPPORTED.has(name)) {
      test.todo(`${name} (dialect target — emitter support pending)`, () => {});
      continue;
    }

    test(`${name}`, async () => {
      const rust = emitFixture(tsPath);
      const result = await checkRust(rust);
      if (!result.ok) {
        throw new Error(
          `emitted Rust did not compile:\n${rust}\n\ncargo:\n${summarizeErrors(result)}`,
        );
      }
      expect(result.ok).toBe(true);
    });
  }
});

describe("programs behave (tier 2: BEHAVES — differential)", () => {
  test("functions + variables + console.log produce identical stdout", async () => {
    const ts = [
      `function add(a: number, b: number): number {`,
      `  return a + b;`,
      `}`,
      `const result: number = add(2, 3);`,
      `console.log(result);`,
    ].join("\n");

    // Reference output: run the TypeScript itself with Bun.
    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    // Candidate output: emit Rust and run it.
    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("5");
  });

  test("variable array indexing yields the same element (numeric inference)", async () => {
    const ts = [
      `const arr: Array<number> = [10, 20, 30];`,
      `const i: number = 1;`,
      `const x: number = arr[i];`,
      `console.log(x);`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("20");
  });

  test("a read-only string param is borrowed and prints the same (&str)", async () => {
    const ts = [
      `function greet(name: string): void {`,
      `  console.log(name);`,
      `}`,
      `const person: string = "Ada";`,
      `greet(person);`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("Ada");
  });

  test("if / else if / else classifies each branch identically", async () => {
    const ts = [
      `function check(x: number): string {`,
      `  if (x > 0) {`,
      `    return "positive";`,
      `  } else if (x < 0) {`,
      `    return "negative";`,
      `  } else {`,
      `    return "zero";`,
      `  }`,
      `}`,
      // `0 - 3` (not the literal `-3`): unary minus is a separate, unshipped
      // gap — keep this differential focused on control flow, in-dialect.
      `console.log(check(5));`,
      `console.log(check(0 - 3));`,
      `console.log(check(0));`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("positive\nnegative\nzero");
  });

  test("a while loop counts to the same value", async () => {
    const ts = [
      `function countUp(): number {`,
      `  let i: number = 0;`,
      `  while (i < 10) {`,
      `    i = i + 1;`,
      `  }`,
      `  return i;`,
      `}`,
      `console.log(countUp());`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("10");
  });

  test("a switch classifies each case identically (→ match)", async () => {
    const ts = [
      `function classify(x: number): string {`,
      `  switch (x) {`,
      `    case 1: return "one";`,
      `    case 2: return "two";`,
      `    default: return "other";`,
      `  }`,
      `}`,
      `console.log(classify(1));`,
      `console.log(classify(2));`,
      `console.log(classify(9));`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("one\ntwo\nother");
  });

  test("a while loop `break`s early at the same point", async () => {
    const ts = [
      `function firstFive(): number {`,
      `  let i: number = 0;`,
      `  while (i < 100) {`,
      `    if (i === 5) { break; }`,
      `    i = i + 1;`,
      `  }`,
      `  return i;`,
      `}`,
      `console.log(firstFive());`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("5");
  });

  test("a while loop `continue`s over one value identically", async () => {
    const ts = [
      `function sumSkip3(): number {`,
      `  let i: number = 0;`,
      `  let sum: number = 0;`,
      `  while (i < 5) {`,
      `    i = i + 1;`,
      `    if (i === 3) { continue; }`,
      `    sum = sum + i;`,
      `  }`,
      `  return sum;`,
      `}`,
      `console.log(sumSkip3());`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("12");
  });

  test("a for…of loop `continue`s past later elements identically", async () => {
    // Skip by a local counter, not by comparing the element: a `for…of` element
    // binds as `&T`, and `&f64 == f64` has no impl (a deferred for…of
    // element-ergonomics gap, orthogonal to `continue`).
    const ts = [
      `function sumFirstTwo(arr: Array<number>): number {`,
      `  let total: number = 0;`,
      `  let count: number = 0;`,
      `  for (const v of arr) {`,
      `    count = count + 1;`,
      `    if (count > 2) { continue; }`,
      `    total = total + v;`,
      `  }`,
      `  return total;`,
      `}`,
      `console.log(sumFirstTwo([1, 2, 3]));`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("3");
  });

  test("a for…of loop sums an array to the same value", async () => {
    const ts = [
      `function sumArray(arr: Array<number>): number {`,
      `  let total: number = 0;`,
      `  for (const val of arr) {`,
      `    total = total + val;`,
      `  }`,
      `  return total;`,
      `}`,
      `console.log(sumArray([1, 2, 3]));`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("6");
  });

  test("a record builds a HashMap and looks up the same value", async () => {
    const ts = [
      `const scores: Record<string, number> = { "ada": 10, "linus": 7 };`,
      `const ada: number = scores["ada"];`,
      `console.log(ada);`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("10");
  });

  test("a C-style for loop sums to the same value", async () => {
    const ts = [
      `function sum(): number {`,
      `  let total: number = 0;`,
      `  for (let i: number = 0; i < 5; i = i + 1) {`,
      `    total = total + i;`,
      `  }`,
      `  return total;`,
      `}`,
      `console.log(sum());`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("10");
  });
});
