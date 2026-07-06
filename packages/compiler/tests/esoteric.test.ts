/**
 * Specs for series 025 — esoteric-feature support. Each construct graduates from
 * fail-loud (024 default-deny) to a real, differential-verified lowering:
 *
 *   025a — parameter properties (`constructor(public x: T)`) → field + assign.
 *   025b — `enum E { A, B }` → Rust `enum` (+ `switch` over it → `match`).
 *   025c — `using r = acquire()` + `[Symbol.dispose]()` → RAII `Drop`.
 *
 * Green specs assert the emitted Rust compiles AND its stdout matches the TS run.
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

describe("025a parameter properties", () => {
  test("a `public` ctor param becomes a field and is read back", async () => {
    await behaves(
      `class Point {
  constructor(public x: number, public y: number) {}
  sum(): number { return this.x + this.y; }
}
const p: Point = new Point(3, 4);
console.log(p.sum());`,
      "7",
    );
  });

  test("param properties mix with an explicit field", async () => {
    await behaves(
      `class Box {
  area: number;
  constructor(public w: number, public h: number) {
    this.area = w * h;
  }
}
const b: Box = new Box(3, 5);
console.log(b.area);`,
      "15",
    );
  });
});

describe("025b enum", () => {
  test("a C-like enum value prints its discriminant via a match", async () => {
    await behaves(
      `enum Color { Red, Green, Blue }
function code(c: Color): number {
  switch (c) {
    case Color.Red: return 0;
    case Color.Green: return 1;
    default: return 2;
  }
}
console.log(code(Color.Green));`,
      "1",
    );
  });
});

describe("025c using → Drop", () => {
  test("a disposable resource runs its dispose at scope exit", async () => {
    await behaves(
      `class Guard {
  constructor(public label: string) {}
  [Symbol.dispose]() { console.log(this.label); }
}
function work(): void {
  using a = new Guard("a");
  using b = new Guard("b");
  console.log("body");
}
work();`,
      "body\nb\na",
    );
  });
});
