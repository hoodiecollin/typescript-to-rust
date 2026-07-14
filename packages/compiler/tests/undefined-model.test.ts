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
 * TS-via-Bun); IDs map to docs/work/066-undefined-model/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { lower } from "../src/lower";
import { runRust } from "../src/harness";
import { UnsupportedError } from "../src/errors";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

function warningsOf(src: string): string[] {
  return lower(parseSync("t.ts", src).program as unknown as Program).warnings ?? [];
}

function runTs(src: string): string {
  const proc = Bun.spawnSync(["bun", "run", "-"], {
    stdin: new TextEncoder().encode(src),
  });
  return new TextDecoder().decode(proc.stdout).trim();
}

async function behaves(src: string, expected: string): Promise<void> {
  const rust = compile(src);
  const rr = await runRust(rust);
  expect(rr.ok).toBe(true);
  expect(rr.stdout.trim()).toBe(runTs(src));
  expect(rr.stdout.trim()).toBe(expected);
}

describe("066 undefined/null model — representation & print (A, C-print)", () => {
  test("UND1 `None` prints the literal `undefined`", async () => {
    await behaves(`let x: number | undefined = undefined;\nconsole.log(x);`, "undefined");
  });

  test("UND2 `Some(v)` unwraps to the `v` render (not `Some(5)`)", async () => {
    await behaves(`let x: number | undefined = 5;\nconsole.log(x);`, "5");
  });

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

  test("UND4 a present string prints unquoted", async () => {
    await behaves(`let s: string | undefined = "hi";\nconsole.log(s);`, "hi");
  });

  test("UND5 mixed print: label + optional", async () => {
    await behaves(
      `let x: number | undefined = undefined;\nconsole.log("v:", x);\nx = 3;\nconsole.log("v:", x);`,
      "v: undefined\nv: 3",
    );
  });
});

describe("066 coercion sites (D)", () => {
  test("CO1 `x ?? 0` → unwrap_or; None yields fallback (042 regression)", async () => {
    await behaves(`let x: number | undefined = undefined;\nconsole.log(x ?? 0);`, "0");
    expect(compile(`let x: number | undefined = undefined;\nconsole.log(x ?? 0);`)).toContain(
      "unwrap_or",
    );
  });

  test("CO2 `x ?? d` is absence-only: present `0` is kept", async () => {
    await behaves(`let x: number | undefined = 0;\nconsole.log(x ?? 9);`, "0");
  });

  test("CO3 `x!` → `.unwrap()` on a present value", async () => {
    const src = `let x: number | undefined = 5;\nconst n: number = x!;\nconsole.log(n);`;
    await behaves(src, "5");
    expect(compile(src)).toContain(".unwrap()");
  });

  test("CO4 default param `f(x = 5)` → unwrap_or body", async () => {
    const src = `function f(x: number = 5): number { return x; }\nconsole.log(f(), f(2));`;
    await behaves(src, "5 2");
    expect(compile(src)).toContain("unwrap_or");
  });

  test("CO5 `x!` on `None` panics (accepted opt-in, not a miscompile)", async () => {
    const src = `let x: number | undefined = undefined;\nconst n: number = x!;\nconsole.log(n);`;
    const rr = await runRust(compile(src));
    expect(rr.ok).toBe(false);
  });
});

describe("066 JS-truthiness `||`/`&&`/`if`/`!` (E)", () => {
  test("TR1 `x || d` with present falsy `0` returns `d` (JS falsy, not unwrap_or)", async () => {
    await behaves(`let x: number = 0;\nconsole.log(x || 7);`, "7");
  });

  test("TR2 `x || d` with a truthy value returns `x`", async () => {
    await behaves(`let x: number = 3;\nconsole.log(x || 7);`, "3");
  });

  test("TR3 `\"\" || d` — empty string is falsy", async () => {
    await behaves(`let s: string = "";\nconsole.log(s || "fb");`, "fb");
  });

  test("TR4 `if (x)` on falsy number takes the else branch", async () => {
    await behaves(
      `let x: number = 0;\nif (x) { console.log("t"); } else { console.log("f"); }`,
      "f",
    );
  });

  test("TR5 `!x` uses JS truthiness", async () => {
    await behaves(`let x: number = 0;\nconsole.log(!x);`, "true");
    await behaves(`let x: number = 5;\nconsole.log(!x);`, "false");
  });

  test("TR6 `a && b` short-circuits on a falsy left (JS)", async () => {
    await behaves(`let a: number = 0;\nconsole.log(a && 5);`, "0");
  });

  test("TR7 `if (opt)` narrows on presence (absence is falsy)", async () => {
    await behaves(
      `let x: number | undefined = 5;\nif (x) { console.log("present"); } else { console.log("absent"); }`,
      "present",
    );
    await behaves(
      `let x: number | undefined = undefined;\nif (x) { console.log("present"); } else { console.log("absent"); }`,
      "absent",
    );
  });

  test("TR8 regression: boolean `&&`/`||`/`!` stay native (no is_truthy on bools)", async () => {
    const src = `const a = true;\nconst b = false;\nconsole.log(a && b || a);`;
    await behaves(src, "true");
    const rust = compile(src);
    // The bare-boolean logic must not route through the truthiness helper.
    expect(rust).not.toContain("is_truthy(a)");
    expect(rust).not.toContain("is_truthy(b)");
  });
});

describe("066 both-present divergence warning (C, 056 channel)", () => {
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
});

describe("066 emptiness is present, never absence (A)", () => {
  test("EMP1 `Option<Vec<T>>` keeps `None` vs `Some(vec![])` distinct", async () => {
    const src = `interface Box { items?: Array<number>; }
const a: Box = { items: [] };
const b: Box = {};
console.log((a.items ?? [-1]).length, (b.items ?? [-1]).length);`;
    await behaves(src, "0 1");
  });

  test("EMP2 present `0` in an optional slot is `Some(0.0)`, never `None`", () => {
    const rust = compile(`let n: number | undefined = 0;\nconsole.log(n ?? 9);`);
    expect(rust).toContain("Some(0.0)");
    expect(rust).not.toContain("let n: Option<f64> = None");
  });
});

describe("066 fail-loud residuals (D, F, B)", () => {
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
});

describe("066 narrowing forms (impl sub-detail)", () => {
  test("NR1 `if (x !== undefined)` → `if let Some(x)`; inner `T` usable (042c regression)", async () => {
    const src = `let x: number | undefined = 5;\nif (x !== undefined) { console.log(x + 1); }`;
    await behaves(src, "6");
    expect(compile(src)).toContain("if let Some(");
  });

  test("NR2 `if (x != null)` (loose) narrows the same way", async () => {
    const src = `let x: number | undefined = 5;\nif (x != null) { console.log(x + 1); }`;
    await behaves(src, "6");
    expect(compile(src)).toContain("if let Some(");
  });
});
