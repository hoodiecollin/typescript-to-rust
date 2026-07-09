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

});

describe("051c increment 2 — task-escape Arc / Arc<Mutex> shared state", () => {
  // CONC20 — state READ by two spawned tasks → plain `Arc<T>` (no Mutex). The
  // callee param becomes `Arc<Config>` (reads compose via `Deref`, `cfg.field`
  // unchanged); the decl is `Arc::new(config)`; each spawn arg is
  // `Arc::clone(&config)`.
  test("CONC20 state read by two spawned tasks → Arc; `Arc::new(` + `Arc::clone(&` at each site", () => {
    const src = `interface Config { factor: number; }
async function useConfig(cfg: Config): Promise<void> { console.log(cfg.factor * 2); }
async function run(): Promise<void> {
  const config: Config = { factor: 3 };
  const h1 = useConfig(config);
  const h2 = useConfig(config);
  await h1;
  await h2;
}
await run();`;
    const rust = compile(src);
    expect(rust).toContain("std::sync::Arc::new(");
    // A read-only share is a plain `Arc<T>` — no `Mutex`.
    expect(rust).not.toContain("Mutex");
    // A clone at each of the two capture sites.
    const clones = rust.split("std::sync::Arc::clone(&config)").length - 1;
    expect(clones).toBe(2);
    // The callee param is `Arc<Config>` (a `Deref` read — body unchanged).
    expect(rust).toContain("std::sync::Arc<Config>");
  });

  test("CONC20 (differential) both tasks read the shared config; the derived value matches", async () => {
    const src = `interface Config { factor: number; }
async function useConfig(cfg: Config): Promise<void> { console.log(cfg.factor * 2); }
async function run(): Promise<void> {
  const config: Config = { factor: 21 };
  const h1 = useConfig(config);
  const h2 = useConfig(config);
  await h1;
  await h2;
}
await run();`;
    const rust = compile(src);
    const rr = await runRust(rust);
    expect(rr.ok).toBe(true);
    // Both tasks print `42`; order between the two is deterministic here because
    // each awaits in sequence (h1 then h2), so both TS and Rust print "42\n42".
    expect(rr.stdout.trim()).toBe(runTs(src));
    expect(rr.stdout.trim()).toBe("42\n42");
  });

  // CONC21 — state MUTATED by a spawned task and read by the parent → wrapped
  // `Arc<Mutex<T>>`; the decl is `Arc::new(Mutex::new(…))`, the parent read goes
  // through `.lock().unwrap()`, and the callee mutates through the lock.
  test("CONC21 state mutated by a spawned task, read by parent → Arc<Mutex>; `.lock().unwrap()`", () => {
    const src = `interface Counter { n: number; }
async function bump(c: Counter): Promise<void> { c.n += 5; }
async function run(): Promise<void> {
  const counter: Counter = { n: 0 };
  const h = bump(counter);
  await h;
  console.log(counter.n);
}
await run();`;
    const rust = compile(src);
    expect(rust).toContain("std::sync::Arc::new(std::sync::Mutex::new(");
    expect(rust).toContain(".lock().unwrap()");
    expect(rust).toContain("std::sync::Arc<std::sync::Mutex<Counter>>");
  });

  test("CONC21 (differential) the parent reads the mutated shared counter", async () => {
    const src = `interface Counter { n: number; }
async function bump(c: Counter): Promise<void> { c.n += 5; }
async function run(): Promise<void> {
  const counter: Counter = { n: 0 };
  const h = bump(counter);
  await h;
  console.log(counter.n);
}
await run();`;
    const rust = compile(src);
    const rr = await runRust(rust);
    expect(rr.ok).toBe(true);
    expect(rr.stdout.trim()).toBe(runTs(src));
    expect(rr.stdout.trim()).toBe("5");
  });

  // CONC22 (differential) — two tasks incrementing a shared `Arc<Mutex<Counter>>`,
  // both handles awaited, then the counter printed. Rust's final total === TS's.
  test("CONC22 (differential) two tasks increment a shared Arc<Mutex> counter; final total matches", async () => {
    const src = `interface Counter { n: number; }
async function incr(c: Counter): Promise<void> { c.n += 1; }
async function run(): Promise<void> {
  const counter: Counter = { n: 0 };
  const h1 = incr(counter);
  const h2 = incr(counter);
  await h1;
  await h2;
  console.log(counter.n);
}
await run();`;
    const rust = compile(src);
    // Shape check: the shared-mutation wrap.
    expect(rust).toContain("std::sync::Arc::new(std::sync::Mutex::new(");
    expect(rust).toContain(".lock().unwrap()");
    const rr = await runRust(rust);
    expect(rr.ok).toBe(true);
    // Two awaited increments on a shared object → 2 in both TS and Rust.
    expect(rr.stdout.trim()).toBe(runTs(src));
    expect(rr.stdout.trim()).toBe("2");
  });

  // CONC24 (fail-loud) — a shared capture the task-escape pass cannot bound. Here
  // the shared/unshared conflict: `incr` is spawned with a wrapped shared capture
  // AND called directly (unshared) with a plain value → the two irreconcilable
  // param types → `UnsupportedError`. No `spawn` that would fail `Send + 'static`
  // is ever emitted.
  test("CONC24 (fail-loud) an async fn used both shared (spawned) and unshared (direct) is UnsupportedError", () => {
    const src = `interface Counter { n: number; }
async function incr(c: Counter): Promise<void> { c.n += 1; }
async function run(): Promise<void> {
  const counter: Counter = { n: 0 };
  const local: Counter = { n: 9 };
  const h1 = incr(counter);
  const h2 = incr(counter);
  await h1;
  await h2;
  await incr(local);
  console.log(counter.n);
}
await run();`;
    expect(() => compile(src)).toThrow(
      /both as a spawned shared-state task and a direct call/,
    );
  });

  // CONC24 (fail-loud, second shape) — a shared mutable capture pushed into an
  // unbounded `Vec<JoinHandle>` that is never joined: the pass cannot bound the
  // task's lifetime, so the shared capture is not provably safe → fail-loud. The
  // spawn nested in a loop is not a flat top-level capture site, so the binding is
  // never wrapped; the non-Copy reuse-after is then caught as an unwrappable /
  // unbounded shared capture.
  test("CONC24 (fail-loud) a shared capture spawned in an unbounded loop stays UnsupportedError", () => {
    const src = `interface Counter { n: number; }
async function incr(c: Counter): Promise<void> { c.n += 1; }
async function run(): Promise<void> {
  const counter: Counter = { n: 0 };
  for (let i = 0; i < 3; i = i + 1) {
    incr(counter);
  }
  console.log(counter.n);
}
await run();`;
    expect(() => compile(src)).toThrow();
  });
});
