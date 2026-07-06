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

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { runRust } from "../src/harness";
import { UnsupportedError } from "../src/lower";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

function runTs(src: string): string {
  const proc = Bun.spawnSync(["bun", "run", "-"], {
    stdin: new TextEncoder().encode(src),
  });
  return new TextDecoder().decode(proc.stdout).trim();
}

/** Emit, run as Rust, and assert stdout equals both the TS run and `expected`. */
async function behaves(src: string, expected: string): Promise<void> {
  const rust = compile(src);
  const rr = await runRust(rust);
  expect(rr.ok).toBe(true);
  expect(rr.stdout.trim()).toBe(runTs(src));
  expect(rr.stdout.trim()).toBe(expected);
}

describe("031 gap A: integer args across call boundaries", () => {
  test("A1 integer literal at a free-fn usize param retypes and behaves", async () => {
    await behaves(
      `function at(xs: Array<number>, i: number): number {
  return xs[i];
}
console.log(at([10, 20, 30], 1));`,
      "20",
    );
  });

  test("A2 integer literal at a method usize param retypes and behaves", async () => {
    await behaves(
      `class Grid {
  data: Array<number>;
  constructor(d: Array<number>) { this.data = d; }
  at(i: number): number { return this.data[i]; }
}
const g: Grid = new Grid([10, 20, 30]);
console.log(g.at(2));`,
      "30",
    );
  });

  test("A3 integer literal at a constructor usize param retypes and behaves", async () => {
    await behaves(
      `class Ring {
  first: number;
  constructor(xs: Array<number>, i: number) { this.first = xs[i]; }
}
const r: Ring = new Ring([10, 20, 30], 2);
console.log(r.first);`,
      "30",
    );
  });

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
});

describe("031 gap C: Rust-keyword identifier hygiene", () => {
  test("C1 a keyword local binding (`box`) escapes and behaves", async () => {
    await behaves(
      `function f(): number {
  const box: number = 42;
  return box;
}
console.log(f());`,
      "42",
    );
  });

  test("C2 a keyword param + field (`type`) escapes and behaves", async () => {
    await behaves(
      `interface Node { type: number; }
function kind(n: Node): number { return n.type; }
const x: Node = { type: 7 };
console.log(kind(x));`,
      "7",
    );
  });

  test("C3 a keyword function name (`match`) escapes and behaves", async () => {
    await behaves(
      `function match(a: number): number { return a; }
console.log(match(5));`,
      "5",
    );
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
});

describe("031 gap E: HashMap index-assignment → insert", () => {
  test("E1 a string-keyed write inserts and reads back", async () => {
    await behaves(
      `const m: Record<string, number> = { "a": 1 };
m["b"] = 2;
console.log(m["b"]);`,
      "2",
    );
  });

  test("E2 a string-keyed write overwrites an existing key", async () => {
    await behaves(
      `const m: Record<string, number> = { "a": 1 };
m["a"] = 9;
console.log(m["a"]);`,
      "9",
    );
  });

  test("E3 a numeric Vec index-assign is unchanged and behaves", async () => {
    await behaves(
      `const arr: Array<number> = [1, 2, 3];
arr[1] = 5;
console.log(arr[1]);`,
      "5",
    );
  });
});
