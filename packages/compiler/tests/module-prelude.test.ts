/**
 * Specs for series 050d — prelude-module generation (issue #6, Axis 5). A crate's
 * library modules' crate-visible items are gathered into a generated inline
 * `mod prelude { pub(crate) use … }`, and every library module file globs it
 * (`use crate::prelude::*;`) to cut `use` noise. Pure name routing → differential-
 * neutral. A cross-module name collision is dropped from the prelude (it would be
 * ambiguous in one module). IDs map to docs/work/050-module-system/specs.md.
 */

import { expect } from "bun:test";
import { defineDifferential } from "./_support/differential";

defineDifferential("module-prelude", [
  // ── MOD28 — a crate emits a prelude module + module-file globs ─────────────
  {
    name: "MOD28 prelude module gathers library exports; files glob it; behaves",
    files: {
      "shapes.ts": `export function area(w: number, h: number): number { return w * h; }`,
      "util.ts": `export function twice(n: number): number { return n * 2; }`,
      "main.ts": `import { area } from "./shapes";\nimport { twice } from "./util";\nconsole.log(twice(area(3, 4)));`,
    },
    expected: "24",
    extra: ({ rust }) => {
      expect(rust).toMatch(/mod prelude \{/);
      expect(rust).toContain("pub(crate) use crate::shapes::area;");
      expect(rust).toContain("pub(crate) use crate::util::twice;");
      expect(rust).toContain("use crate::prelude::*;");
    },
  },
]);
