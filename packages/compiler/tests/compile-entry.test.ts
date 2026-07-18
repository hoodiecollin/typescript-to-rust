/**
 * Unit specs for `compileEntry` (series 050, #69) — the single production path the
 * `ttr` CLI uses to turn an entry file into Rust, following `./`-relative imports
 * transitively. Pure (no cargo): asserts the single-vs-crate branch, the emitted
 * module wiring, and the bare-import fail-loud edge. Runtime behavior of the emit
 * is covered by the differential `module-graph`/`module-facades` suites.
 */

import { describe, expect, test } from "bun:test";
import { compileEntry } from "../src/compile-entry";

/** Build a `readFile` over an in-memory key→source map (canonical keys). */
function mapReader(files: Record<string, string>): (k: string) => string | null {
  return (key) =>
    Object.prototype.hasOwnProperty.call(files, key) ? files[key]! : null;
}

/** The concatenated content of every emitted file (for cross-file assertions). */
function allRust(files: { path: string; content: string }[]): string {
  return files.map((f) => f.content).join("\n");
}

describe("compileEntry — single-file entry", () => {
  test("a lone entry (no imports) emits one main.rs, isCrate=false", () => {
    const out = compileEntry(
      "main.ts",
      mapReader({ "main.ts": `console.log(1 + 2);` }),
    );
    expect(out.isCrate).toBe(false);
    expect(out.files).toHaveLength(1);
    expect(out.files[0]!.path).toBe("main.rs");
    expect(out.files[0]!.content).toContain("fn main()");
    // Single-file emit is NOT crate-wrapped — no `mod …;` declarations.
    expect(out.files[0]!.content).not.toContain("mod ");
  });
});

describe("compileEntry — multi-file crate", () => {
  test("a transitive chain (main → helper → util/math) emits one file per module", () => {
    const out = compileEntry(
      "main.ts",
      mapReader({
        "util/math.ts": `export function square(n: number): number { return n * n; }`,
        "helper.ts": `import { square } from "./util/math";
export function sumSquares(a: number, b: number): number { return square(a) + square(b); }`,
        "main.ts": `import { sumSquares } from "./helper";
console.log(sumSquares(3, 4));`,
      }),
    );
    expect(out.isCrate).toBe(true);
    const paths = out.files.map((f) => f.path).sort();
    expect(paths).toEqual(["helper.rs", "main.rs", "util.rs", "util/math.rs"]);

    const root = out.files.find((f) => f.path === "main.rs")!.content;
    expect(root).toContain("pub(crate) mod helper;");
    expect(root).toContain("pub(crate) mod util;");
    expect(root).toContain("fn main()");

    const rust = allRust(out.files);
    expect(rust).toContain("use crate::helper::sumSquares;");
    expect(rust).toContain("use crate::util::math::square;");
    expect(rust).toMatch(/pub\(crate\) fn square/);
  });
});

describe("compileEntry — fail-loud edges", () => {
  test("a bare/package import is refused (no node_modules)", () => {
    expect(() =>
      compileEntry(
        "main.ts",
        mapReader({ "main.ts": `import { readFileSync } from "node:fs";\nconsole.log(1);` }),
      ),
    ).toThrow(/bare\/package import 'node:fs'/);
  });

  test("an unresolvable `./`-relative import is refused", () => {
    expect(() =>
      compileEntry(
        "main.ts",
        mapReader({ "main.ts": `import { x } from "./missing";\nconsole.log(x);` }),
      ),
    ).toThrow(/cannot resolve module '\.\/missing'/);
  });
});
