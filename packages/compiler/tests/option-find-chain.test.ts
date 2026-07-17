/**
 * Specs for series 042d — `Array.find` → `Option<T>` and single-level optional
 * chaining `a?.b` → `a.map(|v| v.b)`. Both consume via `??`/narrowing.
 * Differential + shape assertions. IDs → specs.md.
 */

import { describe, expect, test } from "bun:test";
import { UnsupportedError } from "../src/emitter";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("option-find-chain", [
  {
    name: "FND1 find returns the matching element via ??",
    src: `const xs: Array<number> = [1, 2, 3];
const found = xs.find(x => x > 1);
console.log(found ?? -1);`,
    expected: "2",
    extra: ({ rust }) => {
      expect(rust).toContain(".find(");
      expect(rust).toContain(".copied()");
    },
  },
  {
    name: "FND2 find with no match is None → fallback",
    src: `const xs: Array<number> = [1, 2, 3];
const found = xs.find(x => x > 9);
console.log(found ?? -1);`,
    expected: "-1",
  },
  {
    name: "FND3 find result narrows with if let",
    src: `const xs: Array<number> = [5, 6, 7];
const found = xs.find(x => x > 5);
if (found !== undefined) {
  console.log(found * 10);
} else {
  console.log(0);
}`,
    expected: "60",
  },
  {
    name: "CHN1 a?.b maps over an optional struct",
    src: `interface Point { x: number; }
const p: Point | undefined = { x: 42 };
console.log((p?.x) ?? -1);`,
    expected: "42",
    extra: ({ rust }) => expect(rust).toContain(".map(|v| v.x)"),
  },
  {
    name: "CHN2 a?.b on an absent value is None",
    src: `interface Point { x: number; }
const p: Point | undefined = undefined;
console.log((p?.x) ?? -1);`,
    expected: "-1",
  },
]);

describe("042d optional chaining a?.b", () => {
  test("CHN3 a deeper chain is fail-loud", () => {
    // The deeper-chain guard lives in the *expression* lowering (042d), so the
    // un-annotated `y` binding infers `option<f64>` (series 099) — passing the
    // annotation gate — and the throw comes from the real deeper-chain guard, not
    // the annotation requirement. (`a` is a genuine `A | undefined`, not provably
    // `undefined`, so inference lands on `option`.)
    expect(() =>
      compile(`interface A { b: B; }
interface B { c: number; }
const bb: B = { c: 42 };
const aa: A = { b: bb };
const a: A | undefined = aa;
const y = a?.b?.c;`),
    ).toThrow(UnsupportedError);
  });
});
