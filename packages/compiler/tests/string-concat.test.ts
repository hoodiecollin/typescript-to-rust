/**
 * Specs for series 080 — string concatenation (`+`) → `format!`. A `+` with a
 * provably-string operand lowers to `format!("{}{}…", …)`; a numeric `+` is
 * untouched. Graduates #47 (`String + String` for field / method-result operands).
 *
 * IDs map to docs/work/080-string-concat/specs.md (SCAT1–SCAT7).
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

const PERSON = `class Person {
  name: string;
  constructor(n: string) { this.name = n; }
  greet(): string { return "hi " + this.name; }
}`;

defineDifferential("string-concat", [
  {
    name: "SCAT1 literal + field; differential",
    src: `${PERSON}\nconsole.log(new Person("al").greet());`,
    expected: "hi al",
  },
  {
    name: "SCAT2 method-result LHS, chained concat; differential",
    src: `${PERSON}\nfunction g(x: Person): string { return x.greet() + "/" + x.name; }\nconsole.log(g(new Person("al")));`,
    expected: "hi al/al",
  },
  {
    name: "SCAT3 two String locals; differential",
    src: `const a = "x"; const b = "y"; console.log(a + b);`,
    expected: "xy",
  },
  {
    name: 'SCAT4 number coercion ("n=" + n); differential',
    src: `const n = 5; console.log("n=" + n);`,
    expected: "n=5",
  },
  {
    name: "SCAT5 parenthesized numeric subtree preserved; differential",
    src: `const a = 2, b = 3; console.log("x" + (a + b));`,
    expected: "x5",
  },
  {
    name: "SCAT7 regression: numeric + is not turned into format!",
    src: `const a = 1, b = 2; console.log(a + b);`,
    expected: "3",
    extra: ({ rust }) => expect(rust).not.toContain("format!"),
  },
]);

test("SCAT6 emits format! and no bare `String +` for the string parts", () => {
  const rust = compile(
    `${PERSON}\nfunction g(x: Person): string { return x.greet() + "/" + x.name; }\nconsole.log(g(new Person("al")));`,
  );
  expect(rust).toContain("format!(");
  expect(rust).not.toContain(".to_string() + ");
});
