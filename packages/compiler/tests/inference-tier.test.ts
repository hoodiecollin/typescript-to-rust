/**
 * Specs for series 099 — inference tier. Relaxes the "explicit type annotation
 * required on every binding/return" positive rule (docs/DIALECT.md) to an
 * inference-with-re-validation rule: an un-annotated binding/return whose type the
 * lib-backed TypeOracle can infer *and* which re-validates to a modeled `RustType`
 * uses the inferred type; anything outside the accepted surface (or a parameter,
 * which stays required) keeps today's fail-loud message.
 *
 * `INF*` = differential (inference lands on a modeled type, behaves identically).
 * `INF-FL*` = transpiler fail-loud pin (inferred type out of surface, or a param).
 * `INF-R*` = regression (no behavior change where it must not change).
 *
 * IDs map to series 099.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { DialectError } from "../src/errors";
import { compile, defineDifferential } from "./_support/differential";

function compileNoSource(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

defineDifferential("inference-tier", [
  {
    name: "INF1 un-annotated `.map` binding infers vec<f64>",
    src: `const xs: number[] = [1, 2, 3];
const doubled = xs.map(x => x * 2);
console.log(doubled[0], doubled[1], doubled[2]);`,
    expected: "2 4 6",
  },
  {
    name: "INF2 un-annotated template-literal binding infers String",
    src: `const name: string = "world";
const greeting = \`hi \${name}\`;
console.log(greeting);`,
    expected: "hi world",
  },
  {
    name: "INF3 un-annotated fn return infers -> f64",
    src: `function area(w: number, h: number) { return w * h; }
console.log(area(3, 4));`,
    expected: "12",
    extra: ({ rust }) => expect(rust).toContain("-> f64"),
  },
  {
    name: "INF4 un-annotated method return infers -> f64",
    src: `class C {
  base: number;
  constructor() { this.base = 10; }
  doubled() { return this.base * 2; }
}
const c: C = new C();
console.log(c.doubled());`,
    expected: "20",
    extra: ({ rust }) => expect(rust).toContain("fn doubled(&self) -> f64"),
  },
  {
    name: "INF5 un-annotated fn return infers -> option<String>",
    src: `function pick(xs: string[]) { return xs.find(x => x === "yes"); }
const a = pick(["hi", "yes", "no"]);
console.log(a ?? "none");
const b = pick(["a", "b"]);
console.log(b ?? "none");`,
    expected: "yes\nnone",
  },
  {
    name: "INF6 un-annotated binding infers a declared call return (String)",
    src: `function greet(): string { return "hello"; }
const entries = greet();
console.log(entries);`,
    expected: "hello",
  },
  {
    name: "INF7 un-annotated index counter still refines to usize",
    src: `const arr: number[] = [10, 20, 30];
let sum = 0;
let i = 0;
while (i < arr.length) { sum = sum + arr[i]; i = i + 1; }
console.log(sum);`,
    expected: "60",
    extra: ({ rust }) => {
      // Provenance-free by the time numeric.ts runs: an inferred index counter
      // refines to usize exactly like an annotated one — no `1.0`, no cast.
      expect(rust).toContain("let mut i: usize = 0");
    },
  },
  {
    name: "INF8 return + binding both infer option<struct> (via helper)",
    // `findZero`'s un-annotated return infers `Point | undefined` → Option<Point>;
    // the un-annotated `found` binding then infers that call return (a genuine
    // inference path, not the `.find` by-construction exemption).
    src: `interface Point { x: number; y: number; }
function findZero(pts: Point[]) { return pts.find(p => p.x === 0); }
const pts: Point[] = [{ x: 1, y: 2 }, { x: 0, y: 9 }];
const found = findZero(pts);
if (found !== undefined) { console.log(found.y); } else { console.log(-1); }`,
    expected: "9",
  },
]);

describe("099 inference tier — fail-loud pins (inferred type out of surface)", () => {
  test("INF-FL1 inferred tuple binding stays fail-loud", () => {
    expect(() => compile(`const pair = [1, "a"];`)).toThrow(
      "binding 'pair' without a type annotation",
    );
  });

  test("INF-FL2 inferred function-type binding stays fail-loud", () => {
    // Indexing an array of arrows: the init is a member expression (not a direct
    // arrow, so the arrow-to-fn lifter doesn't intercept), whose inferred type is
    // a function type — out of the binding surface → fail-loud.
    expect(() => compile(`const fn = [(x: number) => x + 1][0];`)).toThrow(
      "binding 'fn' without a type annotation",
    );
  });

  test("INF-FL3 inferred anonymous-object binding stays fail-loud", () => {
    expect(() => compile(`const o = { a: 1, b: "x" };`)).toThrow(
      "binding 'o' without a type annotation",
    );
  });

  test("INF-FL4 inferred wide-union binding stays fail-loud", () => {
    expect(() =>
      compile(`const cond: boolean = true;\nconst u = cond ? 1 : "x";`),
    ).toThrow("binding 'u' without a type annotation");
  });

  test("INF-FL5 inferred tuple return stays fail-loud", () => {
    expect(() => compile(`function pair() { return [1, "a"]; }`)).toThrow(
      "function 'pair' without a return type annotation",
    );
  });

  test("INF-FL6 inferred anonymous-object method return stays fail-loud", () => {
    expect(() =>
      compile(`class C { make() { return { a: 1, b: "x" }; } }`),
    ).toThrow("method 'make' without a return type annotation");
  });

  test("INF-FL7 parameter stays required (implicit-any, hard boundary)", () => {
    expect(() => compile(`function f(x) { return x + 1; }`)).toThrow(
      "parameter 'x' without a type annotation",
    );
  });

  test("INF-FL8 default param stays required", () => {
    expect(() => compile(`function f(x = 5) { return x + 1; }`)).toThrow(
      "default param 'x' without a type annotation",
    );
  });

  test("INF-FL9 inferred forbidden top-type (any/unknown) is a DialectError", () => {
    // A binding of a strict catch variable infers `unknown` (no `any`/`unknown`
    // keyword in the source, so validate passes it through to the inference gate).
    // An inferred `any`/`unknown` is forbidden — never silently accepted.
    expect(() =>
      compile(`try { throw new Error("x"); } catch (e) { const v = e; console.log(v); }`),
    ).toThrow(DialectError);
  });
});

describe("099 inference tier — regressions", () => {
  test("INF-R1 fully-annotated module is byte-for-byte unchanged", () => {
    const src = `const n: number = 5;\nconst s: string = "hi";\nconsole.log(n, s);`;
    expect(compile(src)).toBe(compileNoSource(src));
  });

  test("INF-R2 no-source path still fails loud on an un-annotated binding", () => {
    // No oracle threaded → no inference → today's throw, exactly as before 099.
    expect(() =>
      compileNoSource(`const xs: number[] = [1, 2];\nconst d = xs.map(x => x * 2);`),
    ).toThrow("binding 'd' without a type annotation");
  });

  test("INF-R3 by-construction exemption short-circuits before the oracle", () => {
    // `Object.entries(...)` is typed by construction; the pre-check short-circuits
    // before the oracle, so the binding lowers unchanged (no throw).
    const src = `const m: Map<string, number> = new Map<string, number>();
m.set("a", 1);
const es = Object.entries(m);
console.log(es.length);`;
    expect(() => compile(src)).not.toThrow();
  });
});
