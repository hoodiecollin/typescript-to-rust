/**
 * Specs for `async`/`await` → `async fn` + `#[tokio::main]` (series 014). Drives
 * the public `emit(...)` entry and asserts the emitted shape: the `async fn`
 * keyword, the `Promise<T>` → `T` return unwrap, `await` → `.await`, the runtime
 * `main`, a non-async green control, and the fail-loud rejections. The
 * cargo-backed COMPILES/BEHAVES proof lives in compiler.test.ts. IDs map to
 * docs/work/014-async-await/specs.md.
 *
 * RED against the scaffold seam in `src/lower.ts`: an `async` function and an
 * `AwaitExpression` each throw `UnsupportedError` "async/await lowering pending"
 * until the `Promise` unwrap, `async fn` lowering, `await` lowering, the
 * awaited-call gate, and `mainAsync` detection land. ASYNC5 is a green control
 * (no async) proving the seam, the `await` node, `mainAsync`, and `asyncFns`
 * don't regress existing lowering.
 */

import { describe, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../src/ast";
import { emit } from "../src/emitter";

function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program);
}

const FETCH = `async function doFetch(id: number): Promise<string> {
  return "row";
}
async function fetchData(id: number): Promise<string> {
  const res: string = await doFetch(id);
  return res;
}`;

describe("async: async/await → async fn + #[tokio::main]", () => {
  test("ASYNC1 an async function emits async fn and unwraps Promise<T> → T", () => {
    expect(compile(FETCH)).toContain("async fn fetchData(id: f64) -> String {");
  });

  test("ASYNC2 await <asyncCall> lowers to <call>.await", () => {
    expect(compile(FETCH)).toContain("doFetch(id).await");
  });

  test("ASYNC3 a top-level await makes the entry a tokio runtime main", () => {
    const rust = compile(
      `${FETCH}\nconst out: string = await fetchData(1);\nconsole.log(out);`,
    );
    expect(rust).toContain("#[tokio::main]");
    expect(rust).toContain("async fn main()");
  });

  test("ASYNC4 Promise<void> unwraps to () (a bare async fn)", () => {
    const rust = compile(
      `async function ping(): Promise<void> { console.log("hi"); }`,
    );
    expect(rust).toContain("async fn ping() {");
    expect(rust).not.toContain("-> ");
  });

  test("ASYNC5 (green control) a non-async program emits unchanged", () => {
    const rust = compile(`function id(n: number): number { return n; }`);
    expect(rust).toContain("fn id(n: f64) -> f64 {");
    expect(rust).not.toContain("async");
    expect(rust).not.toContain(".await");
    expect(rust).not.toContain("tokio");
  });

  test("ASYNC6 an un-awaited async call → `tokio::spawn` (series 051c inc. 1)", () => {
    // 051c reverses the pre-spawn fail-loud (per issue #13 / design.md): a bare
    // un-awaited async free call is now an eagerly-scheduled task (fire-and-forget
    // — the JoinHandle is dropped), matching JS's eager-promise semantics.
    const rust = compile(
      `async function w(): Promise<string> { return "x"; }\nw();`,
    );
    expect(rust).toContain("tokio::spawn(w())");
  });

  test("ASYNC7 await of a non-async call drops the await, yields the value (series 055)", () => {
    // `await s()` on a sync fn is not a future — the dialect drops the `await`
    // and lowers the call as an ordinary expression (#13, series 055). The sync
    // call appears with no `.await` on it.
    const rust = compile(
      `function s(): string { return "x"; }\n` +
        `async function g(): Promise<string> { return await s(); }`,
    );
    expect(rust).toContain("return s();");
    expect(/\bs\(\)\.await/.test(rust)).toBe(false);
  });
});
