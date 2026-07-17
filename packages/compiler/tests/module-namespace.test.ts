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
  // ── MOD26 — a `namespace Foo { export fn }` → `mod Foo { pub fn }` ─────────
  {
    name: "MOD26 namespace declaration → inline mod, `Foo.bar()` → `Foo::bar()`",
    src: `namespace Geometry {
  export function square(n: number): number { return n * n; }
}
console.log(Geometry.square(6));`,
    expected: "36",
    extra: ({ rust }) => {
      expect(rust).toMatch(/mod Geometry \{/);
      expect(rust).toContain("pub fn square");
      expect(rust).toContain("Geometry::square(");
    },
  },
  // ── MOD27 — a reopened namespace coalesces into one `mod` ──────────────────
  {
    name: "MOD27 reopened namespace coalesces; both members resolve",
    src: `namespace M {
  export function a(): number { return 10; }
}
namespace M {
  export function b(): number { return 20; }
}
console.log(M.a() + M.b());`,
    expected: "30",
    extra: ({ rust }) => {
      // Exactly one `mod M { … }` (reopened blocks coalesced), carrying both fns.
      expect(rust.match(/mod M \{/g)?.length).toBe(1);
      expect(rust).toContain("pub fn a");
      expect(rust).toContain("pub fn b");
    },
  },
  // ── MOD26b — a namespace member calling a sibling member (intra-mod call) ──
  {
    name: "MOD26b namespace member calls a sibling member",
    src: `namespace Calc {
  export function dbl(n: number): number { return n * 2; }
  export function quad(n: number): number { return dbl(dbl(n)); }
}
console.log(Calc.quad(3));`,
    expected: "12",
    extra: ({ rust }) => expect(rust).toContain("Calc::quad("),
  },
]);
