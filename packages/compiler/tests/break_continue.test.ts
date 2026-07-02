/**
 * Specs for `break`/`continue` (series 009). Drives the public `emit(...)` entry
 * and asserts `break;`/`continue;` emission in loops, and that a `continue`
 * inside a C-style `for` is rejected (its desugar to `while` would skip the
 * appended `update` — unsound). The cargo-backed BEHAVES proof lives in
 * compiler.test.ts. IDs map to docs/work/009-switch-break-continue/specs.md.
 *
 * RED against the scaffold seam in `src/lower.ts`: `Break`/`ContinueStatement`
 * throw `UnsupportedError` until lowering lands. BC6 is a green control.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { UnsupportedError, emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

describe("control flow: break / continue", () => {
  test("BC1 `break` in a `while` emits `break;`", () => {
    const rust = compile(
      `function f(): void { let i: number = 0; while (i < 10) { break; } }`,
    );
    expect(rust).toContain("break;");
  });

  test("BC2 `continue` in a `while` emits `continue;`", () => {
    const rust = compile(
      `function f(): void { let i: number = 0; while (i < 10) { i = i + 1; continue; } }`,
    );
    expect(rust).toContain("continue;");
  });

  test("BC3 `continue` in a `for…of` emits inside the loop", () => {
    const rust = compile(
      `function f(xs: Array<number>): void { for (const v of xs) { continue; } }`,
    );
    expect(rust).toMatch(/for v in xs\.iter\(\) \{\n {8}continue;/);
  });

  test("BC4 `break` in a C-style `for` is allowed (sound)", () => {
    const rust = compile(
      `function f(): void { for (let i: number = 0; i < 5; i = i + 1) { break; } }`,
    );
    expect(rust).toContain("break;");
  });

  test("BC5 `continue` in a C-style `for` is rejected (unsound desugar)", () => {
    expect(() =>
      compile(
        `function f(): void { for (let i: number = 0; i < 5; i = i + 1) { continue; } }`,
      ),
    ).toThrow(UnsupportedError);
  });

  test("BC6 (green control) a loop without break/continue still emits", () => {
    const rust = compile(
      `function f(): void { let i: number = 0; while (i < 10) { i = i + 1; } }`,
    );
    expect(rust).toContain("while i < 10.0 {");
  });
});
