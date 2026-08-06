/**
 * Characterization specs for emission (HIR → string). See
 * series 002. The emitter is pure and total, so
 * these build HIR literals directly — no parser, no cargo — and assert the exact
 * Rust rendered. Backfill: GREEN-from-start. IDs map to specs.md.
 */

import { describe, expect, test } from "bun:test";
import { emitModule } from "../src/emitter";
import type { HirExpr, HirFn, HirModule, HirStmt } from "../src/hir";

/** Emit a module whose `main` is a single expression statement. */
function emitExprStmt(expr: HirExpr): string {
  const stmt: HirStmt = { kind: "expr", expr };
  const mod: HirModule = { items: [], main: [stmt] };
  return emitModule(mod);
}

/** Emit a module with a single function item. */
function emitFn(fn: HirFn): string {
  const mod: HirModule = { items: [fn], main: [] };
  return emitModule(mod);
}

function fn(overrides: Partial<HirFn>): HirFn {
  return {
    kind: "fn",
    name: "f",
    isAsync: false,
    params: [],
    ret: { kind: "unit" },
    body: [],
    ...overrides,
  };
}

describe("emission: literals", () => {
  test("E1 integer number gets an explicit .0; a float is verbatim", () => {
    expect(emitExprStmt({ kind: "number", value: 1 })).toContain("1.0;");
    expect(emitExprStmt({ kind: "number", value: 1.5 })).toContain("1.5;");
  });

  test("E2 string emits as an owned String", () => {
    expect(emitExprStmt({ kind: "string", value: "hi" })).toContain(
      `"hi".to_string()`,
    );
  });
});

describe("emission: types", () => {
  test("E3 ref renders &T; mutable ref renders &mut T", () => {
    const shared = emitFn(
      fn({
        params: [
          {
            name: "a",
            ty: {
              kind: "ref",
              mut: false,
              inner: { kind: "vec", elem: { kind: "f64" } },
            },
          },
        ],
      }),
    );
    expect(shared).toContain("a: &Vec<f64>");

    const mutable = emitFn(
      fn({
        params: [
          {
            name: "a",
            ty: {
              kind: "ref",
              mut: true,
              inner: { kind: "vec", elem: { kind: "f64" } },
            },
          },
        ],
      }),
    );
    expect(mutable).toContain("a: &mut Vec<f64>");
  });

  test("E7 unit return is elided; a non-unit return renders -> T", () => {
    expect(emitFn(fn({ ret: { kind: "unit" } }))).not.toContain("->");
    expect(emitFn(fn({ ret: { kind: "f64" } }))).toContain("-> f64");
  });

  test("E8 an async function renders `async fn`", () => {
    expect(emitFn(fn({ isAsync: true }))).toContain("async fn f");
  });
});

describe("emission: expressions", () => {
  test("E4 a literal integer index is bare usize, never f64", () => {
    const out = emitExprStmt({
      kind: "index",
      object: { kind: "ident", name: "a" },
      index: { kind: "number", value: 0 },
    });
    expect(out).toContain("a[0]");
    expect(out).not.toContain("a[0.0]");
  });

  test("E5 println emits a space-separated JS-style format string", () => {
    const out = emitExprStmt({
      kind: "println",
      args: [
        { kind: "ident", name: "x" },
        { kind: "ident", name: "y" },
      ],
    });
    expect(out).toContain(`println!("{} {}", x, y)`);
  });

  test("E6 call-arg borrow renders &mut / & / (none)", () => {
    const refMut = emitExprStmt({
      kind: "call",
      callee: "g",
      args: [{ borrow: "refMut", expr: { kind: "ident", name: "n" } }],
    });
    expect(refMut).toContain("g(&mut n)");

    const shared = emitExprStmt({
      kind: "call",
      callee: "g",
      args: [{ borrow: "ref", expr: { kind: "ident", name: "n" } }],
    });
    expect(shared).toContain("g(&n)");

    const owned = emitExprStmt({
      kind: "call",
      callee: "g",
      args: [{ borrow: "owned", expr: { kind: "ident", name: "n" } }],
    });
    expect(owned).toContain("g(n)");
  });
});
