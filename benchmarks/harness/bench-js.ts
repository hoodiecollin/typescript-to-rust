/**
 * Steady-state JS side — measures each workload's hot `run()` in-process with
 * mitata (warmup + many samples + `do_not_optimize` anti-DCE), excluding process
 * startup. Run under whichever runtime invokes it: `node bench-js.ts` and
 * `bun run bench-js.ts`. Emits one machine-readable JSON line (prefixed
 * `__BENCHJS__`) that the orchestrator parses; mitata's own console output is
 * suppressed by using the low-level `measure()` primitive directly.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { do_not_optimize, measure } from "mitata";

const CORPUS = join(import.meta.dirname ?? __dirname, "..", "corpus");

// biome-ignore lint: runtime sniff — Bun defines a global `Bun`.
const RUNTIME = typeof (globalThis as any).Bun !== "undefined" ? "bun" : "node";

interface JsResult {
  name: string;
  minNs: number;
  p50Ns: number;
  avgNs: number;
}

const names = readdirSync(CORPUS)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => f.replace(/\.ts$/, ""))
  .sort();

const results: JsResult[] = [];
for (const name of names) {
  const mod = (await import(
    pathToFileURL(join(CORPUS, `${name}.ts`)).href
  )) as {
    run: () => number;
  };
  const run = mod.run;
  // Warm the JIT before measuring.
  for (let i = 0; i < 3; i++) do_not_optimize(run());
  const stats = await measure(() => {
    do_not_optimize(run());
  });
  results.push({
    name,
    minNs: stats.min,
    p50Ns: stats.p50,
    avgNs: stats.avg,
  });
  // Human-readable progress on stderr (keeps stdout clean for the JSON line).
  process.stderr.write(
    `  [${RUNTIME}] ${name.padEnd(12)} ${(stats.min / 1e6).toFixed(3)}ms\n`,
  );
}

console.log(`__BENCHJS__ ${JSON.stringify({ runtime: RUNTIME, results })}`);
