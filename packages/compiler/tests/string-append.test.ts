/**
 * Specs for series 106 (#88, sub-task 2a) — append-assignment → in-place string
 * mutation. The self-append rebind `s = s + …` (which series 080 lowered to an
 * O(n²) `s = format!(…)` — a fresh buffer + full copy each iteration) is rewritten
 * to a single amortized-O(n) `write!(s, …).unwrap()` that appends through the
 * accumulator's `std::fmt::Write` impl. The differential harness cargo-compiles and
 * runs each program, so every shape assertion is also a COMPILES/BEHAVES proof; the
 * output is byte-identical to the `format!` form. IDs map to
 * series 106.
 *
 * Per the corpus-coverage rule, the non-append rejects (SA5–SA7) each get a fixture:
 * they are soundness-critical — an in-place append there would reorder or corrupt a
 * string, so proving they stay `format!` is load-bearing.
 */

import { expect, test } from "bun:test";
import { compile } from "./_support/differential";
import { defineDifferential } from "./_support/differential";

defineDifferential("string-append", [
  // ── Positive: self-append rewrites to in-place write! ───────────────────────
  {
    name: "SA1 strbuild shape — s = s + \"abc\" + (i % 10) appends in place",
    src: `function run(): string {
  let s: string = "";
  for (let i: number = 0; i < 50; i = i + 1) {
    s = s + "abc" + (i % 10);
  }
  return s;
}
console.log(run());`,
    extra: ({ rust }) => {
      // The tail number part inherits the #90 integer-domain modulo, so the
      // asserted arg is `((i as i64) % 10) as f64` — the shape assertion is on the
      // in-place `write!`, not on the modulo form.
      expect(rust).toMatch(
        /write!\(s, "\{\}\{\}", "abc", \(\(i as i64\) % 10\) as f64\)\.unwrap\(\)/,
      );
      expect(rust).not.toMatch(/s = format!/);
      expect(rust).toMatch(/use std::fmt::Write;/);
    },
  },
  {
    name: "SA2 literal-only tail — s = s + \"x\"",
    src: `function run(): string {
  let s: string = "";
  s = s + "x";
  s = s + "y";
  return s;
}
console.log(run());`,
    extra: ({ rust }) => {
      expect(rust).toMatch(/write!\(s, "\{\}", "x"\)\.unwrap\(\)/);
      expect(rust).toMatch(/write!\(s, "\{\}", "y"\)\.unwrap\(\)/);
    },
  },
  {
    name: "SA3 multiple mixed tail parts — s = s + a + \"-\" + b",
    src: `function run(): string {
  const a: string = "L";
  const b: string = "R";
  let s: string = "";
  s = s + a + "-" + b;
  return s;
}
console.log(run());`,
    extra: ({ rust }) => {
      expect(rust).toMatch(
        /write!\(s, "\{\}\{\}\{\}", a, "-", b\)\.unwrap\(\)/,
      );
    },
  },

  // ── Negative: non-append shapes keep format! (soundness-critical) ────────────
  {
    name: "SA5 prepend — s = \"x\" + s stays format!",
    src: `function run(): string {
  let s: string = "seed";
  s = "x" + s;
  return s;
}
console.log(run());`,
    extra: ({ rust }) => {
      expect(rust).toMatch(/s = format!\("\{\}\{\}", "x", s\)/);
      expect(rust).not.toMatch(/write!/);
    },
  },
  {
    name: "SA6 accumulator not head — s = a + s + b stays format!",
    src: `function run(): string {
  const a: string = "A";
  const b: string = "B";
  let s: string = "mid";
  s = a + s + b;
  return s;
}
console.log(run());`,
    extra: ({ rust }) => {
      expect(rust).toMatch(/s = format!\("\{\}\{\}\{\}", a, s, b\)/);
      expect(rust).not.toMatch(/write!/);
    },
  },
  {
    name: "SA7 different binding — t = s + \"x\" stays format!",
    src: `function run(): string {
  const s: string = "base";
  let t: string = "";
  t = s + "x";
  return t;
}
console.log(run());`,
    extra: ({ rust }) => {
      expect(rust).toMatch(/t = format!\("\{\}\{\}", s, "x"\)/);
      expect(rust).not.toMatch(/write!/);
    },
  },
]);

// SA4 idempotency: a pure-TS invariant (no cargo). The rewritten `strAppend` is no
// longer a `strConcat`-valued assign, so a second pass cannot re-match it — the
// emitted Rust from one `compile` already reflects the fixpoint.
test("SA4 self-append rewrite is idempotent (single write!, no residual format!)", () => {
  const src = `function run(): string {
  let s: string = "";
  s = s + "a";
  return s;
}
console.log(run());`;
  const rust = compile(src);
  const writes = rust.match(/write!\(s,/g) ?? [];
  expect(writes.length).toBe(1);
  expect(rust).not.toMatch(/s = format!/);
});
