/**
 * Specs for series 054a — `async` methods (AM1–AM8). An `async` class method
 * lowers to `async fn m(&self, …) -> T`; `await obj.m(...)` lowers to
 * `recv.m(...).await`, and a fallible async method `?`-propagates via `.await?`
 * (mirroring the free async-fn path). A bare, un-awaited async method call is
 * fail-loud (un-polled future → spawn is 051c). `await` of a non-async method
 * now DROPS the `await` and yields the method's value (series 055 graduated the
 * old fail-loud — AM8). IDs map to docs/work/054-async-methods-arrows/specs.md.
 *
 * Differential specs assert BOTH runtime behavior (Rust stdout == TS stdout ==
 * expected, via `runRust` + Bun) and the emitted `async fn` / `.await` shape.
 */

import { expect, test } from "bun:test";
import { compile, defineDifferential } from "./_support/differential";

const DB = `class Db {
  id: number;
  constructor(id: number) { this.id = id; }
  async fetch(): Promise<number> { return this.id; }
}`;

test("AM1 an async method emits `async fn m(&self, …) -> T`", () => {
  const rust = compile(
    `${DB}\nconst d: Db = new Db(7);\nconst v: number = await d.fetch();\nconsole.log(v);`,
  );
  expect(rust).toContain("async fn fetch(&self) -> f64");
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

test("AM6 (fail-loud) a bare un-awaited async method call is rejected", () => {
  const src = `class P {
  constructor() {}
  async go(): Promise<void> { console.log("x"); }
}
const p: P = new P();
p.go();`;
  expect(() => compile(src)).toThrow(/not directly awaited/);
});

defineDifferential("async-method", [
  {
    name: "AM2 (differential) await obj.m() → recv.m().await, same value",
    src: `${DB}\nconst d: Db = new Db(7);\nconst v: number = await d.fetch();\nconsole.log(v);`,
    expected: "7",
    extra: ({ rust }) => expect(rust).toContain("d.fetch().await"),
  },
  {
    name: "AM4 (differential) an async &self method reads this.field identically",
    src: `class Store {
  val: number;
  constructor(v: number) { this.val = v; }
  async read(): Promise<number> { return this.val; }
}
const s: Store = new Store(42);
const v: number = await s.read();
console.log(v);`,
    expected: "42",
    extra: ({ rust }) => expect(rust).toContain("async fn read(&self) -> f64"),
  },
  {
    name: "AM5 (differential) a &mut self async method mutates + reads back",
    src: `class Counter {
  n: number;
  constructor() { this.n = 0; }
  async bump(): Promise<number> { this.n = this.n + 1; return this.n; }
}
const c: Counter = new Counter();
const a: number = await c.bump();
const b: number = await c.bump();
console.log(a, b);`,
    expected: "1 2",
    extra: ({ rust }) => expect(rust).toContain("async fn bump(&mut self) -> f64"),
  },
  {
    name: "AM7 (differential) a throwing async method composes as Result + .await?",
    src: `class Db {
  constructor() {}
  async fetch(n: number): Promise<number> {
    if (n < 0) { throw new Error("neg"); }
    return n * 2;
  }
}
const d: Db = new Db();
const v: number = await d.fetch(5);
console.log(v);`,
    expected: "10",
    extra: ({ rust }) => {
      expect(rust).toContain("async fn fetch(&self, n: f64) -> Result<f64, String>");
      expect(rust).toContain("d.fetch(5.0).await?");
    },
  },
  {
    name: "AM8 (differential) await of a non-async method drops the await, yields the value (series 055)",
    src: `class Db {
  n: number;
  constructor(n: number) { this.n = n; }
  get(): number { return this.n; }
}
async function run(): Promise<void> {
  const d: Db = new Db(1);
  const v: number = await d.get();
  console.log(v);
}
await run();`,
    expected: "1",
  },
]);
