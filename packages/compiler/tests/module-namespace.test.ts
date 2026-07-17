/**
 * Specs for series 050d — namespaces & namespace imports (issue #6, Axis 4,
 * re-decided 2026-07-17). A **namespace import** (`import * as ns from "./n"`) maps
 * to a Rust **module alias** (`use crate::n as ns;`) with member access `ns.f()`
 * routed to the path `ns::f()` — TS `import *` is *qualified* access, not an
 * unqualified glob, so there is no name capture. A **`namespace Foo { export … }`**
 * lowers to an inline `mod Foo { pub … }` and `Foo.bar()` → `Foo::bar()`; a
 * **reopened** namespace coalesces into one `mod`. IDs map to
 * docs/work/050-module-system/specs.md.
 */

import { expect } from "bun:test";
import { defineDifferential } from "./_support/differential";

defineDifferential("module-namespace", [
  // ── MOD20 — a namespace import → a module alias, `ns.f()` → `ns::f()` ──────
  {
    name: "MOD20 namespace import `import * as m` routes member calls via a module alias",
    files: {
      "math.ts": `export function add(a: number, b: number): number { return a + b; }\nexport function mul(a: number, b: number): number { return a * b; }`,
      "main.ts": `import * as m from "./math";\nconsole.log(m.add(2, 3) + m.mul(4, 5));`,
    },
    expected: "25",
    extra: ({ rust }) => {
      expect(rust).toContain("use crate::math as m;");
      expect(rust).toContain("m::add(");
    },
  },
]);
