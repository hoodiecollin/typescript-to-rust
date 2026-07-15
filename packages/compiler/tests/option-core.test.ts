/**
 * Specs for series 042a — the Option/nullability core. `T | undefined` /
 * `T | null` / optional params → `Option<T>`; `undefined`/`null` → `None`; a
 * plain value flowing into an Option slot is `Some`-wrapped; `x ?? d` →
 * `x.unwrap_or(d)` (graduates #7). Differential: emitted Rust compiles AND
 * matches the TS run. IDs map to specs.md.
 */

import { describe, expect, test } from "bun:test";
import { UnsupportedError } from "../src/emitter";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("option-core", [
  {
    name: "OPT1 a present optional flows through ?? (Some-coercion)",
    src: `const x: number | undefined = 5;
console.log(x ?? 0);`,
    expected: "5",
    extra: ({ rust }) => {
      expect(rust).toContain("Option<f64>");
      expect(rust).toContain("Some(5.0)");
      expect(rust).toContain(".unwrap_or(");
    },
  },
  {
    name: "OPT2 undefined → None, ?? yields the fallback",
    src: `const x: number | undefined = undefined;
console.log(x ?? 0);`,
    expected: "0",
    extra: ({ rust }) => {
      expect(rust).toContain("None");
    },
  },
  {
    name: "OPT3 null also maps to None",
    src: `const s: string | null = null;
console.log(s ?? "fb");`,
    expected: "fb",
  },
  {
    name: "OPT4 ?? passes a present value through",
    src: `const x: number | undefined = 3;
console.log(x ?? 9);`,
    expected: "3",
  },
  {
    name: "OPT5 an optional param lowers to Option and supports ??",
    src: `function pick(x?: number): number {
  return x ?? 42;
}
console.log(pick());`,
    expected: "42",
    extra: ({ rust }) => {
      expect(rust).toContain("x: Option<f64>");
    },
  },
]);

describe("042a Option core + ??", () => {
  test("OPT6 a union of two real types is fail-loud", () => {
    expect(() =>
      compile(`const x: number | string = 5;`),
    ).toThrow(UnsupportedError);
  });
});
