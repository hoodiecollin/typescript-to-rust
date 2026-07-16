/**
 * Characterization specs for lowering (AST → HIR). See
 * docs/work/002-hir-characterization-specs. Backfill: GREEN-from-start (the impl
 * predates the spec-first rule), pinning the HIR shape so a regression that still
 * compiles cannot slip past the cargo-backed fixture suite. IDs map to specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import type { HirExpr, HirFn, HirModule, HirStmt } from "../src/hir";
import { UnsupportedError, lower } from "../src/lower";

function hir(src: string): HirModule {
  return lower(parseSync("t.ts", src).program as unknown as Program);
}

/** First item, asserted to be a function. */
function firstFn(m: HirModule): HirFn {
  const fn = m.items[0];
  if (!fn || fn.kind !== "fn") throw new Error("expected a function item");
  return fn;
}

const VEC_F64 = { kind: "vec", elem: { kind: "f64" } } as const;

describe("lowering: parameter ownership folds into the type", () => {
  test("L1 read-only non-Copy param → &T", () => {
    const fn = firstFn(
      hir(`function f(arr: Array<number>): void { console.log(arr.length); }`),
    );
    expect(fn.params[0]?.ty).toEqual({
      kind: "ref",
      mut: false,
      inner: VEC_F64,
    });
  });

  test("L2 mutated non-Copy param → &mut T", () => {
    const fn = firstFn(
      hir(`function f(arr: Array<number>): void { arr.push(0); }`),
    );
    expect(fn.params[0]?.ty).toEqual({
      kind: "ref",
      mut: true,
      inner: VEC_F64,
    });
  });

  test("L3 Copy param (number) keeps its base type, no borrow", () => {
    const fn = firstFn(hir(`function f(n: number): number { return n + 1; }`));
    expect(fn.params[0]?.ty).toEqual({ kind: "f64" });
  });
});

describe("lowering: type resolution", () => {
  test("L4 void return → unit", () => {
    expect(firstFn(hir(`function f(): void {}`)).ret).toEqual({ kind: "unit" });
  });

  test("L5 Array<number> → Vec<f64>", () => {
    const fn = firstFn(
      hir(`function f(a: Array<number>): void { console.log(a.length); }`),
    );
    expect(fn.params[0]?.ty).toMatchObject({ inner: VEC_F64 });
  });
});

describe("lowering: local mutability is baked onto let", () => {
  test("L6 reassigned local is mut; const is not", () => {
    const reassigned = hir(`let x: number = 0; x = 1;`).main[0] as Extract<
      HirStmt,
      { kind: "let" }
    >;
    expect(reassigned).toMatchObject({ kind: "let", name: "x", mut: true });

    const constant = hir(`const y: number = 0;`).main[0] as Extract<
      HirStmt,
      { kind: "let" }
    >;
    expect(constant.mut).toBe(false);
  });
});

describe("lowering: call-site borrow is baked onto the argument", () => {
  test("L7 arg at &mut position → refMut; at move position → owned", () => {
    const refMut = hir(
      `function g(arr: Array<number>): void { arr.push(0); }\n` +
        `const n: Array<number> = [1]; g(n);`,
    ).main[1] as Extract<HirStmt, { kind: "expr" }>;
    const refMutCall = refMut.expr as Extract<HirExpr, { kind: "call" }>;
    expect(refMutCall.kind).toBe("call");
    expect(refMutCall.args[0]?.borrow).toBe("refMut");

    const owned = hir(
      `function g(arr: Array<number>): void {}\n` +
        `const n: Array<number> = [1]; g(n);`,
    ).main[1] as Extract<HirStmt, { kind: "expr" }>;
    const ownedCall = owned.expr as Extract<HirExpr, { kind: "call" }>;
    expect(ownedCall.args[0]?.borrow).toBe("owned");
  });
});

describe("lowering: node kinds", () => {
  test("L8 console.log → println node", () => {
    const stmt = hir(`console.log(1);`).main[0] as Extract<
      HirStmt,
      { kind: "expr" }
    >;
    expect(stmt.expr.kind).toBe("println");
  });

  test("L9 .length → len node; a[0] → index node", () => {
    const m = hir(
      `const a: Array<number> = [1]; const l: number = a.length; const e: number = a[0];`,
    );
    const lenLet = m.main[1] as Extract<HirStmt, { kind: "let" }>;
    const idxLet = m.main[2] as Extract<HirStmt, { kind: "let" }>;
    expect(lenLet.init.kind).toBe("len");
    expect(idxLet.init.kind).toBe("index");
  });
});

describe("lowering: module structure", () => {
  test("L10 declarations → items, statements → main", () => {
    const m = hir(`function f(): void {}\nconst x: number = 1;`);
    expect(m.items).toHaveLength(1);
    expect(m.main).toHaveLength(1);
  });
});

describe("lowering: fail-loud gates (L11)", () => {
  test("top-level statements alongside a user-defined main() throw", () => {
    expect(() => hir(`function main(): void {}\nconst x: number = 1;`)).toThrow(
      UnsupportedError,
    );
  });

  test("a parameter without a type annotation throws", () => {
    expect(() => hir(`function f(a): void {}`)).toThrow(UnsupportedError);
  });

  test("a union of two real types lowers to an enum (series 093)", () => {
    // `null`/`undefined` lower to `None` (series 042); a union of two *real* types
    // is now a Rust `enum` (series 093 — `number | string` is a primitive/mixed
    // union F, narrowed by `typeof`), no longer fail-loud.
    expect(() => hir(`const x: number | string = 5;`)).not.toThrow();
  });
});
