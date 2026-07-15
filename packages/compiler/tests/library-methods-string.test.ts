/**
 * Specs for series 083 — String library methods over the unified
 * `receiverTypeOf` backbone. Native rows (STRN*) and tslib-quirk rows (STRT*).
 * Each spec differential-matches (compile → cargo run → TS-via-Bun); a `Tf` row
 * observes the JS quirk it reproduces. IDs map to
 * docs/work/083-library-methods-oracle/specs.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { runRust } from "../src/harness";

function compile(src: string): string {
  // Pass `src` so the type oracle (series 082/083) is wired — the inferred /
  // method-return receiver specs (INF*) resolve only via its Tier-3.
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

describe("083 String — native rows", () => {
  test("STRN1 toUpperCase / toLowerCase", async () => {
    const src = `const s: string = "Hello";
console.log(s.toUpperCase());
console.log(s.toLowerCase());`;
    await behaves(src, "HELLO\nhello");
    const rust = compile(src);
    expect(rust).toContain(".to_uppercase()");
    expect(rust).toContain(".to_lowercase()");
  });

  test("STRN2 trim / trimStart / trimEnd", async () => {
    const src = `const s: string = "  hi  ";
console.log("[" + s.trim() + "]");
console.log("[" + s.trimStart() + "]");
console.log("[" + s.trimEnd() + "]");`;
    await behaves(src, "[hi]\n[hi  ]\n[  hi]");
    const rust = compile(src);
    expect(rust).toContain(".trim()");
    expect(rust).toContain(".trim_start()");
    expect(rust).toContain(".trim_end()");
  });

  test("STRN3 includes / startsWith / endsWith", async () => {
    const src = `const s: string = "Hello World";
console.log(s.includes("World"), s.startsWith("He"), s.endsWith("ld"));
console.log(s.includes("nope"));`;
    await behaves(src, "true true true\nfalse");
    const rust = compile(src);
    expect(rust).toContain(".contains(");
    expect(rust).toContain(".starts_with(");
    expect(rust).toContain(".ends_with(");
  });

  test("STRN4 repeat(n)", async () => {
    const src = `const s: string = "ab";
console.log(s.repeat(3));`;
    await behaves(src, "ababab");
    expect(compile(src)).toContain(".repeat(");
  });
});

describe("083 String — tslib quirk rows", () => {
  test("STRT1 replace — first match only (quirk)", async () => {
    const src = `const s: string = "a-b-c";
console.log(s.replace("-", "+"));`;
    // JS `replace` with a string replaces only the FIRST occurrence.
    await behaves(src, "a+b-c");
    expect(compile(src)).toContain("tslib::string::replace_first");
  });

  test("STRT2 replaceAll — all matches (native)", async () => {
    const src = `const s: string = "a-b-c";
console.log(s.replaceAll("-", "+"));`;
    await behaves(src, "a+b+c");
    expect(compile(src)).toContain(".replace(");
  });

  test("STRT3 split — non-empty separator", async () => {
    const src = `const s: string = "a,b,c";
const parts: Array<string> = s.split(",");
console.log(parts.length, parts[0], parts[2]);`;
    await behaves(src, "3 a c");
    expect(compile(src)).toContain("tslib::string::split");
  });

  test("STRT4 split('') — empty separator splits into units (quirk)", async () => {
    const src = `const s: string = "abc";
const cs: Array<string> = s.split("");
console.log(cs.length, cs[0], cs[2]);`;
    await behaves(src, "3 a c");
    expect(compile(src)).toContain("tslib::string::split_chars");
  });

  test("STRT5 slice / substring / charAt (UTF-16-vs-char quirk family)", async () => {
    const src = `const s: string = "Hello World";
console.log(s.slice(0, 5));
console.log(s.slice(-5));
console.log(s.substring(6, 11));
console.log(s.substring(11, 6));
console.log(s.charAt(1));
console.log(s.charAt(100));`;
    // substring swaps args when start>end; charAt out-of-range → "" (JS quirk).
    // The trailing empty line (charAt(100)="") is stripped by the harness trim.
    await behaves(src, "Hello\nWorld\nWorld\nWorld\ne");
    const rust = compile(src);
    expect(rust).toContain("tslib::string::str_slice");
    expect(rust).toContain("tslib::string::substring");
    expect(rust).toContain("tslib::string::char_at");
  });
});

describe("083 String — inferred / chained receivers (#48 driver)", () => {
  test("INF1 un-annotated getX() return resolves via the oracle tier", async () => {
    const src = `function getName(): string { return "abc"; }
console.log(getName().toUpperCase());`;
    await behaves(src, "ABC");
    expect(compile(src)).toContain(".to_uppercase()");
  });

  test("INF3 string concat where both operands are method calls (#48)", async () => {
    const src = `const a: string = "x";
const b: string = "y";
console.log(a.toUpperCase() + b.toUpperCase());`;
    await behaves(src, "XY");
    expect(compile(src)).toContain("format!");
  });
});
