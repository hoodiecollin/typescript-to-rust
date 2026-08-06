/**
 * Specs for series 050b — multi-file graph + visibility (issue #6). Builds on the
 * 050a resolver/`lowerCrate`/`emitCrate` foundation: a **transitive** N-file graph
 * (with an accepted import cycle), **directory-nested** module files, **per-module**
 * std-import preludes, and the **visibility inference** (Axis 1) — an item named in
 * an `export`, or reachable from an exported signature, is `pub(crate)`; a purely
 * local item stays private. A top-level statement in a non-entry module is
 * fail-loud. IDs map to series 050.
 */

import { describe, expect, test } from "bun:test";
import type { CrateFile } from "../src/emitter";
import { compileCrate, defineDifferential } from "./_support/differential";

/** Find one emitted crate file's content by path (for a per-file assertion). */
function fileText(files: CrateFile[] | undefined, path: string): string {
  return files?.find((f) => f.path === path)?.content ?? "";
}

defineDifferential("module-graph", [
  // ── MOD6 — a 3-file transitive chain (main → a → b) ───────────────────────
  {
    name: "MOD6 transitive 3-file chain compiles + behaves",
    files: {
      "b.ts": `export function fb(): number { return 10; }`,
      "a.ts": `import { fb } from "./b";\nexport function fa(): number { return fb() + 1; }`,
      "main.ts": `import { fa } from "./a";\nconsole.log(fa());`,
    },
    expected: "11",
    extra: ({ rust }) => {
      expect(rust).toContain("use crate::a::fa;");
      expect(rust).toContain("use crate::b::fb;");
      expect(rust).toMatch(/pub\(crate\) fn fa/);
      expect(rust).toMatch(/pub\(crate\) fn fb/);
    },
  },
  // ── MOD7 — an A ↔ B import cycle terminates + compiles ─────────────────────
  {
    name: "MOD7 A↔B import cycle is accepted (sibling mods mutually visible)",
    files: {
      "a.ts": `import { bVal } from "./b";\nexport function useB(): number { return bVal(); }\nexport function aVal(): number { return 1; }`,
      "b.ts": `import { aVal } from "./a";\nexport function bVal(): number { return aVal() + 10; }`,
      "main.ts": `import { useB } from "./a";\nconsole.log(useB());`,
    },
    expected: "11",
    extra: ({ files }) => {
      const paths = (files ?? []).map((f) => f.path).sort();
      expect(paths).toEqual(["a.rs", "b.rs", "main.rs"]);
    },
  },
  // ── MOD8 — visibility: a non-exported type reachable from an exported ──────
  //          signature (transitively) is widened to `pub(crate)`.
  {
    name: "MOD8 signature-reachable non-exported struct → pub(crate) (transitive)",
    files: {
      "math.ts": `interface Bar { v: number; }\ninterface Foo { bar: Bar; }\nexport function make(): Foo {\n  const b: Bar = { v: 7 };\n  const f: Foo = { bar: b };\n  return f;\n}`,
      "main.ts": `import { make } from "./math";\nconsole.log(make().bar.v);`,
    },
    expected: "7",
    extra: ({ files }) => {
      const math = fileText(files, "math.rs");
      expect(math).toMatch(/pub\(crate\) struct Foo/);
      expect(math).toMatch(/pub\(crate\) struct Bar/);
      // The reachable structs' fields widen too (a cross-module field read).
      expect(math).toMatch(/pub\(crate\) bar:/);
      expect(math).toMatch(/pub\(crate\) v:/);
    },
  },
  // ── MOD9 — a purely-local helper (not exported, not signature-reachable) ───
  //          stays private: call-graph reachability does NOT widen.
  {
    name: "MOD9 local helper stays private (no visibility keyword)",
    files: {
      "math.ts": `function helper(n: number): number { return n * 2; }\nexport function twice(n: number): number { return helper(n); }`,
      "main.ts": `import { twice } from "./math";\nconsole.log(twice(21));`,
    },
    expected: "42",
    extra: ({ files }) => {
      const math = fileText(files, "math.rs");
      expect(math).toContain("fn helper");
      expect(math).not.toContain("pub(crate) fn helper");
      expect(math).not.toContain("pub fn helper");
      expect(math).toMatch(/pub\(crate\) fn twice/);
    },
  },
  // ── MOD10 — a directory-nested import → a real `util/math.rs` module file ──
  {
    name: "MOD10 directory-nested import emits src/util/math.rs, wired via mod",
    files: {
      "util/math.ts": `export function add(a: number, b: number): number { return a + b; }`,
      "main.ts": `import { add } from "./util/math";\nconsole.log(add(2, 3));`,
    },
    expected: "5",
    extra: ({ files, rust }) => {
      const paths = (files ?? []).map((f) => f.path).sort();
      expect(paths).toEqual(["main.rs", "util.rs", "util/math.rs"]);
      expect(fileText(files, "main.rs")).toContain("mod util;");
      expect(fileText(files, "util.rs")).toContain("mod math;");
      expect(rust).toContain("use crate::util::math::add;");
    },
  },
  // ── MOD11 — a non-entry module gets its OWN std-import prelude ─────────────
  {
    name: "MOD11 imported module emits its own IndexMap prelude (per-mod scan)",
    files: {
      "store.ts": `export function total(): number {\n  const m: Record<string, number> = {};\n  m["a"] = 1;\n  m["b"] = 2;\n  let sum = 0;\n  for (const v of Object.values(m)) {\n    sum = sum + v;\n  }\n  return sum;\n}`,
      "main.ts": `import { total } from "./store";\nconsole.log(total());`,
    },
    expected: "3",
    extra: ({ files }) => {
      // The `IndexMap` prelude lives in store.rs (which uses it), not the root.
      expect(fileText(files, "store.rs")).toContain("IndexMap");
      expect(fileText(files, "main.rs")).not.toContain("IndexMap");
    },
  },
]);

// ── MOD12 — a top-level statement in an imported module is fail-loud ───────────

describe("050b fail-loud — top-level statement in an imported module", () => {
  test("MOD12 a non-entry file's `console.log` → UnsupportedError", () => {
    expect(() =>
      compileCrate(
        {
          "math.ts": `export function add(a: number, b: number): number { return a + b; }\nconsole.log("side effect");`,
          "main.ts": `import { add } from "./math";\nconsole.log(add(1, 2));`,
        },
        "main.ts",
      ),
    ).toThrow(/top-level statement in an imported module/);
  });
});
