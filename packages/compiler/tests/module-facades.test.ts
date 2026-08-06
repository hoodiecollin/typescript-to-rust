/**
 * Specs for series 050d — pure-barrel `pub use` facades (issue #6, Axis 3
 * Position A). A **pure barrel** `index.ts` whose body is only `./`-relative
 * re-exports translates to a generated facade module of `pub use crate::…;` lines
 * (differential-neutral name routing); a **renamed** re-export becomes
 * `pub use … as …;` (the lifted renamed-export residual). A **mixed** logic +
 * re-export file stays fail-loud (see module-failloud.test.ts, MOD25). IDs map to
 * series 050.
 */

import { expect } from "bun:test";
import { defineDifferential } from "./_support/differential";

defineDifferential("module-facades", [
  // ── MOD23 — a pure barrel → a `pub use` facade ────────────────────────────
  {
    name: "MOD23 pure barrel re-exports via a pub use facade, behaves",
    files: {
      "math.ts": `export function add(a: number, b: number): number { return a + b; }`,
      "index.ts": `export { add } from "./math";`,
      "main.ts": `import { add } from "./index";\nconsole.log(add(2, 3));`,
    },
    expected: "5",
    extra: ({ rust }) => {
      expect(rust).toContain("pub(crate) use crate::math::add;");
      expect(rust).toContain("use crate::index::add;");
    },
  },
  // ── MOD24 — a renamed re-export in a pure barrel (lifted residual) ─────────
  {
    name: "MOD24 renamed re-export `export { add as plus } from` behaves",
    files: {
      "math.ts": `export function add(a: number, b: number): number { return a + b; }`,
      "index.ts": `export { add as plus } from "./math";`,
      "main.ts": `import { plus } from "./index";\nconsole.log(plus(4, 5));`,
    },
    expected: "9",
    extra: ({ rust }) =>
      expect(rust).toContain("pub(crate) use crate::math::add as plus;"),
  },
]);
