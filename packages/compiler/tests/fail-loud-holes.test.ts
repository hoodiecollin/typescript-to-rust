/**
 * Specs for series 031 — close the fail-loud lowering holes surfaced by 030.
 * Three gaps where the compiler emitted plausible-but-broken Rust that only
 * `cargo check` rejected:
 *
 *   A — integer arguments across call boundaries (a literal at a `usize`/`i64`
 *       parameter kept `f64`).
 *   C — Rust-keyword identifier collisions (`box`, `type`, `match` …).
 *   E — HashMap index-assignment (`m["k"] = v`), which Rust's read-only `Index`
 *       rejects.
 *
 * Each gap gets GREEN specs (the fix compiles + behaves) and, where a full fix
 * is out of scope, a fail-loud spec (`UnsupportedError`, honest "not yet").
 *
 * IDs map to docs/work/031-fail-loud-lowering-holes/specs.md.
 */

import { expect, test } from "bun:test";
import { UnsupportedError } from "../src/errors";
import { compile, defineDifferential } from "./_support/differential";

defineDifferential("fail-loud-holes", [
  {
    name: "A1 integer literal at a free-fn usize param retypes and behaves",
    src: `function at(xs: Array<number>, i: number): number {
  return xs[i];
}
console.log(at([10, 20, 30], 1));`,
    expected: "20",
  },
  {
    name: "A2 integer literal at a method usize param retypes and behaves",
    src: `class Grid {
  data: Array<number>;
  constructor(d: Array<number>) { this.data = d; }
  at(i: number): number { return this.data[i]; }
}
const g: Grid = new Grid([10, 20, 30]);
console.log(g.at(2));`,
    expected: "30",
  },
  {
    name: "A3 integer literal at a constructor usize param retypes and behaves",
    src: `class Ring {
  first: number;
  constructor(xs: Array<number>, i: number) { this.first = xs[i]; }
}
const r: Ring = new Ring([10, 20, 30], 2);
console.log(r.first);`,
    expected: "30",
  },
  {
    name: "C1 a keyword local binding (`box`) escapes and behaves",
    src: `function f(): number {
  const box: number = 42;
  return box;
}
console.log(f());`,
    expected: "42",
  },
  {
    name: "C2 a keyword param + field (`type`) escapes and behaves",
    src: `interface Node { type: number; }
function kind(n: Node): number { return n.type; }
const x: Node = { type: 7 };
console.log(kind(x));`,
    expected: "7",
  },
  {
    name: "C3 a keyword function name (`match`) escapes and behaves",
    src: `function match(a: number): number { return a; }
console.log(match(5));`,
    expected: "5",
  },
  {
    name: "E1 a string-keyed write inserts and reads back",
    src: `const m: Record<string, number> = { "a": 1 };
m["b"] = 2;
console.log(m["b"]);`,
    expected: "2",
  },
  {
    name: "E2 a string-keyed write overwrites an existing key",
    src: `const m: Record<string, number> = { "a": 1 };
m["a"] = 9;
console.log(m["a"]);`,
    expected: "9",
  },
  {
    name: "E3 a numeric Vec index-assign is unchanged and behaves",
    src: `const arr: Array<number> = [1, 2, 3];
arr[1] = 5;
console.log(arr[1]);`,
    expected: "5",
  },
]);

test("A4 a non-literal (f64) argument at a usize param fails loud", () => {
  expect(() =>
    compile(
      `function at(xs: Array<number>, i: number): number {
  return xs[i];
}
const k: number = 1;
console.log(at([10, 20, 30], k));`,
    ),
  ).toThrow(UnsupportedError);
});

test("C4 a non-raw keyword identifier (`Self`) fails loud", () => {
  expect(() =>
    compile(
      `function f(): number {
  const Self: number = 1;
  return Self;
}
console.log(f());`,
    ),
  ).toThrow(UnsupportedError);
});
