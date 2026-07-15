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

import { expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { runRust } from "../src/harness";
import { UnsupportedError, lower } from "../src/lower";
import { defineDifferential } from "./_support/differential";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

function runTs(src: string): string {
  const proc = Bun.spawnSync(["bun", "run", "-"], {
    stdin: new TextEncoder().encode(src),
  });
  return new TextDecoder().decode(proc.stdout).trim();
}

/** Rust compiles and equals `expected` — used where the dialect diverges from JS. */
async function rustYields(src: string, expected: string): Promise<void> {
  const rust = compile(src);
  const rr = await runRust(rust);
  expect(rr.ok).toBe(true);
  expect(rr.stdout.trim()).toBe(expected);
}

defineDifferential("bitwise", [
  {
    name: "`&` `|` `^` match JS",
    src: `const a = 6;
const b = 3;
console.log(a & b);
console.log(a | b);
console.log(a ^ b);`,
    expected: "2\n7\n5",
  },
  {
    name: "`~` (→ Rust `!`) matches JS",
    src: `const a = 6;\nconsole.log(~a);`,
    expected: "-7",
  },
  {
    name: "`<<` `>>` (arithmetic) match JS for in-range values",
    src: `const a = 6;
console.log(a << 2);
console.log(a >> 1);`,
    expected: "24\n3",
  },
  {
    name: "a bitwise result flows through an untyped binding (inferred i128)",
    src: `const a = 12;
const b = 10;
const c = a & b;
console.log(c);`,
    expected: "8",
  },
  {
    name: "precedence: `a & b | c` groups as `(a & b) | c`",
    // (6 & 3) | 8 = 2 | 8 = 10
    src: `const a = 6;\nconst b = 3;\nconst c = 8;\nconsole.log(a & b | c);`,
    expected: "10",
    // `&` binds tighter than `|`, so no parens are needed around `a & b`.
    extra: ({ rust }) => expect(rust).toContain(") & ("),
  },
  {
    name: "`>>>` still matches JS on an in-range value",
    src: `console.log(16 >>> 2);`,
    expected: "4",
  },
  {
    name: "shift-count masking: `1 << 130` does not panic",
    // 130 & 127 = 2, so 1 << 2 = 4 (also matches JS's 1 << (130 & 31)).
    src: `console.log(1 << 130);`,
    expected: "4",
  },
  {
    name: "boundary: a bitwise result used as an array index compiles",
    src: `const arr = [10, 20, 30];
const i = 1 & 3;
console.log(arr[i]);`,
    expected: "20",
  },
  {
    name: "boundary: a bitwise result used in float arithmetic compiles",
    src: `const a = 6;
const b = 3;
console.log((a & b) * 2.5);`,
    expected: "5",
  },
]);

test("`>>>` diverges from JS (i128, not int32) — assert the Rust result", async () => {
  // JS: -1 >>> 0 === 4294967295; our i128 dialect yields -1 (documented divergence).
  expect(runTs(`console.log(-1 >>> 0);`)).toBe("4294967295");
  await rustYields(`console.log(-1 >>> 0);`, "-1");
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
