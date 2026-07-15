/**
 * Specs for series 070 — implicit / non-field-init constructors. Graduates issue
 * #36 / the 060 constructor deferral: a class without an explicit field-initializing
 * constructor now lowers to a valid `struct` + synthesized `new`. Each field's
 * construction value is ctor-assigned → field initializer → `Option<T>`/`None`
 * (via series 066). `protected`, decorators, and honest-value-less fields stay
 * fail-loud.
 *
 * Each behaving spec differential-matches (compile → cargo run == TS-via-Bun ==
 * expected). IDs → docs/work/070-implicit-constructors/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { lower } from "../src/lower";
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

function rejects(src: string, re?: RegExp): void {
  expect(() =>
    lower(parseSync("t.ts", src).program as unknown as Program),
  ).toThrow(re);
}

describe("070 implicit constructors", () => {
  test("IC1 no constructor, field initializer → synthesized new()", async () => {
    const src = `class A { x = 5 }
const a: A = new A();
console.log(a.x);`;
    await behaves(src, "5");
    const rust = compile(src);
    expect(rust).toContain("fn new() -> A");
    expect(rust).toContain("x: 5.0");
  });

  test("IC2 no constructor, annotated string field initializer", async () => {
    const src = `class C { label: string = "hi" }
const c: C = new C();
console.log(c.label);`;
    await behaves(src, "hi");
  });

  test("IC3 empty constructor, no fields", async () => {
    const src = `class B { constructor() {} }
const b: B = new B();
console.log("ok");`;
    await behaves(src, "ok");
    expect(compile(src)).toContain("fn new() -> B");
  });

  test("IC4 partial ctor: uninitialized field falls back to its initializer", async () => {
    const src = `class P {
  x: number;
  y = 0;
  constructor(x: number) { this.x = x; }
}
const p: P = new P(7);
console.log(p.x, p.y);`;
    await behaves(src, "7 0");
  });

  test("IC5 no ctor assignment, no initializer → Option<T>/None", async () => {
    const src = `class Q { x: number; }
const q: Q = new Q();
console.log(q.x ?? 7);`;
    await behaves(src, "7");
    const rust = compile(src);
    expect(rust).toContain("x: Option<f64>");
    expect(rust).toContain("x: None");
  });

  test("IC6 partial ctor with an uninitialized non-init field → None", async () => {
    const src = `class R {
  a: number;
  b: number;
  constructor(a: number) { this.a = a; }
}
const r: R = new R(3);
console.log(r.a, r.b ?? 9);`;
    await behaves(src, "3 9");
    expect(compile(src)).toContain("b: Option<f64>");
  });

  test("IC7 several field initializers, no ctor", async () => {
    const src = `class S { x = 1; y = 2; z = 3 }
const s: S = new S();
console.log(s.x, s.y, s.z);`;
    await behaves(src, "1 2 3");
  });

  test("IC8 initializer for an annotated optional field → Some", async () => {
    const src = `class T { flag: boolean | undefined = true }
const t: T = new T();
console.log(t.flag ?? false);`;
    await behaves(src, "true");
    expect(compile(src)).toContain("flag: Option<bool>");
  });

  // ── Fail-loud residuals ───────────────────────────────────────────────────

  test("IC-R1 a protected field in an implicit-ctor class is fail-loud", () => {
    rejects(`class C { protected x = 5 }`, /protected/i);
  });

  test("IC-R2 a class decorator stays fail-loud", () => {
    rejects(`@sealed class C { x = 5 }`);
  });

  test("IC-R3 a this-/cross-field-referencing initializer is fail-loud", () => {
    rejects(`class C { x = 1; y = this.x; }`);
  });

  test("IC-R4 an unassigned struct-typed field becomes Option<T>/None (design Decision)", async () => {
    const src = `interface Point { x: number; }
class C { p: Point; }
const c: C = new C();
if (c.p === undefined) { console.log("absent"); } else { console.log("present"); }`;
    await behaves(src, "absent");
    expect(compile(src)).toContain("p: Option<Point>");
  });
});
