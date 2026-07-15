/**
 * Specs for series 034 — inter-procedural ownership, first increment:
 * use-after-move → `.clone()`. A non-Copy, Clone-able binding (String, Vec) that
 * is *moved* (bound to another `let`, or passed as an owned call/ctor argument)
 * and then **used again** is cloned at the move site, so the original stays live.
 * The textually-last use is left as a bare move (no needless clone).
 *
 * Differential: emitted Rust compiles AND matches the TS run.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("ownership-clone", [
  {
    name: "a String moved into a let, then reused, is cloned",
    src: `const a: string = "hello";
const b: string = a;
console.log(a);
console.log(b);`,
    expected: "hello\nhello",
    extra: ({ rust }) => expect(rust).toContain("a.clone()"),
  },
  {
    name: "a Vec moved into a let, then reused, is cloned",
    src: `const xs: Array<number> = [1, 2, 3];
const ys: Array<number> = xs;
console.log(xs.length);
console.log(ys.length);`,
    expected: "3\n3",
  },
  {
    // `take` doesn't use its param → it takes ownership (a `move` param), so the
    // first call moves `s`; the reuse forces a clone at the first call site.
    name: "an owned argument moved then reused is cloned",
    src: `function take(s: string): void {}
const s: string = "hi";
take(s);
console.log(s);`,
    expected: "hi",
  },
  {
    name: "two moves of the same binding clone all but the last",
    src: `function take(s: string): void {}
const s: string = "hi";
take(s);
take(s);
console.log(s.length);`,
    expected: "2",
  },
]);

test("the last use is NOT cloned (no needless clone)", () => {
  const src = `const a: string = "x";
const b: string = a;
console.log(b);`;
  const rust = compile(src);
  expect(rust).not.toContain("a.clone()");
  expect(rust).toContain("= a;");
});
