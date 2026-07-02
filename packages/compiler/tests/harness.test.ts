/**
 * Self-tests for the verification harness — proving the *oracle* is sound
 * before we trust it to judge the compiler. If these pass, a green compiler
 * test means "the emitted Rust really compiles / really runs", not "a string
 * matched".
 */

import { describe, expect, test } from "bun:test";
import { checkRust, formatRust, runRust } from "../src/harness";

describe("verification harness", () => {
  test("accepts valid Rust", async () => {
    const result = await checkRust(`pub fn answer() -> f64 { 42.0 }`);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("rejects invalid Rust with structured diagnostics", async () => {
    const result = await checkRust(
      `pub fn bad() { let _x: f64 = "not a number"; }`,
    );
    expect(result.ok).toBe(false);
    const mismatch = result.errors.find((e) => e.code === "E0308");
    expect(mismatch).toBeDefined();
    // Diagnostics carry a source span we can map back to TS later.
    expect(mismatch?.spans.some((s) => s.is_primary)).toBe(true);
  });

  test("rejects the bug the old string-oracle shipped: bare `let` at module scope", async () => {
    // The retired fixtures emitted this and called it valid Rust. It is not.
    const result = await checkRust(`let a: f64 = 42.0;`);
    expect(result.ok).toBe(false);
  });

  test("runs a binary and captures stdout (behavioral oracle)", async () => {
    const result = await runRust(`fn main() { println!("{}", 2.0 + 3.0); }`);
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe("5");
  });

  test("links the ts-primitives runtime crate (offline path dependency)", async () => {
    const result = await runRust(
      `use ts_primitives::TsAny;\nfn main() { println!("{}", TsAny::Number(5.0)); }`,
    );
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe("5");
  });

  test("compiles and runs a tokio async program (offline-first, online fallback)", async () => {
    // Proves the foundation is ready for async lowering: `async fn` + `.await`
    // under a `#[tokio::main]` entry point. tokio is a crates.io dependency, so
    // this also exercises the cold-cache → online fetch fallback.
    const program = [
      "async fn fetch_data(id: f64) -> String {",
      '    format!("got {}", id)',
      "}",
      "#[tokio::main]",
      "async fn main() {",
      "    let res: String = fetch_data(42.0).await;",
      '    println!("{}", res);',
      "}",
    ].join("\n");
    const result = await runRust(program);
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe("got 42");
  });

  test("rustfmt normalizes output", async () => {
    const formatted = await formatRust(`fn  main( ){let x:f64=1.0;}`);
    expect(formatted).toContain("fn main() {");
  });
});
