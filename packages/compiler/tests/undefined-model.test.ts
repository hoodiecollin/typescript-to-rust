/**
 * Specs for series 066 — first-class `undefined`/`null` as `Option<T>`. Graduates
 * the absence model (design decisions A–F, issue #42): `null ≡ undefined` collapse
 * to a single `Option::None`, JS-truthiness for `||`/`&&`/`if`/`!` via one shared
 * `is_truthy` helper, `??`/default-param/`x!` coercion sites, the both-present
 * (`T | null | undefined`) 056 warning, and the fail-loud arithmetic-on-optional
 * residual. Canonical `None` print spelling is the literal `undefined`.
 *
 * Reuses the series 042 machinery (`Option<T>` type lowering, `Some`/`None`
 * boundary wrapping, `!== undefined` narrowing → `if let Some`, `??` → `unwrap_or`)
 * and extends it. Each behavioral spec differential-matches (compile → cargo run →
 * TS-via-Bun); IDs map to series 066.
 */

import { expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { lower } from "../src/lower";
import { runRust } from "../src/harness";
import { UnsupportedError } from "../src/errors";
import { defineDifferential } from "./_support/differential";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

function warningsOf(src: string): string[] {
  return lower(parseSync("t.ts", src).program as unknown as Program).warnings ?? [];
}

defineDifferential("undefined-model", [
  {
    name: "UND1 `None` prints the literal `undefined`",
    src: `let x: number | undefined = undefined;\nconsole.log(x);`,
    expected: "undefined",
  },
  {
    name: "UND2 `Some(v)` unwraps to the `v` render (not `Some(5)`)",
    src: `let x: number | undefined = 5;\nconsole.log(x);`,
    expected: "5",
  },
  {
    name: "UND4 a present string prints unquoted",
    src: `let s: string | undefined = "hi";\nconsole.log(s);`,
    expected: "hi",
  },
  {
    name: "UND5 mixed print: label + optional",
    src: `let x: number | undefined = undefined;\nconsole.log("v:", x);\nx = 3;\nconsole.log("v:", x);`,
    expected: "v: undefined\nv: 3",
  },
  {
    name: "CO1 `x ?? 0` → unwrap_or; None yields fallback (042 regression)",
    src: `let x: number | undefined = undefined;\nconsole.log(x ?? 0);`,
    expected: "0",
    extra: ({ rust }) => expect(rust).toContain("unwrap_or"),
  },
  {
    name: "CO2 `x ?? d` is absence-only: present `0` is kept",
    src: `let x: number | undefined = 0;\nconsole.log(x ?? 9);`,
    expected: "0",
  },
  {
    name: "CO3 `x!` → `.unwrap()` on a present value",
    src: `let x: number | undefined = 5;\nconst n: number = x!;\nconsole.log(n);`,
    expected: "5",
    extra: ({ rust }) => expect(rust).toContain(".unwrap()"),
  },
  {
    name: "CO4 default param `f(x = 5)` → unwrap_or body",
    src: `function f(x: number = 5): number { return x; }\nconsole.log(f(), f(2));`,
    expected: "5 2",
    extra: ({ rust }) => expect(rust).toContain("unwrap_or"),
  },
  {
    name: "CO5 `x!` on `None` panics (accepted opt-in, not a miscompile)",
    src: `let x: number | undefined = undefined;\nconst n: number = x!;\nconsole.log(n);`,
    expectFail: true,
  },
  {
    name: "TR1 `x || d` with present falsy `0` returns `d` (JS falsy, not unwrap_or)",
    src: `let x: number = 0;\nconsole.log(x || 7);`,
    expected: "7",
  },
  {
    name: "TR2 `x || d` with a truthy value returns `x`",
    src: `let x: number = 3;\nconsole.log(x || 7);`,
    expected: "3",
  },
  {
    name: "TR3 `\"\" || d` — empty string is falsy",
    src: `let s: string = "";\nconsole.log(s || "fb");`,
    expected: "fb",
  },
  {
    name: "TR4 `if (x)` on falsy number takes the else branch",
    src: `let x: number = 0;\nif (x) { console.log("t"); } else { console.log("f"); }`,
    expected: "f",
  },
  {
    name: "TR5 `!x` uses JS truthiness (variant 1)",
    src: `let x: number = 0;\nconsole.log(!x);`,
    expected: "true",
  },
  {
    name: "TR5 `!x` uses JS truthiness (variant 2)",
    src: `let x: number = 5;\nconsole.log(!x);`,
    expected: "false",
  },
  {
    name: "TR6 `a && b` short-circuits on a falsy left (JS)",
    src: `let a: number = 0;\nconsole.log(a && 5);`,
    expected: "0",
  },
  {
    name: "TR7 `if (opt)` narrows on presence (absence is falsy) (variant 1)",
    src: `let x: number | undefined = 5;\nif (x) { console.log("present"); } else { console.log("absent"); }`,
    expected: "present",
  },
  {
    name: "TR7 `if (opt)` narrows on presence (absence is falsy) (variant 2)",
    src: `let x: number | undefined = undefined;\nif (x) { console.log("present"); } else { console.log("absent"); }`,
    expected: "absent",
  },
  {
    name: "TR8 regression: boolean `&&`/`||`/`!` stay native (no is_truthy on bools)",
    src: `const a = true;\nconst b = false;\nconsole.log(a && b || a);`,
    expected: "true",
    extra: ({ rust }) => {
      // The bare-boolean logic must not route through the truthiness helper.
      expect(rust).not.toContain("is_truthy(a)");
      expect(rust).not.toContain("is_truthy(b)");
    },
  },
  {
    name: "EMP1 `Option<Vec<T>>` keeps `None` vs `Some(vec![])` distinct",
    src: `interface Box { items?: Array<number>; }
const a: Box = { items: [] };
const b: Box = {};
console.log((a.items ?? [-1]).length, (b.items ?? [-1]).length);`,
    expected: "0 1",
  },
  {
    name: "NR1 `if (x !== undefined)` → `if let Some(x)`; inner `T` usable (042c regression)",
    src: `let x: number | undefined = 5;\nif (x !== undefined) { console.log(x + 1); }`,
    expected: "6",
    extra: ({ rust }) => expect(rust).toContain("if let Some("),
  },
  {
    name: "NR2 `if (x != null)` (loose) narrows the same way",
    src: `let x: number | undefined = 5;\nif (x != null) { console.log(x + 1); }`,
    expected: "6",
    extra: ({ rust }) => expect(rust).toContain("if let Some("),
  },
]);

test("UND3 `null` and `undefined` both collapse to `None` → print `undefined`", async () => {
  // Both spellings collapse to `Option::None`, whose canonical print is
  // `undefined` (design C). A source `null` therefore renders `undefined` — a
  // *deliberate* divergence from JS (which prints `null`), so this pins the Rust
  // output directly rather than differential-matching.
  const src = `let a: string | null = null;\nlet b: string | undefined = undefined;\nconsole.log(a, b);`;
  const rr = await runRust(compile(src));
  expect(rr.ok).toBe(true);
  expect(rr.stdout.trim()).toBe("undefined undefined");
});

test("WARN1 `T | null | undefined` compiles with a non-fatal warning", () => {
  const src = `let y: number | null | undefined = 3;\nconsole.log(y);`;
  // compiles (→ Option<f64>)
  expect(() => compile(src)).not.toThrow();
  expect(warningsOf(src).some((w) => /null.*undefined|undefined.*null/i.test(w))).toBe(true);
});

test("WARN2 a single-spelling union warns nothing", () => {
  const src = `let x: number | undefined = 3;\nconsole.log(x);`;
  expect(warningsOf(src).some((w) => /null.*undefined|undefined.*null/i.test(w))).toBe(false);
});

test("EMP2 present `0` in an optional slot is `Some(0.0)`, never `None`", () => {
  const rust = compile(`let n: number | undefined = 0;\nconsole.log(n ?? 9);`);
  expect(rust).toContain("Some(0.0)");
  expect(rust).not.toContain("let n: Option<f64> = None");
});

test("FL1 un-narrowed optional in arithmetic → UnsupportedError", () => {
  expect(() =>
    compile(`let x: number | undefined = 5;\nconsole.log(x + 1);`),
  ).toThrow(UnsupportedError);
});

test("FL2 un-narrowed optional passed to a `T`-expecting callee → UnsupportedError", () => {
  expect(() =>
    compile(
      `function g(n: number): void {}\nlet x: number | undefined = 5;\ng(x);`,
    ),
  ).toThrow(UnsupportedError);
});

test("FL3 bare/unannotated absence (a `null` type) stays fail-loud", () => {
  expect(() => compile(`let x: null = null;\nconsole.log(x);`)).toThrow(
    UnsupportedError,
  );
});

test("FL4 un-narrowed optional used as a bare `T` value position → UnsupportedError", () => {
  // `Math.abs`-style: an optional flowing where a plain number is required.
  expect(() =>
    compile(`let x: number | undefined = 5;\nlet y: number = x * 2;\nconsole.log(y);`),
  ).toThrow(UnsupportedError);
});
