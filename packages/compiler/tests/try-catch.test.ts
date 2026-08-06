/**
 * Specs for `try` / `catch` / `finally` (series 021). Drives the public
 * `emit(...)` entry and asserts the emitted shape: the `Result`-returning IIFE
 * closure, `?` surviving inside the try body, the `if let Err(...)` catch (bound
 * and no-binding), `finally` emitted after, the enclosing function staying
 * non-`Result` (fallibility shielding), and a non-`try` green control. The
 * cargo-backed COMPILES/BEHAVES proof lives in compiler.test.ts. IDs map to
 * series 021.
 *
 * RED until `lowerTry` + the `try`-aware `analyzeFallible` land (a `TryStatement`
 * currently hits the generic `UnsupportedError` gate). TRY6 is a green control.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

const RISKY = `function risky(n: number): void {
  if (n < 0) {
    throw new Error("negative");
  }
  console.log("ran");
}`;

const ATTEMPT = `${RISKY}
function attempt(n: number): void {
  try {
    risky(n);
    console.log("try-ok");
  } catch (e) {
    console.log("caught");
  } finally {
    console.log("finally");
  }
}`;

describe("errors: try / catch / finally", () => {
  test("TRY1 the try block lowers to a Result-returning IIFE closure", () => {
    expect(compile(ATTEMPT)).toContain("(|| -> Result<(), String> {");
  });

  test("TRY2 a fallible call inside the try body keeps its `?`", () => {
    expect(compile(ATTEMPT)).toContain("risky(n)?;");
  });

  test("TRY3 catch (e) lowers to `if let Err(e)`, no-binding to `if let Err(_)`", () => {
    expect(compile(ATTEMPT)).toContain("if let Err(e) =");
    const noBinding = ATTEMPT.replace("catch (e) {", "catch {");
    expect(compile(noBinding)).toContain("if let Err(_) =");
  });

  test("TRY4 finally emits its statements after the `if let` catch", () => {
    const rust = compile(ATTEMPT);
    // console.log renders as println!("{}", …); the finally arg is the message.
    expect(rust).toContain('"finally".to_string()');
    // the finally print must come *after* the catch's `if let Err`.
    expect(rust.indexOf('"finally".to_string()')).toBeGreaterThan(
      rust.indexOf("if let Err"),
    );
  });

  test("TRY5 (shielding) a try-with-handler leaves the enclosing fn non-Result", () => {
    const rust = compile(ATTEMPT);
    expect(rust).toContain("fn attempt(n: f64) {");
    expect(rust).not.toContain("fn attempt(n: f64) -> Result");
  });

  test("TRY6 (green control) a non-try program emits unchanged", () => {
    const rust = compile(`function id(n: number): number { return n; }`);
    expect(rust).toContain("fn id(n: f64) -> f64 {");
    expect(rust).not.toContain("if let Err");
  });
});

describe("errors: try / catch — finally + escape (series 073 carrier)", () => {
  // Series 063 graduated the escaping / value-yielding `try`/`catch` (labeled
  // block) and `try`/`finally`-with-no-catch — see value-yielding-try.test.ts.
  // Series 073 then graduated the last combination — `finally` COMBINED WITH an
  // escaping `return`/`break`/`continue` — to the control **carrier** (see
  // value-yielding-try-finally.test.ts for the differential proof).
  test("TRYX1 finally combined with an escaping return lowers to the carrier", () => {
    const src = `function risky(n: number): number {
  if (n < 0) { throw new Error("neg"); }
  return n;
}
function f(n: number): number {
  try { return risky(n); } catch (e) { return 0; } finally { console.log("done"); }
}`;
    const rust = compile(src);
    expect(rust).toContain("enum Ctrl");
    expect(rust).toContain("'ctrl_0:");
  });
});
