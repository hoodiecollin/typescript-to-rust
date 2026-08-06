/**
 * Specs for series 112 (#88) — the non-iteration `split` consumers, extending
 * `refineSplitLazy` (series 107) now that `.length`→f64 (series 111) landed:
 *
 *   - **count** — `parts.length` / `s.split(sep).length` → `s.split(sep).count() as f64`.
 *   - **single index** — `parts[i]` / `s.split(sep)[i]` → `s.split(sep).nth(i).unwrap()`,
 *     but only where the `&str` result is used **read-only** (an owned-`String` escape —
 *     a `.clone()`, a returned/stored piece — stays materialized).
 *
 * The differential harness cargo-compiles and runs each program, so every assertion is
 * a COMPILES/BEHAVES proof; output is byte-identical to node/bun. IDs map to
 * series 112.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("split-consumers", [
  // ── count → `.count() as f64` (no Vec) ───────────────────────────────────────
  {
    name: "SC1 count over a temp — const n = parts.length",
    src: `function run(): number {
  const s: string = "a5b5c5d";
  const parts: string[] = s.split("5");
  const n: number = parts.length;
  return n;
}
console.log(run());`,
    expected: "4",
    extra: ({ rust }) => {
      expect(rust).toMatch(/s\.split\("5"\)\.count\(\) as f64/);
      expect(rust).not.toMatch(/tslib::string::split/);
      expect(rust).not.toMatch(/let parts/);
    },
  },
  {
    name: "SC2 count inline — s.split(sep).length",
    src: `function run(): number {
  const s: string = "x5y5z";
  return s.split("5").length;
}
console.log(run());`,
    expected: "3",
    extra: ({ rust }) => {
      expect(rust).toMatch(/s\.split\("5"\)\.count\(\) as f64/);
      expect(rust).not.toMatch(/tslib::string::split/);
    },
  },
  {
    name: "SC-mut count with source mutated across the borrow — materialized",
    src: `function run(): number {
  let s: string = "a5b5c";
  const parts: string[] = s.split("5");
  s = s + "9";
  return parts.length;
}
console.log(run());`,
    expected: "3",
    extra: ({ rust }) => {
      expect(rust).toMatch(/tslib::string::split\(&s, "5"\)/);
      expect(rust).not.toMatch(/\.count\(\)/);
    },
  },

  // ── single index → `.nth(i).unwrap()` (no Vec), read-only only ───────────────
  {
    name: "SI1 inline index in a read-only comparison",
    src: `function run(): number {
  const s: string = "a=b=c";
  if (s.split("=")[1] === "b") {
    return 1;
  }
  return 0;
}
console.log(run());`,
    expected: "1",
    extra: ({ rust }) => {
      expect(rust).toMatch(/s\.split\("="\)\.nth\(\(1\) as usize\)\.unwrap\(\)/);
      expect(rust).not.toMatch(/tslib::string::split/);
    },
  },
  {
    name: "SI2 temp index read as a length",
    src: `function run(): number {
  const s: string = "ab,cde";
  const parts: string[] = s.split(",");
  return parts[0].length;
}
console.log(run());`,
    expected: "2",
    extra: ({ rust }) => {
      expect(rust).toMatch(/s\.split\(","\)\.nth\(\(0\) as usize\)\.unwrap\(\)/);
      expect(rust).not.toMatch(/tslib::string::split/);
      expect(rust).not.toMatch(/let parts/);
    },
  },
  {
    name: "SI-esc index result returned as an owned String — materialized",
    src: `function run(): string {
  const s: string = "a,b";
  const parts: string[] = s.split(",");
  return parts[0];
}
console.log(run());`,
    expected: "a",
    extra: ({ rust }) => {
      expect(rust).toMatch(/tslib::string::split\(&s, ","\)/);
      expect(rust).not.toMatch(/\.nth\(/);
    },
  },
]);

// Emit-only: `.forEach` lowers to a `for &p in …` ref pattern (a Copy-element
// assumption); a borrowed `&str` stream can't bind an unsized `str` through `&p`, so the
// pass leaves a forEach over a split materialized (it does not stream).
test("SF forEach over a split stays materialized (ref-pattern, not streamed)", () => {
  const rust = compile(`function run(): number {
  const s: string = "a5b5c";
  let n: number = 0;
  s.split("5").forEach((p: string) => { n = n + 1; });
  return n;
}
console.log(run());`);
  expect(rust).not.toMatch(/for &p in s\.split/);
});
