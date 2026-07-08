/**
 * Specs for series 048a — lift anonymous callback bodies + forwarding shim
 * (LIFT1–4). An expression-bodied `map`/`filter` callback is no longer an inline
 * Rust closure; its body is lifted to a top-level `fn __cb_<method>_<n>` and the
 * adapter emits a trivial forwarding shim (`|x| __cb(*x, …)`). `forEach` is a
 * *statement* form and is deliberately NOT lifted (decision 2026-07-08) — it keeps
 * its shipped `for &x in xs.iter() { … }` loop, which handles mutable capture.
 *
 * Differential specs assert BOTH the runtime behavior and the emitted shape (the
 * whole point of the reframe is the shape, so we pin it). The illustrative
 * `console.log(xs.map(...))` from specs.md logs a whole Vec, which has no Rust
 * `Display`; the loggable forms below (an element / a `.length`) keep the spirit.
 * IDs map to docs/work/048-lambda-lifting-closures/specs.md.
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

describe("048a lift callback bodies + shim", () => {
  test("LIFT1 map lifts to __cb_map_1 + a forwarding shim", async () => {
    const src = `const xs = [1, 2, 3];
const ys: Array<number> = xs.map(x => x * 2);
console.log(ys[0], ys[1], ys[2]);`;
    await behaves(src, "2 4 6");
    const rust = compile(src);
    expect(rust).toContain("fn __cb_map_1(x: f64) -> f64");
    expect(rust).toContain(
      ".iter().map(|x| __cb_map_1(*x)).collect::<Vec<_>>()",
    );
  });

  test("LIFT2 filter lifts to __cb_filter_1 -> bool + copied()", async () => {
    const src = `const xs = [1, 2, 3];
const big: Array<number> = xs.filter(x => x > 1);
console.log(big.length);`;
    await behaves(src, "2");
    const rust = compile(src);
    expect(rust).toContain("fn __cb_filter_1(x: f64) -> bool");
    expect(rust).toContain(".iter().filter(|x| __cb_filter_1(**x))");
    expect(rust).toContain(".copied()");
  });

  test("LIFT3 forEach is NOT lifted — keeps its for-loop lowering", async () => {
    const src = `const xs = [1, 2, 3];
xs.forEach(x => console.log(x));`;
    await behaves(src, "1\n2\n3");
    const rust = compile(src);
    expect(rust).not.toContain("__cb_");
    expect(rust).toContain("for &x in");
  });

  test("LIFT4 a program with no lifting-eligible callback emits no __cb_ fn", () => {
    const rust = compile(`const x = 1;\nconsole.log(x);`);
    expect(rust).not.toContain("__cb_");
  });
});
