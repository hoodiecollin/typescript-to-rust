/**
 * Benchmark orchestrator — the single entry point (`bun bench`). It runs the whole
 * pipeline and prints the combined report:
 *
 *   1. Correctness cross-check   — node ≡ bun ≡ ttr stdout, or abort (a benchmark
 *                                  whose variants disagree is meaningless).
 *   2. End-to-end wall-clock     — whole-process time + peak RSS + artifact size
 *                                  (includes startup; TTR's real-world advantage).
 *   3. Steady-state throughput   — the hot `run()` alone, startup excluded:
 *                                  mitata under node & bun, criterion for TTR.
 *
 * Two honest stories side by side: end-to-end (where native startup dominates) and
 * steady-state (where a warmed JIT is genuinely competitive). Emits a JSON artifact
 * and a Markdown report under `benchmarks/.build/`.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type E2EReport, printE2E, runE2E } from "./e2e";
import { BUILD_DIR, ROOT, listWorkloads, runCriterion } from "./lib";
import { verifyAll } from "./verify";

interface JsResult {
  name: string;
  minNs: number;
  p50Ns: number;
  avgNs: number;
}

/** Spawn `bench-js.ts` under a runtime, returning its per-workload hot-loop stats. */
async function steadyStateJs(
  runtime: "node" | "bun",
): Promise<Map<string, JsResult>> {
  const script = join(ROOT, "benchmarks/harness/bench-js.ts");
  const argv = runtime === "node" ? ["node", script] : ["bun", "run", script];
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "inherit" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  const line = stdout.split("\n").find((l) => l.startsWith("__BENCHJS__"));
  if (!line)
    throw new Error(`${runtime}: no __BENCHJS__ line in bench-js output`);
  const parsed = JSON.parse(line.slice("__BENCHJS__ ".length)) as {
    results: JsResult[];
  };
  return new Map(parsed.results.map((r) => [r.name, r]));
}

function fmtMs(ms: number): string {
  return ms >= 100
    ? `${ms.toFixed(0)}ms`
    : ms >= 1
      ? `${ms.toFixed(1)}ms`
      : `${(ms * 1000).toFixed(0)}µs`;
}

interface SteadyRow {
  name: string;
  nodeMs: number;
  bunMs: number;
  ttrMs: number;
}

function printSteadyState(rows: SteadyRow[]): void {
  console.log(`\n${"=".repeat(74)}`);
  console.log(
    "STEADY-STATE  (hot run() only, startup excluded — mitata / criterion)",
  );
  console.log("=".repeat(74));
  console.log(
    "workload".padEnd(12) +
      "node".padStart(10) +
      "bun".padStart(10) +
      "ttr".padStart(10) +
      "ttr speedup".padStart(18) +
      "  (vs bun / vs node)",
  );
  console.log("-".repeat(74));
  for (const r of rows) {
    console.log(
      r.name.padEnd(12) +
        fmtMs(r.nodeMs).padStart(10) +
        fmtMs(r.bunMs).padStart(10) +
        fmtMs(r.ttrMs).padStart(10) +
        `${(r.bunMs / r.ttrMs).toFixed(1)}× / ${(r.nodeMs / r.ttrMs).toFixed(1)}×`.padStart(
          18,
        ),
    );
  }
  console.log("-".repeat(74));
  console.log(
    "note: JS = mitata min (JIT warmed); ttr = criterion median. >1× ⇒ TTR faster.",
  );
}

function toMarkdown(e2e: E2EReport, steady: SteadyRow[]): string {
  const l: string[] = [];
  l.push("# Node vs Bun vs TTR — benchmark report\n");
  l.push(
    "Two measurements over one shared corpus. **End-to-end** is the whole process " +
      "(startup + compute) — the real-world 'you ran the script' cost, where the " +
      "native binary's lack of runtime warmup dominates. **Steady-state** is the hot " +
      "`run()` alone (mitata under node/bun, criterion for TTR) — where a warmed JIT " +
      "is genuinely competitive.\n",
  );
  l.push(
    `Startup floor (near-empty program): node ${e2e.startup.node.msMin.toFixed(1)}ms · ` +
      `bun ${e2e.startup.bun.msMin.toFixed(1)}ms · ttr ${e2e.startup.ttr.msMin.toFixed(1)}ms\n`,
  );
  l.push("## End-to-end wall-clock (min of 10 runs)\n");
  l.push("| workload | node | bun | ttr | ttr vs bun | ttr vs node |");
  l.push("|---|--:|--:|--:|--:|--:|");
  for (const w of e2e.workloads) {
    const n = w.measurements.node.msMin;
    const b = w.measurements.bun.msMin;
    const t = w.measurements.ttr.msMin;
    l.push(
      `| ${w.name} | ${fmtMs(n)} | ${fmtMs(b)} | ${fmtMs(t)} | ${(b / t).toFixed(1)}× | ${(n / t).toFixed(1)}× |`,
    );
  }
  l.push("\n## Steady-state hot loop (mitata min / criterion median)\n");
  l.push("| workload | node | bun | ttr | ttr vs bun | ttr vs node |");
  l.push("|---|--:|--:|--:|--:|--:|");
  for (const r of steady) {
    l.push(
      `| ${r.name} | ${fmtMs(r.nodeMs)} | ${fmtMs(r.bunMs)} | ${fmtMs(r.ttrMs)} | ${(r.bunMs / r.ttrMs).toFixed(1)}× | ${(r.nodeMs / r.ttrMs).toFixed(1)}× |`,
    );
  }
  l.push("\n## Peak memory (max RSS) + native artifact size\n");
  l.push("| workload | node | bun | ttr | ttr binary |");
  l.push("|---|--:|--:|--:|--:|");
  for (const w of e2e.workloads) {
    const mb = (x: number | null) =>
      x === null ? "—" : `${(x / 1048576).toFixed(1)}MB`;
    l.push(
      `| ${w.name} | ${mb(w.measurements.node.rssBytes)} | ${mb(w.measurements.bun.rssBytes)} | ${mb(w.measurements.ttr.rssBytes)} | ${(w.binaryBytes / 1024).toFixed(0)}KB |`,
    );
  }
  return l.join("\n") + "\n";
}

async function main(): Promise<void> {
  console.log("① correctness cross-check\n" + "-".repeat(40));
  const verify = await verifyAll();
  if (verify.some((v) => !v.ok)) {
    console.error(
      "\nABORT: workloads disagree across runtimes; fix before timing.",
    );
    process.exit(1);
  }

  console.log("\n② end-to-end wall-clock + memory\n" + "-".repeat(40));
  const e2e = await runE2E();

  console.log("\n③ steady-state hot loop\n" + "-".repeat(40));
  const [nodeJs, bunJs, crit] = await Promise.all([
    steadyStateJs("node"),
    steadyStateJs("bun"),
    runCriterion(listWorkloads()),
  ]);
  const steady: SteadyRow[] = listWorkloads().map((name) => ({
    name,
    nodeMs: nodeJs.get(name)!.minNs / 1e6,
    bunMs: bunJs.get(name)!.minNs / 1e6,
    ttrMs: crit.get(name)! / 1e6,
  }));

  printE2E(e2e);
  printSteadyState(steady);

  const jsonPath = join(BUILD_DIR, "report.json");
  const mdPath = join(BUILD_DIR, "report.md");
  writeFileSync(jsonPath, JSON.stringify({ e2e, steady }, null, 2));
  writeFileSync(mdPath, toMarkdown(e2e, steady));
  console.log(`\nartifacts: ${jsonPath}\n           ${mdPath}`);
}

if (import.meta.main) await main();
