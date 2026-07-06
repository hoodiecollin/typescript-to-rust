/**
 * Specs for series 037b — struct trait derivation + struct moves.
 *
 * A generated data struct (from an `interface` or `class`) carries an on-demand
 * `#[derive(...)]` computed from field eligibility (`derives.ts`): `Clone` (so the
 * ownership pass can clone a moved-then-reused struct) + `Debug` (so
 * `console.log(struct)` can render — the printing itself is issue #22). Structs
 * join the movable set exactly when they derive `Clone`, kept in lockstep with the
 * emitter via the shared cloneability test.
 *
 * Differential: emitted Rust compiles AND matches the TS run; derive/clone
 * placement is asserted on the emitted source. See
 * docs/work/037-ownership-cfg-liveness/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { runRust } from "../src/harness";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

function runTs(src: string): string {
  const proc = Bun.spawnSync(["bun", "run", "-"], {
    stdin: new TextEncoder().encode(src),
  });
  return new TextDecoder().decode(proc.stdout).trim();
}

async function behaves(src: string, expected: string): Promise<void> {
  const rust = compile(src);
  const rr = await runRust(rust);
  expect(rr.ok).toBe(true);
  expect(rr.stdout.trim()).toBe(runTs(src));
  expect(rr.stdout.trim()).toBe(expected);
}

describe("037b struct derives + struct moves", () => {
  test("D1 an interface struct moved then reused is cloned + behaves", async () => {
    const src = `interface Point { x: number; y: number; }
const a: Point = { x: 1, y: 2 };
const b: Point = a;
console.log(a.x);
console.log(b.x);`;
    await behaves(src, "1\n1");
    const rust = compile(src);
    expect(rust).toContain("#[derive(Clone, Debug)]");
    expect(rust).toContain("a.clone()");
  });

  test("D2 a class instance moved then reused is cloned + behaves", async () => {
    const src = `class Counter {
  count: number;
  constructor(c: number) { this.count = c; }
}
const a: Counter = new Counter(5);
const b: Counter = a;
console.log(a.count);
console.log(b.count);`;
    await behaves(src, "5\n5");
    expect(compile(src)).toContain("a.clone()");
  });

  test("D3 the derive line is present on a generated class struct", () => {
    const rust = compile(`class Counter {
  count: number;
  constructor(c: number) { this.count = c; }
}
const a: Counter = new Counter(5);
console.log(a.count);`);
    expect(rust).toContain("#[derive(Clone, Debug)]\nstruct Counter {");
  });

  test("D4 a struct last use stays bare (no needless clone)", () => {
    const rust = compile(`interface Point { x: number; y: number; }
const a: Point = { x: 1, y: 2 };
const b: Point = a;
console.log(b.x);`);
    expect(rust).not.toContain("a.clone()");
    expect(rust).toContain("= a;");
  });

  test("D5 a loop-carried struct move is cloned (037a engine + 037b movability)", async () => {
    const src = `interface Point { x: number; y: number; }
function px(p: Point): number { return 1; }
const a: Point = { x: 1, y: 2 };
let total: number = 0;
for (let i = 0; i < 3; i = i + 1) {
  total = total + px(a);
}
console.log(total);`;
    await behaves(src, "3");
    expect(compile(src)).toContain("px(a.clone())");
  });

  test("D6 enum and error-class derives are unchanged (regression)", () => {
    const enumRust = compile(`enum Color { Red, Green }
const c: Color = Color.Red;
console.log(c === Color.Red);`);
    expect(enumRust).toContain("#[derive(Clone, Copy, PartialEq)]");

    const errRust = compile(`class MyError extends Error {
  constructor(message: string) { super(message); }
}
function boom(): void { throw new MyError("x"); }
boom();`);
    // The custom error class keeps its hand-written impls — no data-struct derive.
    expect(errRust).toContain("struct MyError {");
    expect(errRust).not.toContain("#[derive(Clone, Debug)]\nstruct MyError");
  });
});
