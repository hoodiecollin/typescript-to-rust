/**
 * Specs for series 114 — string enums → Rust `enum` with a `Display` round-trip.
 * Design + spec IDs: series 114. Issue #77.
 *
 * A string enum (`enum Dir { North = "north" }`) lowers to a fieldless `HirEnum`
 * carrying a `display` per variant; `emitEnum` emits `#[derive(Clone, Copy, Debug,
 * PartialEq)]` + an `impl Display` (via the shared arm generator also used by 093
 * literal unions). Member access / `switch` / `===` / Copy-ness all ride the existing
 * numeric-enum `HirEnum` machinery unchanged.
 *
 * Positive specs are differentials (emitted Rust runs; stdout === TS-via-Bun). Fail-loud
 * rejections (mixed/const/computed) are plain `test()`s per the differential-driver rule.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("string-enums", [
  {
    name: "SE1 basic: fieldless enum + Display round-trip, member access",
    src: `enum Dir { North = "north", South = "south" }
const d: Dir = Dir.North;
console.log(d);`,
    expected: "north",
    extra: ({ rust }) => {
      expect(rust).toContain("enum Dir");
      expect(rust).toContain("impl std::fmt::Display for Dir");
      expect(rust).toContain("Dir::North");
      // fieldless: no `String` payload on the variant
      expect(rust).not.toContain("North(");
    },
  },
  {
    name: "SE2 stringify via template interpolation",
    src: `enum Dir { North = "north", South = "south" }
const d: Dir = Dir.North;
console.log(\`\${d}-\${Dir.South}\`);`,
    expected: "north-south",
  },
  {
    name: "SE3 equality (=== / !==) via PartialEq",
    src: `enum Dir { North = "north", South = "south" }
const d: Dir = Dir.North;
console.log(d === Dir.North, d !== Dir.South);`,
    expected: "true true",
  },
  {
    name: "SE4 switch over a string enum → match (statement position)",
    src: `enum Dir { North = "north", South = "south" }
function label(d: Dir): string {
  let out = "";
  switch (d) {
    case Dir.North: out = "up"; break;
    case Dir.South: out = "down"; break;
  }
  return out;
}
console.log(label(Dir.North), label(Dir.South));`,
    expected: "up down",
  },
  {
    name: "SE5 if-chain narrowing",
    src: `enum Dir { North = "north", South = "south" }
function name(d: Dir): string {
  if (d === Dir.North) return "up";
  else return "down";
}
console.log(name(Dir.North), name(Dir.South));`,
    expected: "up down",
  },
  {
    name: "SE6 shares the 093 Display generator with a string-literal union",
    src: `enum Dir { North = "north", South = "south" }
type Color = "red" | "green";
const d: Dir = Dir.South;
const c: Color = "red";
console.log(d, c);`,
    expected: "south red",
    extra: ({ rust }) => {
      expect(rust).toContain("impl std::fmt::Display for Dir");
      expect(rust).toContain("impl std::fmt::Display for Color");
    },
  },
  {
    name: "SE7 keyword-ish member name is raw-escaped",
    src: `enum Kw { move = "m", copy = "c" }
const k: Kw = Kw.move;
console.log(k);`,
    expected: "m",
    extra: ({ rust }) => expect(rust).toContain("r#move"),
  },
]);

// ── Fail-loud rejections (never reach cargo — plain `test()`s) ────────────────

test("SE-mixed: heterogeneous numeric+string enum is rejected", () => {
  expect(() =>
    compile(`enum E { A = 0, B = "b" }
console.log(E.A);`),
  ).toThrow(/heterogeneous|mixed/i);
});

test("SE-const: `const enum` stays rejected", () => {
  expect(() =>
    compile(`const enum E { A = "a" }
console.log(E.A);`),
  ).toThrow(/const enum/i);
});

test("SE-computed: non-identifier (string-named) member stays rejected", () => {
  expect(() =>
    compile(`enum E { "weird-name" = "a" }
console.log(E["weird-name"]);`),
  ).toThrow(/computed/i);
});
