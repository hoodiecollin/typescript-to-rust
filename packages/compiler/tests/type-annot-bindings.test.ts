/**
 * Specs for series 046a — untyped scalar bindings. An untyped `let`/`const` is
 * allowed iff its initializer is a *statically-obvious* scalar literal (number /
 * string / boolean); every other untyped binding (call, binary, unary-negative,
 * `null`/`undefined`, bare identifier) now fails loud with `UnsupportedError`
 * instead of silently leaking an un-checked `ty = null` to Rust's inference.
 *
 * The gate only *validates* — it leaves `ty = null` untouched, so the usize/i64
 * refinement in `numeric.ts` still keys on the binding name (TYP8).
 *
 * IDs map to docs/work/046-type-annotation-enforcement/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { UnsupportedError } from "../src/lower";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("type-annot-bindings", [
  {
    name: "TYP1 an untyped number binding lowers (Rust infers f64)",
    src: `const n = 5;\nconsole.log(n);`,
    expected: "5",
    extra: ({ rust }) => {
      // No type annotation is emitted — Rust infers the binding.
      expect(rust).toContain("let n = 5");
      expect(rust).not.toContain("let n:");
    },
  },
  {
    name: "TYP2 an untyped string binding lowers (String)",
    src: `const s = "hi";\nconsole.log(s);`,
    expected: "hi",
  },
  {
    name: "TYP3 an untyped boolean binding lowers (bool)",
    src: `const b = true;\nconsole.log(b);`,
    expected: "true",
  },
  {
    name: "TYP8 an untyped trivial-literal index still refines to usize",
    src: `const i = 0;\nconst arr = [10, 20];\nconsole.log(arr[i]);`,
    expected: "10",
    extra: ({ rust }) => {
      // The gate left `ty = null`, so the usize fixpoint could still retype `i`.
      expect(rust).toContain("let i: usize = 0");
    },
  },
]);

// 046a's "untyped non-literal binding fails loud" rule was RELAXED by series 099
// (inference tier): a call / binary / unary-negative initializer whose type the
// lib-backed oracle infers to a modeled `RustType` now compiles instead of failing
// loud. TYP4/TYP5/TYP6 (formerly fail-loud pins) now infer `f64` — the graduation
// is covered by inference-tier.test.ts (INF1-8). What stays fail-loud (TYP7) is an
// initializer whose inferred type is NOT modeled (`null`/`undefined` alone).
describe("046a→099 untyped non-literal bindings now infer", () => {
  test("TYP4 a call initializer infers (graduated by 099)", () => {
    expect(() =>
      compile(`function f(): number { return 1; }\nconst x = f();\nconsole.log(x);`),
    ).not.toThrow();
  });

  test("TYP5 a binary-expression initializer infers (graduated by 099)", () => {
    expect(() =>
      compile(`const a: number = 1;\nconst b: number = 2;\nconst x = a + b;`),
    ).not.toThrow();
  });

  test("TYP6 a unary-negative initializer infers (graduated by 099)", () => {
    expect(() => compile(`const x = -5;\nconsole.log(x);`)).not.toThrow();
  });

  test("TYP7 `null`/`undefined` initializers stay fail-loud (unmodeled)", () => {
    expect(() => compile(`const x = null;`)).toThrow(UnsupportedError);
    expect(() => compile(`const y = undefined;`)).toThrow(UnsupportedError);
  });
});
