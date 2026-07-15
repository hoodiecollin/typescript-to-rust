/**
 * Specs for series 083 slice 1/3 — the unified `receiverTypeOf` backbone. Proves
 * `.toString()` end-to-end for `this.field` / `getX()` / identifier / `local.field`
 * receivers (RT*), zero-regression on existing collection/string receivers
 * (RT-REG*), and fail-loud on unmodeled receiver shapes (RT-FL*). IDs map to
 * docs/work/083-library-methods-oracle/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { runRust } from "../src/harness";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program, src);
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

describe("083 receiverTypeOf backbone — .toString() / string methods", () => {
  test("RT1 this.count.toString() (an f64 field)", async () => {
    const src = `class C {
  count: number;
  constructor(count: number) { this.count = count; }
  show(): string { return this.count.toString(); }
}
const c: C = new C(3);
console.log(c.show());`;
    await behaves(src, "3");
    expect(compile(src)).toContain("tslib::number::to_js_string(self.count)");
  });

  test("RT2 getName().toUpperCase() — inferred return via the oracle tier", async () => {
    const src = `function getName(): string { return "abc"; }
console.log(getName().toUpperCase());`;
    await behaves(src, "ABC");
    expect(compile(src)).toContain(".to_uppercase()");
  });

  test("RT3 local.field string method (p.name.toUpperCase())", async () => {
    const src = `interface Person { name: string; }
const p: Person = { name: "ada" };
console.log(p.name.toUpperCase());`;
    await behaves(src, "ADA");
    expect(compile(src)).toContain(".to_uppercase()");
  });

  test("RT4 identifier string method (s.toUpperCase())", async () => {
    const src = `const s: string = "hi";
console.log(s.toUpperCase());`;
    await behaves(src, "HI");
  });
});

describe("083 receiverTypeOf — zero regression", () => {
  test("RT-REG1 identifier Map receiver lowers unchanged", async () => {
    const src = `const m: Map<string, number> = new Map<string, number>();
m.set("a", 1);
console.log(m.has("a"), m.get("a") ?? -1);`;
    await behaves(src, "true 1");
    const rust = compile(src);
    expect(rust).toContain(".contains_key(");
    expect(rust).toContain(".cloned()");
  });

  test("RT-REG2 identifier / array .length still .len()", async () => {
    const src = `const s: string = "abcd";
const xs: Array<number> = [1, 2, 3];
console.log(s.length, xs.length);`;
    await behaves(src, "4 3");
    expect(compile(src)).toContain(".len()");
  });
});

describe("083 receiverTypeOf — fail-loud residuals", () => {
  test("RT-FL1 a method on an unmodeled (boolean) receiver stays fail-loud", () => {
    // `b.valueOf()` on a boolean is not a modeled primitive method → no primitive
    // route claimed → generic method fallthrough emits `b.valueOf()`, which is
    // not valid Rust. The point: `tryPrimitiveMethod` returns null (does NOT
    // hijack it into a wrong String/f64 route) — fail-loud posture preserved.
    const src = `const b: boolean = true;
console.log(b.valueOf());`;
    const rust = compile(src);
    // Emitted as a raw generic method (invalid Rust) — never rerouted.
    expect(rust).toContain(".valueOf()");
    expect(rust).not.toContain("to_uppercase");
    expect(rust).not.toContain("to_js_string");
  });
});
