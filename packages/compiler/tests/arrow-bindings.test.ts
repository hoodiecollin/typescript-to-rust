/**
 * Specs for series 058 — arrow binding deferrals.
 *
 * A `let`/`var`/local-`const` arrow lifts to a free `fn` (top-level, non-reassigned)
 * or a hoisted `fn __arrow_n` + `fn`-pointer binding (nested / reassigned). Multiple
 * declarators split per binding; a `({x, y}: Point)` destructuring param becomes a
 * Rust struct-pattern param. Rest params, capturing arrows, and anonymous-object
 * destructured params stay fail-loud.
 *
 * Differential: emitted Rust compiles AND matches the TS run, plus emitted-text and
 * fail-loud checks.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("arrow-bindings", [
  {
    name: "`let`-bound arrow → direct free fn",
    src: `let f = (n: number): number => n + 1;\nconsole.log(f(2));`,
    expected: "3",
    extra: ({ rust }) => expect(rust).toContain("fn f(n: f64) -> f64"),
  },
  {
    name: "reassigned fn-value binding → `let mut` fn-pointer",
    src: `function add(a: number, b: number): number { return a + b; }
function sub(a: number, b: number): number { return a - b; }
let op = add;
op = sub;
console.log(op(5, 2));`,
    expected: "3",
    extra: ({ rust }) => expect(rust).toContain("let mut op: fn(f64, f64) -> f64 = add"),
  },
  {
    name: "multiple declarators split per binding",
    src: `const f = (x: number): number => x + 1, g = (x: number): number => x * 2;
console.log(f(3));
console.log(g(3));`,
    expected: "4\n6",
  },
  {
    name: "destructuring param → struct-pattern param",
    src: `interface Point { x: number; y: number; }
const dist = ({ x, y }: Point): number => x * x + y * y;
const p: Point = { x: 3, y: 4 };
console.log(dist(p));`,
    expected: "25",
    extra: ({ rust }) => expect(rust).toContain("fn dist(Point { x, y }: Point)"),
  },
  {
    name: "local (nested-scope) arrow → hoisted `__arrow_n` + fn-pointer binding",
    src: `function run(): number {
  const f = (n: number): number => n + 1;
  return f(2);
}
console.log(run());`,
    expected: "3",
    extra: ({ rust }) => {
      expect(rust).toContain("fn __arrow_0(n: f64) -> f64");
      expect(rust).toContain("let f: fn(f64) -> f64 = __arrow_0");
    },
  },
  {
    name: "async top-level `let` arrow → direct `async fn`",
    src: `let load = async (): Promise<number> => 1;\nconsole.log(await load());`,
    expected: "1",
    extra: ({ rust }) => expect(rust).toContain("async fn load() -> f64"),
  },
  {
    name: "regression: top-level `const` arrow still promotes to a direct fn",
    src: `const inc = (n: number): number => n + 1;\nconsole.log(inc(4));`,
    expected: "5",
    extra: ({ rust }) => expect(rust).toContain("fn inc(n: f64) -> f64"),
  },
]);

test("capturing arrow → fail-loud (a promoted free fn cannot capture)", () => {
  // A promoted/hoisted arrow becomes a free fn, which cannot capture — the
  // captured scalar `base` is out of scope. The dialect rejects this at
  // compile-to-Rust time (a compile-time throw, so a plain `toThrow`, not a
  // cargo `expectFail`).
  expect(() =>
    compile(
      `const base = 10;\nconst addBase = (n: number): number => n + base;\nconsole.log(addBase(5));`,
    ),
  ).toThrow();
});

test("rest param → UnsupportedError", () => {
  expect(() =>
    compile(`const sum = (...xs: number[]): number => xs.length;\nconsole.log(sum(1, 2, 3));`),
  ).toThrow();
});

test("anonymous-object destructured param → fail-loud", () => {
  expect(() =>
    compile(`const f = ({ x, y }: { x: number; y: number }): number => x + y;\nconst p = { x: 1, y: 2 };\nconsole.log(f(p));`),
  ).toThrow();
});
