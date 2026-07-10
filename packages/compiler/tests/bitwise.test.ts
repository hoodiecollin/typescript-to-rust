/**
 * Specs for series 056 — bitwise operators `& | ^ ~ << >> >>>`.
 *
 * JS bitwise operators run on 32-bit ints; the dialect deliberately widens to a
 * signed `i128` (documented divergence, not JS-exact) surfaced via a non-fatal
 * warning + inline emit note. `>>>` needs an unsigned round-trip; shift counts are
 * masked so ordinary code never panics.
 *
 * Differential: emitted Rust compiles AND matches the TS run — except where the
 * dialect intentionally diverges from JS's 32-bit truncation (asserted against the
 * Rust result), a fail-loud `UnsupportedError`, or a text/warning inspection.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { runRust } from "../src/harness";
import { UnsupportedError, lower } from "../src/lower";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

function runTs(src: string): string {
  const proc = Bun.spawnSync(["bun", "run", "-"], {
    stdin: new TextEncoder().encode(src),
  });
  return new TextDecoder().decode(proc.stdout).trim();
}

/** Rust compiles and matches both the TS run and `expected`. */
async function behaves(src: string, expected: string): Promise<void> {
  const rust = compile(src);
  const rr = await runRust(rust);
  expect(rr.ok).toBe(true);
  expect(rr.stdout.trim()).toBe(runTs(src));
  expect(rr.stdout.trim()).toBe(expected);
}

/** Rust compiles and equals `expected` — used where the dialect diverges from JS. */
async function rustYields(src: string, expected: string): Promise<void> {
  const rust = compile(src);
  const rr = await runRust(rust);
  expect(rr.ok).toBe(true);
  expect(rr.stdout.trim()).toBe(expected);
}

describe("056 bitwise operators", () => {
  test("`&` `|` `^` match JS", async () => {
    await behaves(
      `const a = 6;
const b = 3;
console.log(a & b);
console.log(a | b);
console.log(a ^ b);`,
      "2\n7\n5",
    );
  });

  test("`~` (→ Rust `!`) matches JS", async () => {
    await behaves(`const a = 6;\nconsole.log(~a);`, "-7");
  });

  test("`<<` `>>` (arithmetic) match JS for in-range values", async () => {
    await behaves(
      `const a = 6;
console.log(a << 2);
console.log(a >> 1);`,
      "24\n3",
    );
  });

  test("a bitwise result flows through an untyped binding (inferred i128)", async () => {
    await behaves(
      `const a = 12;
const b = 10;
const c = a & b;
console.log(c);`,
      "8",
    );
  });

  test("precedence: `a & b | c` groups as `(a & b) | c`", async () => {
    const rust = compile(`const a = 6;\nconst b = 3;\nconst c = 8;\nconsole.log(a & b | c);`);
    // `&` binds tighter than `|`, so no parens are needed around `a & b`.
    expect(rust).toContain(") & (");
    await behaves(
      `const a = 6;\nconst b = 3;\nconst c = 8;\nconsole.log(a & b | c);`,
      // (6 & 3) | 8 = 2 | 8 = 10
      "10",
    );
  });

  test("`>>>` diverges from JS (i128, not int32) — assert the Rust result", async () => {
    // JS: -1 >>> 0 === 4294967295; our i128 dialect yields -1 (documented divergence).
    expect(runTs(`console.log(-1 >>> 0);`)).toBe("4294967295");
    await rustYields(`console.log(-1 >>> 0);`, "-1");
  });

  test("`>>>` still matches JS on an in-range value", async () => {
    await behaves(`console.log(16 >>> 2);`, "4");
  });

  test("shift-count masking: `1 << 130` does not panic", async () => {
    // 130 & 127 = 2, so 1 << 2 = 4 (also matches JS's 1 << (130 & 31)).
    await behaves(`console.log(1 << 130);`, "4");
  });

  test("boundary: a bitwise result used as an array index compiles", async () => {
    await behaves(
      `const arr = [10, 20, 30];
const i = 1 & 3;
console.log(arr[i]);`,
      "20",
    );
  });

  test("boundary: a bitwise result used in float arithmetic compiles", async () => {
    await behaves(
      `const a = 6;
const b = 3;
console.log((a & b) * 2.5);`,
      "5",
    );
  });

  test("fractional literal operand → UnsupportedError", () => {
    expect(() => compile(`const x = 6.5 & 3;\nconsole.log(x);`)).toThrow(
      UnsupportedError,
    );
  });

  test("negative shift count → UnsupportedError", () => {
    expect(() => compile(`console.log(4 >> -1);`)).toThrow(UnsupportedError);
  });

  test("warning channel records the wide-int divergence", () => {
    const mod = lower(parseSync("t.ts", `const a = 6;\nconsole.log(a & 3);`).program as unknown as Program);
    expect(mod.warnings?.some((w) => w.includes("i128"))).toBe(true);
  });

  test("emitted line carries the inline divergence note", () => {
    const rust = compile(`const a = 6;\nconsole.log(a & 3);`);
    expect(rust).toContain("// bitwise: wide-int (i128), not JS int32");
  });

  test("regression: `&&` / `||` stay native short-circuit ops (no i128, no note)", () => {
    const rust = compile(`const a = true;\nconst b = false;\nconsole.log(a && b || a);`);
    expect(rust).not.toContain("i128");
    expect(rust).not.toContain("// bitwise");
    const mod = lower(parseSync("t.ts", `const a = true;\nconst b = false;\nconsole.log(a && b);`).program as unknown as Program);
    expect(mod.warnings ?? []).toHaveLength(0);
  });
});
