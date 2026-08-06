/**
 * Specs for series 050a — single import/export + multi-file crate emission
 * (issue #6). A program that `import`s a `./`-relative file becomes a **crate**:
 * the resolver follows the edge, `lowerCrate` lowers the whole thing as one unit
 * (so a cross-module call resolves by construction), and the emitter writes one
 * `.rs` file per module plus a `mod foo;` root — one binary, one stdout to diff.
 * The inline single-file form stays the no-import fast path. IDs map to
 * series 050.
 */

import { describe, expect, test } from "bun:test";
import {
  compileCrate,
  defineDifferential,
} from "./_support/differential";

defineDifferential("module-single", [
  // ── MOD1/MOD2 — two files: export fn + import + cross-module call ──────────
  {
    name: "MOD1/MOD2 export fn add + import + call (compiles, behaves)",
    files: {
      "math.ts": `export function add(a: number, b: number): number { return a + b; }`,
      "main.ts": `import { add } from "./math";\nconsole.log(add(2, 3));`,
    },
    expected: "5",
    extra: ({ rust }) => {
      expect(rust).toMatch(/pub(\(crate\))? fn add/);
      expect(rust).toContain("use crate::math::add;");
    },
  },
  // ── MOD3 — rename on import (`add as plus`) ───────────────────────────────
  {
    name: "MOD3 import { add as plus } renames via `use … as`",
    files: {
      "math.ts": `export function add(a: number, b: number): number { return a + b; }`,
      "main.ts": `import { add as plus } from "./math";\nconsole.log(plus(2, 3));`,
    },
    expected: "5",
    extra: ({ rust }) =>
      expect(rust).toContain("use crate::math::add as plus;"),
  },
  // ── MOD5b — the emitted crate is a real multi-file layout ─────────────────
  {
    name: "MOD5b emits a real multi-file cargo project (math.rs + mod math;)",
    files: {
      "math.ts": `export function add(a: number, b: number): number { return a + b; }`,
      "main.ts": `import { add } from "./math";\nconsole.log(add(2, 3));`,
    },
    expected: "5",
    extra: ({ files }) => {
      expect(files).toBeDefined();
      const paths = (files ?? []).map((f) => f.path).sort();
      expect(paths).toEqual(["main.rs", "math.rs"]);
      const main = files?.find((f) => f.path === "main.rs")?.content ?? "";
      const math = files?.find((f) => f.path === "math.rs")?.content ?? "";
      expect(main).toContain("mod math;");
      expect(math).toMatch(/pub(\(crate\))? fn add/);
    },
  },
  // ── MOD4 — no import/export still lowers via the single-file fast path ─────
  {
    name: "MOD4 no-import program keeps the single-file fast path",
    src: `console.log(41 + 1);`,
    expected: "42",
    // A single-file spec produces no crate files (byte-unchanged fast path).
    extra: ({ files }) => expect(files).toBeUndefined(),
  },
]);

// ── MOD5 — a bare/package specifier is refused fail-loud ───────────────────────

describe("050a fail-loud — bare/package imports", () => {
  test("MOD5 bare import `lodash` → UnsupportedError (no node_modules)", () => {
    expect(() =>
      compileCrate(
        { "main.ts": `import _ from "lodash";\nconsole.log(1);` },
        "main.ts",
      ),
    ).toThrow(/bare\/package import/);
  });
});
