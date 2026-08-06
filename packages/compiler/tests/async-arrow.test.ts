/**
 * Specs for series 054b — top-level `const` `async` arrows (AM9–AM13). A
 * `const f = async (…) => …` normalizes (before analysis) into an `async fn`,
 * flowing through the async free-fn path (awaitable via `.await`). The `=> expr`
 * body desugars to `{ return <expr>; }`. A `let`-bound / value-position async
 * arrow stays fail-loud (the arrow deferral boundary). IDs map to
 * series 054.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("async-arrow", [
  {
    name: "AM10 (differential) a normalized async arrow is awaitable",
    src: `const f = async (id: number): Promise<number> => { return id + 100; };\nconst x: number = await f(3);\nconsole.log(x);`,
    expected: "103",
    extra: ({ rust }) => expect(rust).toContain("f(3.0).await"),
  },
  {
    name: "AM11 (differential) an expression-body async arrow desugars + behaves",
    src: `const dbl = async (n: number): Promise<number> => n * 2;\nconst x: number = await dbl(4);\nconsole.log(x);`,
    expected: "8",
    extra: ({ rust }) => expect(rust).toContain("async fn dbl(n: f64) -> f64"),
  },
]);

test("AM9 a top-level async arrow emits a free async fn", () => {
  const rust = compile(
    `const f = async (id: number): Promise<string> => { return "row"; };\nconst x: string = await f(3);\nconsole.log(x);`,
  );
  expect(rust).toContain("async fn f(id: f64) -> String");
});

test("AM12 a top-level await of an async arrow makes a tokio runtime main", () => {
  const rust = compile(
    `const f = async (): Promise<number> => 1;\nconst x: number = await f();\nconsole.log(x);`,
  );
  expect(rust).toContain("#[tokio::main]");
  expect(rust).toContain("async fn main()");
});

test("AM13 (fail-loud) a value-position async arrow stays rejected", () => {
  // An async arrow that is not a top-level `const` binding (here passed as an
  // argument) is not normalized and hits the arrow deferral boundary.
  const src = `function run(cb: () => number): number { return cb(); }\nrun(async () => 1);`;
  expect(() => compile(src)).toThrow();
});
