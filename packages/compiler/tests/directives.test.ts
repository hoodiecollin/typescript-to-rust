/**
 * Specs for series 028a — the `"use panic"` per-scope directive. A leading
 * string-literal directive switches a scope's `throw` translation from the
 * default `Result`/`?` fallibility model (021–023) to `panic!` — the function is
 * NOT `-> Result`, and callers need not `?`.
 *
 * An unrecognized `"use …"` directive fails loud (`DialectError`), never a
 * silent no-op.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";
import { DialectError } from "../src/errors";

const risky = `function risky(bad: boolean): number {
  "use panic";
  if (bad) throw new Error("boom");
  return 42;
}
console.log(risky(false));`;

defineDifferential("directives", [
  {
    name: "throw in a `use panic` scope compiles + behaves on the success path",
    src: risky,
    expected: "42",
  },
]);

test("the fn is infallible (no Result), the throw is a panic!, no directive string leaks", () => {
  const rust = compile(risky);
  expect(rust).toContain("panic!");
  expect(rust).toContain("fn risky(bad: bool) -> f64");
  expect(rust).not.toContain("Result");
  expect(rust).not.toContain('"use panic"');
});

test("a caller of a `use panic` fn does not `?`-propagate", () => {
  const rust = compile(risky);
  // main stays a plain `fn main()` — no `-> Result`, no `?` on the call.
  expect(rust).toContain("fn main() {");
  expect(rust).not.toContain("risky(false)?");
});

test("an unrecognized directive fails loud", () => {
  expect(() => compile(`function f(): void { "use frobnicate"; }`)).toThrow(
    DialectError,
  );
});
