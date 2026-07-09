/**
 * Specs for series 051c increment 1 — `tokio::spawn` (simple, single-task,
 * move-capture cases) + `JoinHandle` await + `setTimeout` (CONC17, CONC18,
 * CONC19, CONC23, and a temporary fail-loud CONC-SHARE-TEMP). Three mappings,
 * all under "no shared state — single move-in only":
 *
 *   - an un-awaited async **free** call → `tokio::spawn(f())` → a `JoinHandle<T>`
 *     (`const h = doWork()` binds the handle; a bare `doWork();` is fire-and-forget);
 *   - `await h` on a spawned handle → `h.await.unwrap()` (a `JoinHandle`'s
 *     `.await` yields `Result<T, JoinError>`; `.unwrap()` surfaces a task panic);
 *   - `setTimeout(fn, ms)` → `tokio::spawn(async move { sleep(ms).await; <fn>; })`.
 *
 * The `Arc` / `Arc<Mutex>` shared-state task-escape ownership pass is **increment
 * 2** — CONC20/21/22/24 live there. Here, any binding captured by a spawned task
 * that is also used after the spawn (or shared across tasks, or mutated inside a
 * task) stays fail-loud (CONC-SHARE-TEMP), and increment 2 graduates it.
 *
 * IDs map to docs/work/051-async-concurrency/specs.md. Differential specs assert
 * Rust stdout === TS stdout; substring specs pin the tokio shape.
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

describe("051c increment 1 — spawn + JoinHandle + setTimeout", () => {
  test("CONC17 an un-awaited async call → `tokio::spawn(do_work())`, `h` is a JoinHandle", () => {
    const src = `async function doWork(): Promise<number> { return 7; }
async function run(): Promise<void> {
  const h = doWork();
  const v: number = await h;
  console.log(v);
}
await run();`;
    const rust = compile(src);
    expect(rust).toContain("tokio::spawn(doWork())");
  });

  test("CONC18 `await h` on a spawned handle → `.await.unwrap()` (distinct from plain `.await`)", () => {
    const src = `async function doWork(): Promise<number> { return 7; }
async function run(): Promise<void> {
  const h = doWork();
  const v: number = await h;
  console.log(v);
}
await run();`;
    const rust = compile(src);
    expect(rust).toContain(".await.unwrap()");
  });

  test("CONC19 (differential) spawn a task, await its handle, print the result", async () => {
    const src = `async function work(): Promise<number> { return 7; }
async function run(): Promise<void> {
  const h = work();
  const v: number = await h;
  console.log(v);
}
await run();`;
    await behaves(src, "7");
  });

  test("CONC23 `setTimeout(fn, ms)` → `tokio::spawn(async move {` + `tokio::time::sleep(` before the body", () => {
    const src = `async function run(): Promise<void> {
  setTimeout(() => { console.log("x"); }, 0);
}
await run();`;
    const rust = compile(src);
    expect(rust).toContain("tokio::spawn(async move {");
    // The awaited sleep precedes the lifted `fn` body.
    const spawnIdx = rust.indexOf("async move {");
    const sleepIdx = rust.indexOf("tokio::time::sleep(");
    const bodyIdx = rust.indexOf('"x"');
    expect(sleepIdx).toBeGreaterThan(spawnIdx);
    expect(bodyIdx).toBeGreaterThan(sleepIdx);
  });

  test("CONC23 (differential, nice-to-have) `setTimeout(() => console.log, 0)` behaves", async () => {
    const src = `async function run(): Promise<void> {
  console.log("before");
  setTimeout(() => { console.log("x"); }, 0);
}
await run();`;
    // The spawned delayed task fires-and-forgets; the process may exit before it
    // runs, so only "before" is guaranteed. TS and Rust agree on the guaranteed
    // prefix (both print "before" synchronously first).
    const rust = compile(src);
    const rr = await runRust(rust);
    expect(rr.ok).toBe(true);
    expect(rr.stdout.trim().startsWith("before")).toBe(true);
    expect(runTs(src).startsWith("before")).toBe(true);
  });

  // CONC-SHARE-TEMP (temporary fail-loud, THIS increment only). A value captured
  // by a spawned task AND used after the spawn is the shared-capture case: it
  // cannot be a plain move-in. Increment 2 REPLACES this placeholder with the
  // real CONC20/21/22 (`Arc` / `Arc<Mutex>` task-escape) specs — do not delete it
  // until then. We never emit a `spawn` that would fail `Send + 'static`.
  test("CONC-SHARE-TEMP (fail-loud, inc. 1) a shared capture used after spawn is UnsupportedError", () => {
    const src = `async function consume(s: string): Promise<void> { console.log(s); }
async function run(): Promise<void> {
  const s: string = "shared";
  consume(s);
  console.log(s);
}
await run();`;
    // `s` (a non-Copy String local) is moved into the spawned task AND used again
    // after the spawn → increment 2 (Arc wrapping) territory.
    expect(() => compile(src)).toThrow(/Arc wrapping is series 051c increment 2/);
  });
});
