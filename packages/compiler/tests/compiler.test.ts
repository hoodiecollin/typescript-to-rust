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
  "03_functions/02_arrow",
  "04_data_structures/01_arrays",
  "04_data_structures/02_records",
  "04_data_structures/03_variable_index",
  "05_interfaces/01_basic",
  "06_classes/01_basic",
  "07_async/01_async_await",
  "08_errors/01_throw",
  "08_errors/02_try_catch",
  "08_errors/03_custom_error",
  "08_errors/04_method_throw",
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

  test("an interface builds a struct and reads the same field", async () => {
    const ts = [
      `interface Point {`,
      `  x: number;`,
      `  y: number;`,
      `}`,
      `const p: Point = { x: 10, y: 20 };`,
      `console.log(p.x);`,
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

  test("a class constructs, mutates via a method, and reads the same field", async () => {
    const ts = [
      `class Counter {`,
      `  count: number;`,
      `  constructor(start: number) { this.count = start; }`,
      `  increment(): void { this.count = this.count + 1; }`,
      `}`,
      `const c: Counter = new Counter(1);`,
      `c.increment();`,
      `c.increment();`,
      `console.log(c.count);`,
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

  test("throwing functions propagate via `?` on the success path (→ Result)", async () => {
    // Both throwing branches stay untaken, so the two runtimes agree; this
    // exercises the return-type wrap, Err/Ok wrapping, the trailing Ok(()) (the
    // void `announce` and `main`), and `?` propagation through `main`.
    const ts = [
      `function half(n: number): number {`,
      `  if (n < 0) { throw new Error("negative"); }`,
      `  return n / 2;`,
      `}`,
      `function announce(n: number): void {`,
      `  if (n < 0) { throw new Error("negative n"); }`,
      `  console.log(n);`,
      `}`,
      `announce(7);`,
      `const x: number = half(10);`,
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
    expect(rustRun.stdout.trim()).toBe("7\n5");
  });

  test("a top-level await drives an async runtime main (→ #[tokio::main])", async () => {
    // Exercises `async fn`, the `Promise<string>` → `String` unwrap, `.await`
    // (both the nested call and the top-level one), and `#[tokio::main] async fn
    // main()`. The two async functions are ordinary computations marked async.
    const ts = [
      `async function doFetch(id: number): Promise<string> {`,
      `  return "row";`,
      `}`,
      `async function fetchData(id: number): Promise<string> {`,
      `  const res: string = await doFetch(id);`,
      `  return res;`,
      `}`,
      `const out: string = await fetchData(1);`,
      `console.log(out);`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("row");
  });

  test("top-level const arrows lower to free fns and behave (block + expr body)", async () => {
    // A block-body arrow and an expression-body arrow, both normalized to free
    // `fn`s and called from the generated `main` — exercises the `return`
    // desugar and call-site argument adaptation.
    const ts = [
      `const sub = (a: number, b: number): number => {`,
      `  return a - b;`,
      `};`,
      `const add = (a: number, b: number): number => a + b;`,
      `console.log(sub(10, 3));`,
      `console.log(add(4, 5));`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("7\n9");
  });

  test("generalized throws (subclass + string literal) compile and behave", async () => {
    // Untaken branches throw a RangeError and a bare string; the success path
    // returns. Exercises both new throw forms in one compiling Result program.
    const ts = [
      `function classify(n: number): string {`,
      `  if (n < 0) { throw new RangeError("negative"); }`,
      `  if (n === 0) { throw "zero not allowed"; }`,
      `  return "positive";`,
      `}`,
      `console.log(classify(5));`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("positive");
  });

  test("a fallible async fn awaits and propagates via .await? on the success path", async () => {
    // risky throws only for n < 0; caller awaits it; the top-level await drives a
    // fallible tokio main. Exercises `async fn … -> Result`, `.await?`, and
    // `#[tokio::main] async fn main() -> Result<(), String>` on the success path.
    const ts = [
      `async function risky(n: number): Promise<number> {`,
      `  if (n < 0) { throw new Error("negative"); }`,
      `  return n / 2;`,
      `}`,
      `async function caller(n: number): Promise<number> {`,
      `  const x: number = await risky(n);`,
      `  return x;`,
      `}`,
      `const r: number = await caller(10);`,
      `console.log(r);`,
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

  test("a C-style for with mixed break + continue behaves identically", async () => {
    const ts = [
      `function pick(): number {`,
      `  let sum: number = 0;`,
      `  for (let i = 0; i < 6; i = i + 1) {`,
      `    if (i === 3) { break; }`,
      `    if (i === 1) { continue; }`,
      `    sum = sum + i;`,
      `  }`,
      `  return sum;`,
      `}`,
      `console.log(pick());`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("2");
  });

  test("nested C-style fors each with their own continue behave (barrier)", async () => {
    const ts = [
      `function count(): number {`,
      `  let k: number = 0;`,
      `  for (let i = 0; i < 3; i = i + 1) {`,
      `    for (let j = 0; j < 3; j = j + 1) {`,
      `      if (j === 1) { continue; }`,
      `      k = k + 1;`,
      `    }`,
      `    if (i === 0) { continue; }`,
      `    k = k + 10;`,
      `  }`,
      `  return k;`,
      `}`,
      `console.log(count());`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("26");
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

  test("an integer switch emits literal-pattern arms and behaves (→ match)", async () => {
    // The discriminant retypes to `i64`; cases become bare literal patterns
    // (`1 => …`) and the integer-literal call args retype too.
    const ts = [
      `function matchNum(x: number): string {`,
      `  switch (x) {`,
      `    case 1: return "one";`,
      `    case 2: return "two";`,
      `    default: return "other";`,
      `  }`,
      `}`,
      `console.log(matchNum(1));`,
      `console.log(matchNum(2));`,
      `console.log(matchNum(9));`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    expect(rust).toContain("fn matchNum(x: i64)");
    expect(rust).toContain("1 => {");
    expect(rust).not.toContain("_ if x ==");
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("one\ntwo\nother");
  });

  test("an index-driven for promotes to `for i in 0..arr.len()` and behaves", async () => {
    const ts = [
      `function total(arr: Array<number>): number {`,
      `  let sum: number = 0;`,
      `  for (let i = 0; i < arr.length; i = i + 1) {`,
      `    sum = sum + arr[i];`,
      `  }`,
      `  return sum;`,
      `}`,
      `console.log(total([1, 2, 3, 4]));`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    expect(rust).toContain("for i in 0..arr.len()");
    expect(rust).not.toContain("while i <");
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("10");
  });

  test("a literal-bound index for promotes to `for i in 0..3` and behaves", async () => {
    const ts = [
      `function firstThree(arr: Array<number>): number {`,
      `  let sum: number = 0;`,
      `  for (let i = 0; i < 3; i = i + 1) {`,
      `    sum = sum + arr[i];`,
      `  }`,
      `  return sum;`,
      `}`,
      `console.log(firstThree([10, 20, 30, 40, 50]));`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    expect(rust).toContain("for i in 0..3");
    expect(rust).not.toContain("0.0..3.0");
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("60");
  });

  test("try/catch/finally recovers and both runtimes agree (series 021)", async () => {
    const ts = [
      `function risky(n: number): void {`,
      `  if (n < 0) { throw new Error("negative"); }`,
      `  console.log("ran");`,
      `}`,
      `function attempt(n: number): void {`,
      `  try {`,
      `    risky(n);`,
      `  } catch (e) {`,
      `    console.log("caught");`,
      `  } finally {`,
      `    console.log("done");`,
      `  }`,
      `}`,
      `attempt(5);`,
      `attempt(0 - 1);`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    // The try block is a Result-returning IIFE; `attempt` itself stays non-Result
    // (the error is caught, not propagated — fallibility shielding).
    expect(rust).toContain("(|| -> Result<(), String> {");
    expect(rust).toContain("fn attempt(n: f64) {");
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("ran\ndone\ncaught\ndone");
  });

  test("a custom error type propagates and prints the same (series 022)", async () => {
    // Success path (both runtimes agree); the boxed custom-error branch is
    // proven to compile at tier 1. A custom error class present makes the whole
    // program's error type `Box<dyn Error>`.
    const ts = [
      `class NotFoundError extends Error {`,
      `  constructor(message: string) {`,
      `    super(message);`,
      `  }`,
      `}`,
      `function lookup(id: number): number {`,
      `  if (id < 0) {`,
      `    throw new NotFoundError("no such id");`,
      `  }`,
      `  return id * 2;`,
      `}`,
      `const x: number = lookup(3);`,
      `console.log(x);`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    expect(rust).toContain("impl std::error::Error for NotFoundError {}");
    expect(rust).toContain("Result<f64, Box<dyn std::error::Error>>");
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("6");
  });

  test("throwing methods/constructors propagate and behave the same (series 023)", async () => {
    const ts = [
      `class Account {`,
      `  balance: number;`,
      `  constructor(initial: number) {`,
      `    if (initial < 0) { throw new Error("negative initial"); }`,
      `    this.balance = initial;`,
      `  }`,
      `  withdraw(amount: number): void {`,
      `    if (amount > this.balance) { throw new Error("insufficient funds"); }`,
      `    this.balance = this.balance - amount;`,
      `  }`,
      `  pay(amount: number): void {`,
      `    this.withdraw(amount);`,
      `    console.log("paid");`,
      `  }`,
      `}`,
      `const a: Account = new Account(100);`,
      `a.pay(30);`,
      `console.log(a.balance);`,
    ].join("\n");

    const tsRun = Bun.spawnSync(["bun", "run", "-"], {
      stdin: new TextEncoder().encode(ts),
    });
    const tsStdout = new TextDecoder().decode(tsRun.stdout).trim();

    const rust = emit(parseSync("prog.ts", ts).program as unknown as Program);
    // fallible ctor + method, `?`-propagated at the use sites, `pay` inferred
    // `&mut self` (it calls the mutating `withdraw`).
    expect(rust).toContain("fn new(initial: f64) -> Result<Account, String> {");
    expect(rust).toContain(
      "fn pay(&mut self, amount: f64) -> Result<(), String> {",
    );
    expect(rust).toContain("self.withdraw(amount)?");
    expect(rust).toContain("Account::new(100.0)?");
    const rustRun = await runRust(rust);

    expect(rustRun.ok).toBe(true);
    expect(rustRun.stdout.trim()).toBe(tsStdout);
    expect(rustRun.stdout.trim()).toBe("paid\n70");
  });
});
