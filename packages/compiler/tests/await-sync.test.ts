/**
 * Specs for series 055 — `await` of a non-future unwraps (finishes #13). In JS,
 * awaiting a non-thenable just yields the value; the dialect now DROPS the
 * `await` wherever the operand is not one of the modeled futures (a sync call, a
 * plain value, a member access, a non-async method) and lowers the operand as an
 * ordinary expression. Fallible sync calls still thread `?` (via `lowerCall`).
 * The genuine-future paths (async fn / method / combinator / spawned handle /
 * sleep) are untouched — AWAIT6 guards that.
 *
 * IDs map to docs/work/055-await-sync-unwrap/specs.md. Differential specs assert
 * Rust stdout === TS stdout; substring specs pin the drop / retain shape.
 */

import { expect } from "bun:test";
import { defineDifferential } from "./_support/differential";

defineDifferential("await-sync", [
  {
    name: "AWAIT1 (differential) `await syncFn()` yields the call value; no `.await` on the sync call",
    src: `function compute(): number { return 7; }
async function run(): Promise<void> {
  const v: number = await compute();
  console.log(v);
}
await run();`,
    expected: "7",
    extra: ({ rust }) => {
      expect(rust).toContain("compute()");
      expect(rust).not.toContain("compute().await");
    },
  },
  {
    name: "AWAIT2 (differential) `await` of a fallible sync fn threads `?` (not `.await`)",
    src: `function parse(x: number): number { if (x < 0) { throw new Error("neg"); } return x * 2; }
async function run(): Promise<void> {
  const n: number = await parse(3);
  console.log(n);
}
await run();`,
    expected: "6",
    extra: ({ rust }) => {
      expect(rust).toContain("parse(");
      // The sync call threads `?` but is never `.await`-ed.
      expect(/parse\([^)]*\)\.await/.test(rust)).toBe(false);
    },
  },
  {
    name: "AWAIT3 (differential) `await x` on a plain binding yields the value",
    src: `async function run(): Promise<void> {
  const x: number = 41;
  const y: number = await x;
  console.log(y);
}
await run();`,
    expected: "41",
    extra: ({ rust }) => {
      expect(rust).not.toContain("x.await");
    },
  },
  {
    name: "AWAIT4 (differential) `await obj.field` yields the field value",
    src: `interface Box { v: number; }
async function run(): Promise<void> {
  const b: Box = { v: 5 };
  const r: number = await b.v;
  console.log(r);
}
await run();`,
    expected: "5",
  },
  {
    name: "AWAIT5 (differential) `await obj.m()` on a non-async method yields its value",
    src: `class Adder {
  base: number;
  constructor(base: number) { this.base = base; }
  add(a: number, b: number): number { return this.base + a + b; }
}
async function run(): Promise<void> {
  const s: number = await new Adder(0).add(2, 3);
  console.log(s);
}
await run();`,
    expected: "5",
  },
  {
    name: "AWAIT6 (differential, regression) `await asyncFn()` still emits a real `.await`",
    src: `async function fetchN(): Promise<number> { return 9; }
async function run(): Promise<void> {
  const n: number = await fetchN();
  console.log(n);
}
await run();`,
    expected: "9",
    extra: ({ rust }) => {
      expect(rust).toContain("fetchN().await");
    },
  },
]);
