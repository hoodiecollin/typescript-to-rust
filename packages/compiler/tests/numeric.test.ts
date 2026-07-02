/**
 * Specs for numeric inference (series 003). Drives `refineNumerics` — via real
 * lowering, so the input HIR is realistic — and asserts that values reaching an
 * array-index position become `usize`, that `usize`-ness propagates through
 * initializers and integer arithmetic, and that an int/float conflict fails loud.
 *
 * These are RED against the identity mock in `src/numeric.ts` and go GREEN when
 * the real pass lands. IDs map to docs/work/003-numeric-inference/specs.md.
 * `refineNumerics` is idempotent, so re-applying it to `lower`'s (already-refined)
 * output is safe in both phases.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import type { HirExpr, HirModule, HirStmt } from "../src/hir";
import { UnsupportedError, lower } from "../src/lower";
import { refineNumerics } from "../src/numeric";

function refined(src: string): HirModule {
  return refineNumerics(
    lower(parseSync("t.ts", src).program as unknown as Program),
  );
}

type Let = Extract<HirStmt, { kind: "let" }>;
type Num = Extract<HirExpr, { kind: "number" }>;
type Binary = Extract<HirExpr, { kind: "binary" }>;
type Index = Extract<HirExpr, { kind: "index" }>;

function letStmt(stmt: HirStmt | undefined): Let {
  if (!stmt || stmt.kind !== "let") throw new Error("expected a let statement");
  return stmt;
}

const USIZE = { kind: "usize" } as const;

/** `arr` declaration + the given trailing statements, as a script. */
function withArr(rest: string): string {
  return `const arr: Array<number> = [1, 2, 3];\n${rest}`;
}

describe("numeric inference: usize typing", () => {
  test("N1 a binding used as a variable array index becomes usize", () => {
    const m = refined(
      withArr(`const i: number = 0; const x: number = arr[i];`),
    );
    expect(letStmt(m.main[1]).ty).toEqual(USIZE);
  });

  test("N2 a usize binding's integer-literal initializer is tagged usize", () => {
    const m = refined(
      withArr(`const i: number = 0; const x: number = arr[i];`),
    );
    const init = letStmt(m.main[1]).init as Num;
    expect(init.kind).toBe("number");
    expect(init.ty).toBe("usize");
  });

  test("N3 usize-ness propagates through a let chain", () => {
    const m = refined(
      withArr(
        `const i: number = 0; const j: number = i + 1; const x: number = arr[j];`,
      ),
    );
    const i = letStmt(m.main[1]);
    const j = letStmt(m.main[2]);
    expect(i.ty).toEqual(USIZE);
    expect(j.ty).toEqual(USIZE);
    expect((i.init as Num).ty).toBe("usize");
    expect(((j.init as Binary).right as Num).ty).toBe("usize");
  });

  test("N4 usize-ness propagates within an index expression", () => {
    const m = refined(
      withArr(`const i: number = 0; const x: number = arr[i + 1];`),
    );
    const i = letStmt(m.main[1]);
    const idx = letStmt(m.main[2]).init as Index;
    expect(i.ty).toEqual(USIZE);
    expect(((idx.index as Binary).right as Num).ty).toBe("usize");
  });

  test("N5 a number not used as an index stays f64", () => {
    const m = refined(`const a: number = 1; const b: number = 2.5;`);
    expect(letStmt(m.main[0]).ty).toEqual({ kind: "f64" });
    expect((letStmt(m.main[0]).init as Num).ty).not.toBe("usize");
    expect(letStmt(m.main[1]).ty).toEqual({ kind: "f64" });
  });

  test("N6 refinement is scope-local", () => {
    const m = refined(
      `function f(arr: Array<number>): number { const i: number = 0; return arr[i]; }\n` +
        `const i: number = 0;`,
    );
    const fnBodyLet = letStmt(m.items[0]?.body[0]);
    expect(fnBodyLet.ty).toEqual(USIZE);
    // A same-named binding in another scope (main) is untouched.
    expect(letStmt(m.main[0]).ty).toEqual({ kind: "f64" });
  });
});

describe("numeric inference: fail loud on int/float conflict", () => {
  test("N7 a fractional literal index throws", () => {
    expect(() => refined(withArr(`const x: number = arr[1.5];`))).toThrow(
      UnsupportedError,
    );
  });

  test("N8 a usize binding initialized with a fractional literal throws", () => {
    expect(() =>
      refined(withArr(`const i: number = 1.5; const x: number = arr[i];`)),
    ).toThrow(UnsupportedError);
  });

  test("N9 a binding used as both an index and a float operand throws", () => {
    expect(() =>
      refined(
        withArr(
          `const k: number = 0; const y: number = k * 1.5; const x: number = arr[k];`,
        ),
      ),
    ).toThrow(UnsupportedError);
  });
});

describe("numeric inference: emission integration", () => {
  test("N10 a variable index emits `let i: usize` and bare `arr[i]`", async () => {
    const { emitModule } = await import("../src/emitter");
    const out = emitModule(
      refined(withArr(`const i: number = 0; const x: number = arr[i];`)),
    );
    expect(out).toContain("let i: usize = 0;");
    expect(out).toContain("arr[i]");
    expect(out).not.toContain("arr[i as usize]");
    expect(out).not.toContain("let i: f64");
  });
});
