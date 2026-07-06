/**
 * Specs for series 038 — completing epic #1's move coverage. Two remaining move
 * shapes the CFG clone engine (037) didn't yet place clones for:
 *
 *   - **move-through-store** — a movable *name* moved into an owning position: a
 *     struct/array/hashmap literal element, a by-value method argument, or an
 *     assignment's value. (`E0382 borrow of moved value`.)
 *   - **move-out-of-place** — reading a non-Copy *projection* (`obj.field`,
 *     `arr[i]`) by value, which always moves out (`E0382` partial move / `E0507`
 *     cannot move out of index). Cloned in a move (let-init) position.
 *
 * Same fail-loud discipline: the pass only adds clones; anything unhandled stays a
 * bare move cargo rejects loudly. Differential: emitted Rust compiles AND matches
 * the TS run; clone placement asserted on the source.
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

describe("038 move-through-store", () => {
  test("A a struct literal capturing a reused movable clones the field value", async () => {
    const src = `interface W { s: string; }
const s: string = "x";
const w: W = { s: s };
console.log(s);
console.log(w.s);`;
    await behaves(src, "x\nx");
    expect(compile(src)).toContain("s.clone()");
  });

  test("B an array literal capturing a reused movable clones the element", async () => {
    const src = `const s: string = "x";
const arr: Array<string> = [s];
console.log(s);
console.log(arr.length);`;
    await behaves(src, "x\n1");
    expect(compile(src)).toContain("s.clone()");
  });

  test("E a by-value method argument (Vec.push) of a reused movable is cloned", async () => {
    const src = `const arr: Array<string> = [];
const s: string = "x";
arr.push(s);
console.log(s);`;
    await behaves(src, "x");
    expect(compile(src)).toContain("arr.push(s.clone())");
  });

  test("G an assignment whose value is a reused movable clones it", async () => {
    const src = `const s: string = "x";
let s2: string = "a";
s2 = s;
console.log(s);
console.log(s2);`;
    await behaves(src, "x\nx");
    expect(compile(src)).toContain("s.clone()");
  });

  test("a move-into-store that is the last use stays bare (no needless clone)", () => {
    const rust = compile(`const s: string = "x";
const arr: Array<string> = [s];
console.log(arr.length);`);
    expect(rust).not.toContain("s.clone()");
  });
});

describe("038 move-out-of-place", () => {
  test("D a non-Copy field read into a let clones when the base is reused (partial move)", async () => {
    const src = `interface P { name: string; }
const p: P = { name: "x" };
const n: string = p.name;
console.log(p.name);
console.log(n);`;
    await behaves(src, "x\nx");
    expect(compile(src)).toContain("p.name.clone()");
  });

  test("F a non-Copy index read into a let clones (cannot move out of index)", async () => {
    const src = `function first(v: Array<string>): string {
  const x: string = v[0];
  return x;
}
const arr: Array<string> = ["a", "b"];
console.log(first(arr));`;
    await behaves(src, "a");
    expect(compile(src)).toContain("v[0].clone()");
  });

  test("a Copy field/index read is NOT cloned", () => {
    const rust = compile(`interface P { x: number; }
const p: P = { x: 5 };
const a: number = p.x;
const arr: Array<number> = [1, 2];
const b: number = arr[0];
console.log(a + b);`);
    expect(rust).not.toContain(".clone()");
  });

  test("a field read whose base is NOT reused stays a bare partial move", () => {
    const rust = compile(`interface P { name: string; }
const p: P = { name: "x" };
const n: string = p.name;
console.log(n);`);
    expect(rust).not.toContain("p.name.clone()");
  });
});

describe("038 move-out-of-borrow (projection in non-let positions)", () => {
  test("G1 a field out of a borrowed struct param is cloned even if not reused", async () => {
    const src = `interface P { name: string; }
function f(p: P): string {
  const n: string = p.name;
  return n;
}
const p: P = { name: "x" };
console.log(f(p));`;
    await behaves(src, "x");
    expect(compile(src)).toContain("p.name.clone()");
  });

  test("G2 returning a field of a borrowed struct param clones it", async () => {
    const src = `interface P { name: string; }
function f(p: P): string { return p.name; }
const p: P = { name: "x" };
console.log(f(p));`;
    await behaves(src, "x");
    expect(compile(src)).toContain("p.name.clone()");
  });

  test("G3 returning an index element clones it (cannot move out of index)", async () => {
    const src = `function f(v: Array<string>): string { return v[0]; }
const arr: Array<string> = ["a", "b"];
console.log(f(arr));`;
    await behaves(src, "a");
    expect(compile(src)).toContain("v[0].clone()");
  });

  test("G4 a field projection passed as an owned argument is cloned", async () => {
    const src = `interface P { name: string; }
function take(s: string): number { return 1; }
function f(p: P): number { return take(p.name); }
const p: P = { name: "x" };
console.log(f(p));`;
    await behaves(src, "1");
    expect(compile(src)).toContain("take(p.name.clone())");
  });

  test("returning a field of an OWNED local (not reused) stays a bare move", () => {
    // An owned local's field can be moved out when the base isn't used again.
    const rust = compile(`interface P { name: string; }
function f(): string {
  const p: P = { name: "x" };
  return p.name;
}
console.log(f());`);
    expect(rust).not.toContain("p.name.clone()");
  });
});
