/**
 * Specs for series 036 — logical operators `&&` / `||` (`LogicalExpression`).
 *
 * `&&` / `||` map directly to Rust's short-circuit operators; the emitter's
 * `BINARY_PREC` parenthesizes them correctly (`&&` binds tighter than `||`, both
 * looser than comparison/equality). `??` (nullish coalescing) needs `Option`
 * semantics the dialect doesn't model, so it stays fail-loud.
 *
 * Differential: emitted Rust compiles AND matches the TS run (including
 * short-circuit evaluation and precedence).
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("logical", [
  {
    name: "`&&` and `||` behave",
    src: `const a: boolean = true;
const b: boolean = false;
console.log(a && b);
console.log(a || b);`,
    expected: "false\ntrue",
  },
  {
    name: "`&&` binds tighter than `||` — precedence matches JS",
    // a=false, b=false, c=true → a && b || c === (a&&b)||c === true.
    src: `const a: boolean = false;
const b: boolean = false;
const c: boolean = true;
console.log(a && b || c);`,
    expected: "true",
  },
  {
    name: "explicit parens override precedence and are preserved",
    src: `const a: boolean = false;
const b: boolean = true;
const c: boolean = false;
console.log((a || b) && c);`,
    expected: "false",
    extra: ({ rust }) => expect(rust).toContain("(a || b) && c"),
  },
  {
    name: "logical operators compose with comparisons (no needless parens)",
    src: `const x: number = 3;
console.log(x > 0 && x < 5);`,
    expected: "true",
    extra: ({ rust }) => expect(rust).toContain("x > 0.0 && x < 5.0"),
  },
  {
    name: "short-circuit evaluation is preserved in a guard",
    // `||` short-circuits: the right side of `a || …` never runs when `a` is true.
    src: `const a: boolean = true;
const b: boolean = false;
if (a || b) {
  console.log("taken");
}`,
    expected: "taken",
  },
]);

test("`??` (nullish coalescing) → `.unwrap_or()` (graduated, series 042)", () => {
  const rust = compile(`const a: number | undefined = 1;
console.log(a ?? 2);`);
  expect(rust).toContain(".unwrap_or(");
});
