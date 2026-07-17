/**
 * Specs for series 050d — default import / export via the reserved
 * `__default_export` symbol (issue #6, Axis 4, re-decided 2026-07-17). A TS
 * `default` export is nameless; on the Rust side it becomes an ordinary named
 * item `__default_export` (an anonymous fn/class) or a `pub(crate) use self::<name>
 * as __default_export;` alias (a named fn/class), and `import def from "./d"` binds
 * it via `use crate::d::__default_export as def;`. An anonymous **value** default
 * (`export default 42/{}`) has no named Rust analog and stays fail-loud (MOD17).
 * IDs map to docs/work/050-module-system/specs.md.
 */

import { expect } from "bun:test";
import { defineDifferential } from "./_support/differential";

defineDifferential("module-default", [
  // ── MOD19a — a NAMED fn default export + default import round-trip ─────────
  {
    name: "MOD19 named default export (fn) + `import greet` behaves",
    files: {
      "greet.ts": `export default function greet(): string { return "hi"; }`,
      "main.ts": `import greet from "./greet";\nconsole.log(greet());`,
    },
    expected: "hi",
    extra: ({ rust }) => {
      expect(rust).toContain("pub(crate) use self::greet as __default_export;");
      expect(rust).toContain("use crate::greet::__default_export as greet;");
    },
  },
  // ── MOD19b — an ANONYMOUS fn default → the reserved item name directly ─────
  {
    name: "MOD19 anonymous default export (fn) → __default_export item",
    files: {
      "answer.ts": `export default function (): number { return 42; }`,
      "main.ts": `import answer from "./answer";\nconsole.log(answer());`,
    },
    expected: "42",
    extra: ({ rust }) => {
      expect(rust).toMatch(/fn __default_export/);
      expect(rust).toContain("use crate::answer::__default_export as answer;");
    },
  },
  // ── MOD19c — a default import bound to a renamed local ─────────────────────
  {
    name: "MOD19 default import binds any local name (as-alias)",
    files: {
      "greet.ts": `export default function greet(): string { return "yo"; }`,
      "main.ts": `import hello from "./greet";\nconsole.log(hello());`,
    },
    expected: "yo",
    extra: ({ rust }) =>
      expect(rust).toContain("use crate::greet::__default_export as hello;"),
  },
]);
