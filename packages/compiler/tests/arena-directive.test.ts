/**
 * Specs for series 028c — the `"use arena"` per-scope directive. A leading
 * `"use arena"` opts a scope into bump allocation (`bumpalo`): a single
 * `let arena = bumpalo::Bump::new();` is injected, and `Vec` literals are built
 * from it (`bumpalo::vec![in &arena; …]`), freed all at once at scope exit.
 *
 * Soundness is by the oracle: an arena value that escapes the scope is a Rust
 * lifetime error cargo rejects — cargo *is* the escape analysis. So the no-escape
 * case behaves identically to the heap version, and escape is loud, never silent.
 * See docs/work/028-compiler-directives/arena-spike.md.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";
import { UnsupportedError } from "../src/errors";
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

describe("028c use arena", () => {
  const build = `"use arena";
const xs: Array<number> = [1, 2, 3];
xs.push(4);
console.log(xs.length);`;

  test("an arena-built Vec behaves as a faithful heap drop-in (no escape)", async () => {
    // Same observable result as the heap version — the arena is an allocation
    // strategy, not a semantic change, for the no-escape case.
    await behaves(build, "4");
  });

  test("emits the bump arena and its vec macro; no directive string leaks", () => {
    const rust = compile(build);
    expect(rust).toContain("let arena = bumpalo::Bump::new();");
    expect(rust).toContain("bumpalo::vec![in &arena; 1.0, 2.0, 3.0]");
    expect(rust).not.toContain('"use arena"');
  });

  test("an escaping arena value is rejected by the oracle (cargo), not miscompiled", async () => {
    // Returning the arena vec ties `Vec<'a>` to the local arena's lifetime — a
    // Rust lifetime/type error. Cargo is the escape check: loud, never silent.
    const rust = compile(`function build(): Array<number> {
  "use arena";
  const xs: Array<number> = [1, 2, 3];
  return xs;
}
console.log(build().length);`);
    expect(rust).toContain("bumpalo::vec!");
    const rr = await runRust(rust);
    expect(rr.ok).toBe(false);
  });

  test("`use arena` outside a free fn / script (a method body) fails loud", () => {
    expect(() =>
      compile(`class C {
  m(): void { "use arena"; }
}`),
    ).toThrow(UnsupportedError);
  });
});
