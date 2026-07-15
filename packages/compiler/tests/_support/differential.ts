/**
 * `defineDifferential` — the batched differential-test driver.
 *
 * The suite's oracle is: compile TS → Rust, run it, and assert the Rust stdout
 * equals both the Bun-run TS stdout AND a pinned literal. Historically each such
 * test called `runRust(src)` on its own, paying a full cargo invocation per test.
 * Here a whole file's specs are declared as DATA and built in ONE cargo batch
 * (`harness.runBatch` → `cargo build --examples --keep-going`): the heavy rlibs
 * compile once, cargo parallelizes the per-example codegen, and the Bun oracles
 * run bounded-parallel. Each spec then becomes a `test()` that asserts against the
 * pre-built result — no per-test cargo.
 *
 * A spec may also `expectFail` (the emitted Rust is *meant* to fail to compile or
 * panic at runtime — the fail-loud carve-outs) and/or attach `extra` assertions
 * (e.g. an emitted-Rust substring check, which is cheap and needs no cargo).
 *
 * TS→Rust-rejection tests (`expect(() => compile(...)).toThrow(...)`) do NOT
 * belong here — they never reach cargo; keep them as plain `test()`s.
 */

import { beforeAll, expect, test } from "bun:test";
import { parseSync } from "oxc-parser";
import type { Program } from "../../src/ast";
import { emit } from "../../src/emitter";
import { harness } from "../../src/harness";
import { type CargoResult, mapBounded } from "../../src/harness/cargo";

/** Emit Rust for a TS source (oracle mode — source threaded for provenance). */
export function compile(src: string): string {
  return emit(parseSync("t.ts", src).program as unknown as Program, src);
}

/** Run a TS program under Bun and return its trimmed stdout (the oracle). */
export async function runTs(src: string): Promise<string> {
  const proc = Bun.spawn(["bun", "run", "-"], {
    stdin: new TextEncoder().encode(src),
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.trim();
}

/** The pre-built context handed to a spec's assertions. */
export interface DiffContext {
  /** The compiled Rust source (available without cargo). */
  rust: string;
  /** The batch cargo result for this program (`.ok`/`.stdout`/`.errors`). */
  result: CargoResult;
  /** The Bun-run TS stdout (the differential oracle), trimmed. */
  ts: string;
}

export interface DiffSpec {
  name: string;
  src: string;
  /** Pinned expected stdout. Omit to assert only Rust===TS (oracle match). */
  expected?: string;
  /** The emitted Rust is expected to fail (compile error or runtime panic). */
  expectFail?: boolean;
  /** Extra assertions beyond the differential (e.g. an emitted-Rust substring). */
  extra?: (ctx: DiffContext) => void | Promise<void>;
}

function exId(suite: string, index: number): string {
  const safe = suite.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `s_${safe}_${index}`;
}

/**
 * Declare a file's differential specs. Builds them all in one cargo batch in a
 * `beforeAll`, then emits one `test()` per spec asserting the pre-built result.
 */
export function defineDifferential(suite: string, specs: DiffSpec[]): void {
  const ctx = new Array<DiffContext>(specs.length);

  // The batch cargo build is the single expensive step (the per-spec `test()`s
  // below are just map lookups), so give the hook a generous ceiling — far above
  // any real batch, well under a genuine hang.
  beforeAll(async () => {
    const programs = specs.map((s, i) => ({ id: exId(suite, i), src: compile(s.src) }));
    const [built, tsOut] = await Promise.all([
      harness.runBatch(programs),
      mapBounded(specs, 8, (s) => runTs(s.src)),
    ]);
    specs.forEach((_, i) => {
      const id = exId(suite, i);
      ctx[i] = {
        rust: programs[i]!.src,
        result: built.get(id)!,
        ts: tsOut[i]!,
      };
    });
  }, 120_000);

  specs.forEach((s, i) => {
    test(s.name, async () => {
      const c = ctx[i]!;
      if (s.expectFail) {
        expect(c.result.ok).toBe(false);
      } else {
        expect(c.result.ok).toBe(true);
        expect(c.result.stdout.trim()).toBe(c.ts);
        if (s.expected !== undefined) {
          expect(c.result.stdout.trim()).toBe(s.expected);
        }
      }
      if (s.extra) await s.extra(c);
    });
  });
}
