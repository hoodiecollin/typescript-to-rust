/**
 * Specs for series 080 — string concatenation (`+`) → `format!`. A `+` with a
 * provably-string operand lowers to `format!("{}{}…", …)`; a numeric `+` is
 * untouched. Graduates #47 (`String + String` for field / method-result operands).
 *
 * IDs map to docs/work/080-string-concat/specs.md (SCAT1–SCAT7).
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

const PERSON = `class Person {
  name: string;
  constructor(n: string) { this.name = n; }
  greet(): string { return "hi " + this.name; }
}`;

describe("080 string concatenation → format!", () => {
  test("SCAT1 literal + field; differential", async () => {
    await behaves(`${PERSON}\nconsole.log(new Person("al").greet());`, "hi al");
  });

  test("SCAT2 method-result LHS, chained concat; differential", async () => {
    await behaves(
      `${PERSON}\nfunction g(x: Person): string { return x.greet() + "/" + x.name; }\nconsole.log(g(new Person("al")));`,
      "hi al/al",
    );
  });

  test("SCAT3 two String locals; differential", async () => {
    await behaves(`const a = "x"; const b = "y"; console.log(a + b);`, "xy");
  });

  test("SCAT4 number coercion (\"n=\" + n); differential", async () => {
    await behaves(`const n = 5; console.log("n=" + n);`, "n=5");
  });

  test("SCAT5 parenthesized numeric subtree preserved; differential", async () => {
    await behaves(`const a = 2, b = 3; console.log("x" + (a + b));`, "x5");
  });

  test("SCAT6 emits format! and no bare `String +` for the string parts", () => {
    const rust = compile(
      `${PERSON}\nfunction g(x: Person): string { return x.greet() + "/" + x.name; }\nconsole.log(g(new Person("al")));`,
    );
    expect(rust).toContain("format!(");
    expect(rust).not.toContain(".to_string() + ");
  });

  test("SCAT7 regression: numeric + is not turned into format!", async () => {
    const rust = compile(`const a = 1, b = 2; console.log(a + b);`);
    expect(rust).not.toContain("format!");
    await behaves(`const a = 1, b = 2; console.log(a + b);`, "3");
  });
});
