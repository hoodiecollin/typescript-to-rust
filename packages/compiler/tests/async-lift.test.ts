/**
 * Specs for series 054c — async-aware lambda lift + adapter guard (AM14–AM15).
 * The lift machinery (`liftCallback`) is now async-aware (threads `isAsync` into
 * the lifted `__cb_*` fn) — readiness for series 051b's `join_all` consumer. In
 * 054, an async callback in an array adapter is fail-loud (driving a `Vec<Future>`
 * to values is `Promise.all(arr.map(f))` → `join_all`, 051b). The non-async lift
 * (series 048) is unregressed. IDs map to
 * docs/work/054-async-methods-arrows/specs.md.
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

describe("054c async-aware lift + adapter guard", () => {
  test("AM14 (fail-loud) an async callback in an adapter points at series 051", () => {
    const src = `const xs = [1, 2, 3];\nconst ys: Array<number> = xs.map(async x => x * 2);\nconsole.log(ys[0]);`;
    expect(() => compile(src)).toThrow(/join_all.*051|051.*join_all|async callback/);
  });

  test("AM15 (green control) a non-async map callback still lifts to a non-async fn", async () => {
    const src = `const xs = [1, 2, 3];\nconst ys: Array<number> = xs.map(x => x * 2);\nconsole.log(ys[0], ys[1], ys[2]);`;
    const rust = compile(src);
    // The lifted callback is NOT async (the isAsync threading didn't regress 048).
    expect(rust).toContain("fn __cb_map_1(x: f64) -> f64");
    expect(rust).not.toContain("async fn __cb_map_1");
    const rr = await runRust(rust);
    expect(rr.ok).toBe(true);
    expect(rr.stdout.trim()).toBe(runTs(src));
    expect(rr.stdout.trim()).toBe("2 4 6");
  });
});
