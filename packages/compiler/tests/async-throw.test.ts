/**
 * Specs for a fallible `async function` → `async fn … -> Result<T, String>`
 * (series 016 — the async×error intersection). Drives the public `emit(...)`
 * entry and asserts the emitted shape: the `Result`-wrapped async signature, the
 * `<call>.await?` propagation, the async fallible `main`, a non-fallible green
 * control, and the still-fail-loud non-awaited call. The cargo-backed BEHAVES
 * proof lives in compiler.test.ts. IDs map to docs/work/016-async-throw/specs.md.
 *
 * RED against the existing fail-loud guard in `lowerFunction` (an `async` fn that
 * throws is rejected "async throwing function (async + Result deferred)") until
 * the guard is dropped and `lowerAwait` wraps a fallible await in `?`.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

const RISKY = `async function risky(n: number): Promise<number> {
  if (n < 0) { throw new Error("neg"); }
  return n / 2;
}
async function caller(n: number): Promise<number> {
  const x: number = await risky(n);
  return x;
}`;

describe("async×errors: fallible async fn → async fn -> Result", () => {
  test("ATHROW1 a fallible async fn emits async fn -> Result<T, String>", () => {
    const rust = compile(RISKY);
    expect(rust).toContain("async fn risky(n: f64) -> Result<f64, String> {");
    expect(rust).toContain('return Err("neg".to_string());');
    expect(rust).toContain("return Ok(n / 2.0);");
  });

  test("ATHROW2 await of a fallible async call propagates with .await?", () => {
    expect(compile(RISKY)).toContain("risky(n).await?");
  });

  test("ATHROW3 a top-level await of a fallible async fn → fallible tokio main", () => {
    const rust = compile(
      `${RISKY}\nconst r: number = await caller(10);\nconsole.log(r);`,
    );
    expect(rust).toContain("#[tokio::main]");
    expect(rust).toContain("async fn main() -> Result<(), String>");
  });

  test("ATHROW4 (green control) a non-fallible async fn is unchanged (no Result)", () => {
    const rust = compile(
      `async function ping(): Promise<number> { return 1; }\n` +
        `async function use1(): Promise<number> { const v: number = await ping(); return v; }`,
    );
    expect(rust).toContain("async fn ping() -> f64 {");
    expect(rust).toContain("ping().await");
    expect(rust).not.toContain("Result");
    expect(rust).not.toContain(".await?");
  });

  test("ATHROW5 a non-awaited fallible async call → `tokio::spawn` (series 051c inc. 1)", () => {
    // 051c reverses the pre-spawn fail-loud (issue #13 / design.md): a bare
    // un-awaited async free call becomes an eagerly-scheduled task. A fallible
    // async fn spawns as `JoinHandle<Result<T, E>>` (fire-and-forget); the task's
    // `Err` is not observed by the parent — a documented divergence, not a reject.
    const rust = compile(
      `async function w(): Promise<string> { throw new Error("x"); }\nw();`,
    );
    expect(rust).toContain("tokio::spawn(w())");
  });
});
