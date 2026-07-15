/**
 * Specs for series 042b — optional struct fields. `field?: T` (and
 * `field: T | undefined`) → an `Option<T>` struct field; a struct literal
 * `Some`-wraps a provided value and fills an omitted optional field with `None`.
 * Differential: emitted Rust compiles AND matches the TS run. IDs → specs.md.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("option-fields", [
  {
    name: "OFL2 a provided optional field is Some, an omitted one is None",
    src: `interface Config { timeout?: number; }
const c: Config = { timeout: 30 };
const d: Config = {};
console.log(c.timeout ?? 10, d.timeout ?? 10);`,
    expected: "30 10",
    extra: () => {
      expect(
        compile(`interface Config { timeout?: number; }
const d: Config = {};
console.log(d.timeout ?? 10);`),
      ).toContain("timeout: None");
    },
  },
  {
    name: "OFL3 T | undefined field form also lowers to Option",
    src: `interface Box { label: string | undefined; }
const b: Box = { label: "hi" };
console.log(b.label ?? "none");`,
    expected: "hi",
  },
]);

test("OFL1 an optional field lowers to Option<T>", () => {
  const rust = compile(`interface Config { timeout?: number; }
const c: Config = { timeout: 30 };
console.log(c.timeout ?? 10);`);
  expect(rust).toContain("timeout: Option<f64>");
  expect(rust).toContain("Some(30.0)");
});
