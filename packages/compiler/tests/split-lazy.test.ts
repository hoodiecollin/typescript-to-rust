/**
 * Specs for series 107 (#88, sub-task 2c) — lazy `split`. A non-empty-separator
 * `String.prototype.split` whose result is consumed **without keeping the pieces**
 * streams Rust's native `str::split` (borrowed `&str`, zero allocation) instead of
 * materializing a `Vec<String>`. The differential harness cargo-compiles and runs each
 * program, so every shape assertion is also a COMPILES/BEHAVES proof; output is
 * byte-identical to the materialized form. IDs map to series 107.
 *
 * This is staging 1 — **iteration** consumers (for-of, temp + inline). Count (`.length`)
 * and single-index (`[i]`) land in staging 2. The negatives are as load-bearing as the
 * positives: each proves the pass keeps `tslib::string::split*` where streaming a
 * borrowed `&str` would be unsound (piece escapes, source mutated across the borrow) or
 * ineligible (empty-sep, limit, regex).
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("split-lazy", [
  // ── Positive: iteration streams `str::split` (no Vec) ───────────────────────
  {
    name: "SL1 temp for-of, unused piece — streams, drops the `let parts`",
    src: `function run(): number {
  const s: string = "a5b5c5d";
  let n: number = 0;
  const parts: string[] = s.split("5");
  for (const _p of parts) { n = n + 1; }
  return n;
}
console.log(run());`,
    expected: "4",
    extra: ({ rust }) => {
      expect(rust).toMatch(/for _p in s\.split\("5"\)/);
      expect(rust).not.toMatch(/tslib::string::split/);
      expect(rust).not.toMatch(/let parts/);
      // Idempotent: the split site appears exactly once (not double-rewritten).
      expect(rust.match(/s\.split\("5"\)/g)?.length).toBe(1);
    },
  },
  {
    name: "SL2 inline for-of — streams directly",
    src: `function run(): number {
  const s: string = "x5y5z";
  let n: number = 0;
  for (const p of s.split("5")) { n = n + 1; }
  return n;
}
console.log(run());`,
    expected: "3",
    extra: ({ rust }) => {
      expect(rust).toMatch(/for p in s\.split\("5"\)/);
      expect(rust).not.toMatch(/tslib::string::split/);
      expect(rust).not.toMatch(/\.iter\(\)/);
    },
  },
  {
    name: "SL3 read-only piece used (concatenated) — still streams (&str Deref)",
    src: `function run(): string {
  const s: string = "ab5cde5f";
  let acc: string = "";
  for (const p of s.split("5")) { acc = acc + p; }
  return acc;
}
console.log(run());`,
    expected: "abcdef",
    extra: ({ rust }) => {
      // The piece flows into a string concat (Display) — valid for a borrowed `&str`.
      expect(rust).toMatch(/for p in s\.split\("5"\)/);
      expect(rust).not.toMatch(/tslib::string::split/);
    },
  },

  // ── Negative: stays materialized (each compiles + byte-identical) ────────────
  {
    name: "SL-mut source mutated across the borrow — stays materialized",
    src: `function run(): number {
  let s: string = "a5b5c";
  let n: number = 0;
  const parts: string[] = s.split("5");
  s = s + "9";
  for (const _p of parts) { n = n + 1; }
  return n;
}
console.log(run());`,
    expected: "3",
    extra: ({ rust }) => {
      // The `s = s + "9"` between producer and consumer (a `strAppend` after 106)
      // writes the borrowed source, so streaming would re-split the mutated `s`.
      expect(rust).toMatch(/tslib::string::split\(&s, "5"\)/);
      expect(rust).toMatch(/for _p in parts\.iter\(\)/);
      expect(rust).not.toMatch(/for _p in s\.split/);
    },
  },
  {
    name: "SL-empty empty separator — ineligible, stays split_chars",
    src: `function run(): number {
  const s: string = "abc";
  let n: number = 0;
  for (const p of s.split("")) { n = n + 1; }
  return n;
}
console.log(run());`,
    expected: "3",
    extra: ({ rust }) => {
      expect(rust).toMatch(/tslib::string::split_chars/);
      expect(rust).not.toMatch(/for p in s\.split/);
    },
  },
  {
    name: "SL-limit limit arg — ineligible, stays split_limit",
    src: `function run(): number {
  const s: string = "a,b,c,d";
  const parts: string[] = s.split(",", 2);
  let n: number = 0;
  for (const _p of parts) { n = n + 1; }
  return n;
}
console.log(run());`,
    expected: "2",
    extra: ({ rust }) => {
      expect(rust).toMatch(/tslib::string::split_limit/);
    },
  },
  {
    name: "SL-regex regex separator — ineligible, stays the regex split path",
    src: `function run(): number {
  const s: string = "a1b2c";
  const parts: string[] = s.split(/[0-9]/);
  let n: number = 0;
  for (const _p of parts) { n = n + 1; }
  return n;
}
console.log(run());`,
    expected: "3",
    extra: ({ rust }) => {
      expect(rust).not.toMatch(/for _p in s\.split/);
      expect(rust).toMatch(/for _p in parts\.iter\(\)/);
    },
  },
]);

// ── Negative guard (emit-only): piece escapes as an owned String ──────────────
// Pushing a piece into an owned `Vec<String>` needs an owned `String`; a borrowed
// `&str` stream would be wrong (and this escaping shape is itself an unsupported
// residual — it does not compile — which is *why* fusing it must be avoided). Assert
// the pass leaves it materialized. Emit-only (no cargo): a TS→Rust shape check.
test("SL-esc piece escapes into an owned Vec<String> — stays materialized", () => {
  const rust = compile(`function run(): number {
  const s: string = "a5b5c";
  const out: string[] = [];
  const parts: string[] = s.split("5");
  for (const p of parts) { out.push(p); }
  return out.length;
}
console.log(run());`);
  expect(rust).toMatch(/tslib::string::split\(&s, "5"\)/);
  expect(rust).toMatch(/for p in parts\.iter\(\)/);
  expect(rust).not.toMatch(/for p in s\.split/);
});
