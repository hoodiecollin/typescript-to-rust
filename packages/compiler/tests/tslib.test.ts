/**
 * Specs for series 027 (first slice) — the `tslib` fidelity crate + hybrid
 * routing. Quirk-heavy library methods route to `tslib` (JS semantics live in one
 * audited crate); clean methods stay native. Also covers unary `-`/`!` support,
 * the prerequisite for `at(-1)`.
 *
 * Differential: emitted Rust compiles (linking `tslib`) AND matches the TS run.
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

describe("unary operators", () => {
  test("negation on a numeric literal", async () => {
    await behaves(
      `const x: number = -5;
console.log(x);`,
      "-5",
    );
  });

  test("negation of a parenthesized sum keeps its parens", async () => {
    await behaves(`console.log(-(3 + 4));`, "-7");
  });

  test("logical not on a boolean", async () => {
    await behaves(
      `const b: boolean = true;
console.log(!b);`,
      "false",
    );
  });
});

describe("027 tslib routing", () => {
  test("Array.at with a negative index → last element (tslib)", async () => {
    await behaves(
      `const xs: Array<number> = [10, 20, 30];
console.log(xs.at(-1));`,
      "30",
    );
    // The route is tslib, not native indexing.
    expect(
      compile(
        `const xs: Array<number> = [10, 20, 30];\nconsole.log(xs.at(-1));`,
      ),
    ).toContain("tslib::array::at");
  });

  test("Array.at with a positive index (tslib)", async () => {
    await behaves(
      `const xs: Array<number> = [10, 20, 30];
console.log(xs.at(1));`,
      "20",
    );
  });

  test("String.padStart left-pads (tslib)", async () => {
    await behaves(`console.log("5".padStart(3, "0"));`, "005");
  });

  test("String.padEnd right-pads (tslib)", async () => {
    await behaves(`console.log("5".padEnd(3, "0"));`, "500");
  });
});
