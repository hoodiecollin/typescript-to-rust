/**
 * Specs for series 051b — dynamic async-concurrency fan-out + timers (CONC10–16).
 * Under `await`, two dynamic-fan-out shapes and one timer idiom map onto futures /
 * tokio:
 *
 *   - `Promise.all(arr.map(f))` (homogeneous, dynamic arity) →
 *     `futures::future::join_all(arr.into_iter().map(<closure|cb>)).await` → `Vec<T>`.
 *     The `.map` callback `f` is EITHER an inline non-async closure `id => fetchRow(id)`
 *     (→ `|id| fetch_row(id)`) or a lifted async arrow `async id => await fetchRow(id)`
 *     (→ a hoisted `async fn __cb_map_<n>` + `.map(__cb_map_n)`). Both drive the same
 *     `Vec<T>`. A fallible fan-out uses `try_join_all(…).await?` (short-circuit).
 *   - `Promise.allSettled(arr.map(f))` → `join_all(…).await` → `Vec<Result<T, String>>`
 *     (never short-circuits; each fallible element's output is already a `Result`).
 *   - `await sleep(ms)` → `tokio::time::sleep(std::time::Duration::from_millis(ms as u64)).await`.
 *
 * Differential specs (CONC11, CONC13, CONC15) assert Rust stdout === TS stdout ===
 * expected; substring specs (CONC10, CONC10b, CONC12, CONC14) pin the futures/tokio
 * shape; CONC16 is fail-loud. IDs map to series 051.
 *
 * Fixture adjustments (noted):
 *   - A `Vec<f64>` has no Rust `Display`, so differential fan-out results are printed
 *     element-wise by index (`console.log(rows[0], rows[1], rows[2])`).
 *   - CONC13's `allSettled` differential prints `settled.length` (=== `settled.len()`)
 *     in both runtimes: `allSettled` never short-circuits, so a mix of a resolving and
 *     a throwing element still yields all N settled outcomes. The dialect models no
 *     `PromiseSettledResult` shape (`{status, value/reason}`), so the per-element
 *     outcome objects are not portably inspectable; the length equality proves the
 *     no-short-circuit intent while staying dialect-valid in both.
 */

import { describe, expect, test } from "bun:test";
import { runRust } from "../src/harness";
import { compile, defineDifferential, runTs } from "./_support/differential";

defineDifferential("conc-dynamic", [
  {
    name: "CONC11 (differential) dynamic fan-out over `[1, 2, 3]` prints the same Vec, in order (variant 1)",
    // Inline-closure variant.
    src: `async function fetchRow(id: number): Promise<number> { return id + 100; }
async function run(): Promise<void> {
  const ids: Array<number> = [1, 2, 3];
  const rows: Array<number> = await Promise.all(ids.map(id => fetchRow(id)));
  console.log(rows[0], rows[1], rows[2]);
}
await run();`,
    expected: "101 102 103",
  },
  {
    name: "CONC11 (differential) dynamic fan-out over `[1, 2, 3]` prints the same Vec, in order (variant 2)",
    // Lifted async-arrow variant — same Vec.
    src: `async function fetchRow(id: number): Promise<number> { return id + 100; }
async function run(): Promise<void> {
  const ids: Array<number> = [1, 2, 3];
  const rows: Array<number> = await Promise.all(ids.map(async id => await fetchRow(id)));
  console.log(rows[0], rows[1], rows[2]);
}
await run();`,
    expected: "101 102 103",
  },
  {
    name: "CONC13 (differential) `allSettled` over a mix of resolve + throw yields all N (no short-circuit)",
    src: `async function fetchRow(id: number): Promise<number> {
  if (id < 0) { throw new Error("bad"); }
  return id + 100;
}
async function run(): Promise<void> {
  const ids: Array<number> = [1, -1, 3];
  const settled = await Promise.allSettled(ids.map(id => fetchRow(id)));
  console.log(settled.length);
}
await run();`,
    // Nothing short-circuits: all three settle → length 3 in both runtimes.
    expected: "3",
  },
]);

describe("051b dynamic async concurrency + timers", () => {
  test("CONC10 `Promise.all(ids.map(id => fetchRow(id)))` (inline closure) → `join_all`", () => {
    const src = `async function fetchRow(id: number): Promise<number> { return id + 100; }
async function run(): Promise<void> {
  const ids: Array<number> = [1, 2, 3];
  const rows: Array<number> = await Promise.all(ids.map(id => fetchRow(id)));
  console.log(rows[0], rows[1], rows[2]);
}
await run();`;
    const rust = compile(src);
    expect(rust).toContain("futures::future::join_all(");
    expect(rust).toContain(".map(|id| fetchRow(id))");
    expect(rust).toContain(".await");
    expect(rust).toContain("Vec<");
  });

  test("CONC10b `Promise.all(ids.map(async id => await fetchRow(id)))` (lifted arrow) → hoisted `__cb_map_`", () => {
    const src = `async function fetchRow(id: number): Promise<number> { return id + 100; }
async function run(): Promise<void> {
  const ids: Array<number> = [1, 2, 3];
  const rows: Array<number> = await Promise.all(ids.map(async id => await fetchRow(id)));
  console.log(rows[0], rows[1], rows[2]);
}
await run();`;
    const rust = compile(src);
    expect(rust).toContain("futures::future::join_all(");
    expect(rust).toContain(".map(__cb_map_");
    // The lifted callback is an `async fn` whose return type is the Promise-inner.
    expect(rust).toMatch(/async fn __cb_map_\d+\(id: f64\) -> f64/);
  });

  test("CONC12 `Promise.allSettled(...)` → `join_all` yielding `Vec<Result<T, String>>`", () => {
    const src = `async function fetchRow(id: number): Promise<number> {
  if (id < 0) { throw new Error("bad"); }
  return id + 100;
}
async function run(): Promise<void> {
  const ids: Array<number> = [1, -1, 3];
  const settled = await Promise.allSettled(ids.map(id => fetchRow(id)));
  console.log(settled.length);
}
await run();`;
    const rust = compile(src);
    expect(rust).toContain("futures::future::join_all(");
    // No `try_join_all` / `?` — allSettled never short-circuits.
    expect(rust).not.toContain("try_join_all");
    // The lifted element futures are `Result<T, String>`; Rust infers the Vec.
    expect(rust).toContain("async fn fetchRow(id: f64) -> Result<f64, String>");
  });

  test("CONC14 `await sleep(50)` → `tokio::time::sleep(std::time::Duration::from_millis(50` + `.await`", () => {
    const src = `async function run(): Promise<void> {
  await sleep(50);
  console.log("slept");
}
await run();`;
    const rust = compile(src);
    expect(rust).toContain(
      "tokio::time::sleep(std::time::Duration::from_millis(50",
    );
    expect(rust).toContain(".await");
  });

  test("CONC15 (differential) `await sleep(ms)` then print produces the same final output", async () => {
    // `sleep` is the dialect's built-in delay primitive (never user-declared), so
    // the compiled source has no `sleep` definition. Plain Bun has no `sleep`
    // global, so the TS-only reference run gets a `sleep` polyfill prepended (it is
    // NOT part of the compiled source — the compiler recognizes `sleep` itself).
    const src = `async function run(): Promise<void> {
  await sleep(1);
  console.log("done");
}
await run();`;
    const tsSrc =
      `const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));\n${src}`;
    const rust = compile(src);
    const rr = await runRust(rust);
    expect(rr.ok).toBe(true);
    expect(rr.stdout.trim()).toBe(await runTs(tsSrc));
    expect(rr.stdout.trim()).toBe("done");
  });

  test("CONC16 (fail-loud) a dynamic `Promise.all` that is not `arr.map(f)` is UnsupportedError", () => {
    // `Promise.all(dyn)` over a plain array identifier — neither an array literal
    // (051a `join!`) nor an `arr.map(f)` fan-out (051b `join_all`): no known tuple
    // arity, no homogeneous callback → fail-loud.
    const src = `async function run(): Promise<void> {
  const dyn: Array<number> = [1, 2, 3];
  const rows: Array<number> = await Promise.all(dyn);
  console.log(rows[0]);
}
await run();`;
    expect(() => compile(src)).toThrow(
      /Promise\.all\/allSettled argument must be an array literal or arr\.map\(f\)/,
    );
  });
});
