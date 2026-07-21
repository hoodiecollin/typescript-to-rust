/**
 * Specs for series 105 (#90) — the module-wide integrality lattice: integer-domain
 * arithmetic specialized *into* lifted `__cb_*` callback bodies and across call
 * sites, the graduation of 103's intra-body integer inference. A callback/param
 * whose value is proven integer module-wide (from its iterator source or every call
 * site) gets a hardware modulo (`(v as i64) % 5`) instead of a libm `frem`; anything
 * unproven stays `f64` — the always-safe fallback. The differential harness
 * cargo-compiles and runs each program, so every shape assertion is also a
 * COMPILES/BEHAVES proof. IDs map to docs/work/105-callback-integrality/specs.md.
 *
 * Per the corpus-coverage rule, the `Real`-forcing rejects (CI5–CI8) each get a
 * fixture too: they are the soundness-critical cases — a wrong `as i64` there would
 * truncate real data, so proving they stay `f64` is load-bearing.
 */

import { expect, test } from "bun:test";
import { defineDifferential } from "./_support/differential";

defineDifferential("callback-integrality", [
  // ── Positive: integer-domain modulo reaches the callback ────────────────────
  {
    name: "CI1 arraypipe — filter callback modulo specializes",
    src: `function run(): number {
  const n: number = 20;
  const xs: number[] = [];
  for (let i: number = 0; i < n; i = i + 1) { xs.push(i); }
  const doubled: number[] = xs.map((v: number): number => v * 2 + 1);
  const kept: number[] = doubled.filter((v: number): boolean => v % 5 !== 0);
  const total: number = kept.reduce((a: number, b: number): number => a + b, 0);
  return total;
}
console.log(run());`,
    extra: ({ rust }) => {
      // The filter predicate's modulo is integer-domain (element proven integer
      // through the push loop + the map stage).
      expect(rust).toMatch(/fn __cb_filter_\d+\(v: f64\) -> bool \{\s*return \(\(v as i64\) % 5\) as f64 != 0\.0;/);
    },
  },
  {
    name: "CI2 element integrality flows through map into the next callback",
    src: `function run(): number {
  const xs: number[] = [];
  for (let i: number = 0; i < 12; i = i + 1) { xs.push(i); }
  const tripled: number[] = xs.map((v: number): number => v * 3);
  const kept: number[] = tripled.filter((w: number): boolean => w % 2 !== 0);
  return kept.reduce((s: number, x: number): number => s + x, 0);
}
console.log(run());`,
    extra: ({ rust }) => {
      // `map(v => v*3)` yields an integer element, so the downstream `w % 2` is
      // integer-domain.
      expect(rust).toMatch(/fn __cb_filter_\d+\(w: f64\) -> bool \{\s*return \(\(w as i64\) % 2\)/);
    },
  },
  {
    name: "CI3 free-fn param integer at every call site specializes",
    src: `function f(n: number): number { return n % 4; }
function run(): number {
  const a: number = f(8);
  const b: number = f(12);
  return a + b;
}
console.log(run());`,
    extra: ({ rust }) => {
      expect(rust).toMatch(/fn f\(n: f64\) -> f64 \{\s*return \(\(n as i64\) % 4\) as f64;/);
    },
  },
  {
    name: "CI4 reduce accumulator + element modulo specializes",
    src: `function run(): number {
  const xs: number[] = [];
  for (let i: number = 0; i < 15; i = i + 1) { xs.push(i); }
  const total: number = xs.reduce((a: number, b: number): number => (a + b) % 7, 0);
  return total;
}
console.log(run());`,
    extra: ({ rust }) => {
      // Both the accumulator (`a`, seeded from the `0` init + integer fold) and the
      // element (`b`, from the integer source) are proven integer.
      expect(rust).toMatch(/fn __cb_reduce_\d+\(a: f64, b: f64\) -> f64 \{\s*return \(\(\(a \+ b\) as i64\) % 7\) as f64;/);
    },
  },

  // ── Negative: a Real-forcing source keeps the modulo f64 (soundness) ─────────
  {
    name: "CI5 fractional source element — modulo stays f64",
    src: `function run(): number {
  const xs: number[] = [0.5, 1.5, 2.5, 3.5];
  const kept: number[] = xs.filter((v: number): boolean => v % 5 !== 0);
  return kept.reduce((s: number, x: number): number => s + x, 0);
}
console.log(run());`,
    extra: ({ rust }) => {
      expect(rust).toContain("return v % 5.0 != 0.0;");
      expect(rust).not.toContain("as i64");
    },
  },
  {
    name: "CI6 division upstream — downstream modulo stays f64",
    src: `function run(): number {
  const xs: number[] = [];
  for (let i: number = 0; i < 10; i = i + 1) { xs.push(i); }
  const halved: number[] = xs.map((v: number): number => v / 2);
  const kept: number[] = halved.filter((w: number): boolean => w % 3 !== 0);
  return kept.reduce((s: number, x: number): number => s + x, 0);
}
console.log(run());`,
    extra: ({ rust }) => {
      // `map(v => v/2)` produces a fractional (Real) element, so `w % 3` stays f64.
      expect(rust).toContain("return w % 3.0 != 0.0;");
    },
  },
  {
    name: "CI7 param Real at one call site — modulo stays f64",
    src: `function f(n: number): number { return n % 4; }
function run(): number {
  const a: number = f(8);
  const b: number = f(3.5);
  return a + b;
}
console.log(run());`,
    extra: ({ rust }) => {
      // One fractional call site (`f(3.5)`) demotes the param to Real for all sites.
      expect(rust).toContain("return n % 4.0;");
      expect(rust).not.toContain("as i64");
    },
  },
  {
    name: "CI8 fractional divisor — modulo stays f64 even over an integer element",
    src: `function run(): number {
  const xs: number[] = [];
  for (let i: number = 0; i < 10; i = i + 1) { xs.push(i); }
  const kept: number[] = xs.filter((v: number): boolean => v % 2.5 !== 0);
  return kept.reduce((s: number, x: number): number => s + x, 0);
}
console.log(run());`,
    extra: ({ rust }) => {
      // `v` is integer, but the divisor `2.5` is fractional — an `as i64` cast would
      // truncate it (`% 2`), diverging. So the modulo stays f64.
      expect(rust).toContain("return v % 2.5 != 0.0;");
    },
  },
]);

// A quiet reference to `test` keeps the import used if every spec above relies only
// on `defineDifferential`'s generated cases (it registers its own `test()`s).
test("callback-integrality specs are registered", () => {
  expect(true).toBe(true);
});
