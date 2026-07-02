/**
 * Specs for string-borrow inference (series 004). Drives `refineStrings` — via
 * real lowering, so the input HIR is realistic — and asserts that a read-only
 * `string` parameter becomes the idiomatic `&str`, while a mutated (`&mut
 * String`), moved (owned `String`), or non-string reference parameter is left
 * untouched.
 *
 * These are RED against the identity mock in `src/strings.ts` and go GREEN when
 * the real pass lands. IDs map to docs/work/004-str-borrows/specs.md.
 * `refineStrings` is idempotent, so re-applying it to `lower`'s (already-refined)
 * output is safe in both phases.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import type { HirModule, RustType } from "../src/hir";
import { lower } from "../src/lower";
import { refineStrings } from "../src/strings";

function refined(src: string): HirModule {
  return refineStrings(
    lower(parseSync("t.ts", src).program as unknown as Program),
  );
}

/** The type of function `index`'s parameter `param`. */
function paramTy(m: HirModule, index: number, param: number): RustType {
  const item = m.items[index];
  if (!item || item.kind !== "fn") throw new Error("expected a function item");
  const p = item.params[param];
  if (!p) throw new Error("expected a function parameter");
  return p.ty;
}

const STR_REF: RustType = { kind: "ref", mut: false, inner: { kind: "str" } };
const MUT_STRING: RustType = {
  kind: "ref",
  mut: true,
  inner: { kind: "String" },
};
const VEC_REF: RustType = {
  kind: "ref",
  mut: false,
  inner: { kind: "vec", elem: { kind: "f64" } },
};

describe("string-borrow inference: &str for read-only params", () => {
  test("S1 a read-only string parameter lowers to &str", () => {
    const m = refined(
      `function greet(name: string): void { console.log(name); }`,
    );
    expect(paramTy(m, 0, 0)).toEqual(STR_REF);
  });

  test("S2 a mutated string parameter stays &mut String", () => {
    const m = refined(
      `function shout(s: string): void { s = s + "!"; console.log(s); }`,
    );
    expect(paramTy(m, 0, 0)).toEqual(MUT_STRING);
  });

  test("S3 a moved (unused) string parameter stays owned String", () => {
    const m = refined(`function drop(s: string): void {}`);
    expect(paramTy(m, 0, 0)).toEqual({ kind: "String" });
  });

  test("S4 a non-string reference parameter is untouched", () => {
    const m = refined(
      `function printLen(arr: Array<number>): void { console.log(arr.length); }`,
    );
    expect(paramTy(m, 0, 0)).toEqual(VEC_REF);
  });

  test("S5 refinement touches every function independently", () => {
    const m = refined(
      `function a(x: string): void { console.log(x); }\n` +
        `function b(y: string): void { console.log(y); }`,
    );
    expect(paramTy(m, 0, 0)).toEqual(STR_REF);
    expect(paramTy(m, 1, 0)).toEqual(STR_REF);
  });

  test("S6 the pass is idempotent", () => {
    const m = refined(
      `function greet(name: string): void { console.log(name); }`,
    );
    const before = paramTy(m, 0, 0);
    refineStrings(m);
    expect(paramTy(m, 0, 0)).toEqual(before);
    expect(paramTy(m, 0, 0)).toEqual(STR_REF);
  });
});
