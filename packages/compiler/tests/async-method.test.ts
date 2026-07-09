/**
 * Specs for series 054a — `async` methods (AM1–AM8). An `async` class method
 * lowers to `async fn m(&self, …) -> T`; `await obj.m(...)` lowers to
 * `recv.m(...).await`, and a fallible async method `?`-propagates via `.await?`
 * (mirroring the free async-fn path). A bare, un-awaited async method call is
 * fail-loud (un-polled future → spawn is 051c); `await` of a non-async method is
 * fail-loud. IDs map to docs/work/054-async-methods-arrows/specs.md.
 *
 * Differential specs assert BOTH runtime behavior (Rust stdout == TS stdout ==
 * expected, via `runRust` + Bun) and the emitted `async fn` / `.await` shape.
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

const DB = `class Db {
  id: number;
  constructor(id: number) { this.id = id; }
  async fetch(): Promise<number> { return this.id; }
}`;

describe("054a async methods", () => {
  test("AM1 an async method emits `async fn m(&self, …) -> T`", () => {
    const rust = compile(
      `${DB}\nconst d: Db = new Db(7);\nconst v: number = await d.fetch();\nconsole.log(v);`,
    );
    expect(rust).toContain("async fn fetch(&self) -> f64");
  });

  test("AM2 (differential) await obj.m() → recv.m().await, same value", async () => {
    const src = `${DB}\nconst d: Db = new Db(7);\nconst v: number = await d.fetch();\nconsole.log(v);`;
    await behaves(src, "7");
    expect(compile(src)).toContain("d.fetch().await");
  });

  test("AM3 an async Promise<void> method is a bare async fn (no ->)", () => {
    const src = `class P {
  constructor() {}
  async ping(): Promise<void> { console.log("hi"); }
}
const p: P = new P();
await p.ping();`;
    const rust = compile(src);
    expect(rust).toContain("async fn ping(&self) {");
  });

  test("AM4 (differential) an async &self method reads this.field identically", async () => {
    const src = `class Store {
  val: number;
  constructor(v: number) { this.val = v; }
  async read(): Promise<number> { return this.val; }
}
const s: Store = new Store(42);
const v: number = await s.read();
console.log(v);`;
    await behaves(src, "42");
    expect(compile(src)).toContain("async fn read(&self) -> f64");
  });

  test("AM5 (differential) a &mut self async method mutates + reads back", async () => {
    const src = `class Counter {
  n: number;
  constructor() { this.n = 0; }
  async bump(): Promise<number> { this.n = this.n + 1; return this.n; }
}
const c: Counter = new Counter();
const a: number = await c.bump();
const b: number = await c.bump();
console.log(a, b);`;
    await behaves(src, "1 2");
    expect(compile(src)).toContain("async fn bump(&mut self) -> f64");
  });

  test("AM6 (fail-loud) a bare un-awaited async method call is rejected", () => {
    const src = `class P {
  constructor() {}
  async go(): Promise<void> { console.log("x"); }
}
const p: P = new P();
p.go();`;
    expect(() => compile(src)).toThrow(/not directly awaited/);
  });

  test("AM7 (differential) a throwing async method composes as Result + .await?", async () => {
    const src = `class Db {
  constructor() {}
  async fetch(n: number): Promise<number> {
    if (n < 0) { throw new Error("neg"); }
    return n * 2;
  }
}
const d: Db = new Db();
const v: number = await d.fetch(5);
console.log(v);`;
    await behaves(src, "10");
    const rust = compile(src);
    expect(rust).toContain("async fn fetch(&self, n: f64) -> Result<f64, String>");
    expect(rust).toContain("d.fetch(5.0).await?");
  });

  test("AM8 (fail-loud) await of a non-async method is rejected", () => {
    const src = `class Db {
  constructor() {}
  get(): number { return 1; }
}
const d: Db = new Db();
const v: number = await d.get();
console.log(v);`;
    expect(() => compile(src)).toThrow(/non-async method/);
  });
});
