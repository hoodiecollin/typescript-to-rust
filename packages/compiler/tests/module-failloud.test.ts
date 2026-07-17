/**
 * Fail-loud residuals for the series-050 module system (issue #6). These shapes
 * have no sound Rust analog and are rejected in `lowerCrate`/lowering with a
 * dedicated message (never silently mistranslated). TS→Rust-rejection tests, so
 * they use `compileCrate(...)` + `toThrow` (they never reach cargo). IDs map to
 * docs/work/050-module-system/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { compileCrate } from "./_support/differential";

describe("050d module fail-loud residuals", () => {
  // ── MOD25 — a mixed logic + re-export file is not a pure barrel ────────────
  test("MOD25 mixed barrel (re-export + own decl) → re-export outside a pure barrel", () => {
    expect(() =>
      compileCrate(
        {
          "math.ts": `export function add(a: number, b: number): number { return a + b; }`,
          "mixed.ts": `export { add } from "./math";\nexport function extra(): number { return 1; }`,
          "main.ts": `import { extra } from "./mixed";\nconsole.log(extra());`,
        },
        "main.ts",
      ),
    ).toThrow(/re-export outside a pure barrel/);
  });

  // ── MOD18 — `export * from` in a mixed file ───────────────────────────────
  test("MOD18 `export * from` in a mixed file → re-export outside a pure barrel", () => {
    expect(() =>
      compileCrate(
        {
          "math.ts": `export function add(a: number, b: number): number { return a + b; }`,
          "mixed.ts": `export * from "./math";\nexport function extra(): number { return 1; }`,
          "main.ts": `import { extra } from "./mixed";\nconsole.log(extra());`,
        },
        "main.ts",
      ),
    ).toThrow(/re-export outside a pure barrel/);
  });

  // ── MOD17 — an anonymous VALUE default export ─────────────────────────────
  test("MOD17 `export default 42` (value) → anonymous value export default", () => {
    expect(() =>
      compileCrate(
        {
          "val.ts": `export default 42;`,
          "main.ts": `import v from "./val";\nconsole.log(v);`,
        },
        "main.ts",
      ),
    ).toThrow(/anonymous value `export default`/);
  });

  // ── MOD21 — dynamic import() ──────────────────────────────────────────────
  test("MOD21 dynamic `import(\"./x\")` → rejected", () => {
    expect(() =>
      compileCrate(
        {
          "math.ts": `export function add(a: number, b: number): number { return a + b; }`,
          "main.ts": `import("./math").then(() => {});\nconsole.log(1);`,
        },
        "main.ts",
      ),
    ).toThrow(/dynamic `import\(\)`/);
  });
});
