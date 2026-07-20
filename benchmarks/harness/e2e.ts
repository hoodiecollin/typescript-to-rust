/**
 * End-to-end harness — the "you ran the script" story. For each workload it spawns
 * the whole process (node on the `.ts`, bun on the `.ts`, the TTR native binary) N
 * times and records wall-clock + peak RSS per run. This deliberately *includes*
 * process startup + runtime init, which is where an AOT-native binary has its
 * largest, most honest advantage over V8/JIT warmup.
 *
 * A near-empty startup baseline is measured too, so compute ≈ workload − startup.
 * Artifact size (the stripped release binary) is reported as a third axis: the
 * native binary is self-contained, whereas node/bun need their whole runtime
 * present to run anything.
 */

import { statSync } from "node:fs";
import {
  buildReleaseWorkspace,
  buildStartupBaseline,
  listWorkloads,
  runTimed,
  summarize,
} from "./lib";
import { stageEntry } from "./verify";

/** Runs per (target, workload). First run is discarded as warmup. */
const RUNS = 10;

export type Target = "node" | "bun" | "ttr";

export interface Measurement {
  target: Target;
  msMin: number;
  msMedian: number;
  msStdev: number;
  rssBytes: number | null;
}

export interface WorkloadE2E {
  name: string;
  /** Native release binary size in bytes (the TTR artifact). */
  binaryBytes: number;
  measurements: Record<Target, Measurement>;
}

/** Spawn `argv` RUNS+1 times (dropping the warmup) and summarize wall-clock + RSS. */
async function measure(target: Target, argv: string[]): Promise<Measurement> {
  const ms: number[] = [];
  let rssBytes: number | null = null;
  for (let i = 0; i <= RUNS; i++) {
    const r = await runTimed(argv);
    if (r.code !== 0)
      throw new Error(`${target} exited ${r.code}: ${argv.join(" ")}`);
    if (i === 0) continue; // warmup
    ms.push(r.ms);
    if (r.rssBytes !== null) rssBytes = Math.max(rssBytes ?? 0, r.rssBytes);
  }
  const s = summarize(ms);
  return {
    target,
    msMin: s.min,
    msMedian: s.median,
    msStdev: s.stdev,
    rssBytes,
  };
}

export interface E2EReport {
  startup: Record<Target, Measurement>;
  workloads: WorkloadE2E[];
}

export async function runE2E(): Promise<E2EReport> {
  const names = listWorkloads();
  console.log(`building release workspace (${names.length} workloads)…`);
  const binaries = await buildReleaseWorkspace(names);
  const startup = await buildStartupBaseline();

  console.log(`measuring startup baseline…`);
  const startupR: Record<Target, Measurement> = {
    node: await measure("node", ["node", startup.tsEntry]),
    bun: await measure("bun", ["bun", "run", startup.tsEntry]),
    ttr: await measure("ttr", [startup.binary]),
  };

  const workloads: WorkloadE2E[] = [];
  for (const name of names) {
    const entry = stageEntry(name);
    const bin = binaries.get(name)!;
    console.log(`measuring ${name}…`);
    const measurements: Record<Target, Measurement> = {
      node: await measure("node", ["node", entry]),
      bun: await measure("bun", ["bun", "run", entry]),
      ttr: await measure("ttr", [bin]),
    };
    workloads.push({
      name,
      binaryBytes: statSync(bin).size,
      measurements,
    });
  }
  return { startup: startupR, workloads };
}

function fmtMs(ms: number): string {
  return ms >= 100 ? `${ms.toFixed(0)}ms` : `${ms.toFixed(1)}ms`;
}
function fmtMB(bytes: number | null): string {
  return bytes === null ? "—" : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function printE2E(report: E2EReport): void {
  const { startup, workloads } = report;
  console.log(`\n${"=".repeat(74)}`);
  console.log("END-TO-END  (whole process: startup + compute; min of 10 runs)");
  console.log("=".repeat(74));
  console.log(
    `startup floor    node ${fmtMs(startup.node.msMin)}   bun ${fmtMs(
      startup.bun.msMin,
    )}   ttr ${fmtMs(startup.ttr.msMin)}`,
  );
  console.log(
    "\n" +
      "workload".padEnd(12) +
      "node".padStart(10) +
      "bun".padStart(10) +
      "ttr".padStart(10) +
      "ttr speedup".padStart(16) +
      "  (vs bun / vs node)",
  );
  console.log("-".repeat(74));
  for (const w of workloads) {
    const n = w.measurements.node.msMin;
    const b = w.measurements.bun.msMin;
    const t = w.measurements.ttr.msMin;
    console.log(
      w.name.padEnd(12) +
        fmtMs(n).padStart(10) +
        fmtMs(b).padStart(10) +
        fmtMs(t).padStart(10) +
        `${(b / t).toFixed(1)}× / ${(n / t).toFixed(1)}×`.padStart(16),
    );
  }
  console.log("-".repeat(74));
  console.log("\nPeak RSS (max resident set) + native artifact size:");
  console.log(
    "workload".padEnd(12) +
      "node".padStart(9) +
      "bun".padStart(9) +
      "ttr".padStart(9) +
      "ttr binary".padStart(14),
  );
  for (const w of workloads) {
    console.log(
      w.name.padEnd(12) +
        fmtMB(w.measurements.node.rssBytes).padStart(9) +
        fmtMB(w.measurements.bun.rssBytes).padStart(9) +
        fmtMB(w.measurements.ttr.rssBytes).padStart(9) +
        `${(w.binaryBytes / 1024).toFixed(0)}KB`.padStart(14),
    );
  }
}

if (import.meta.main) {
  const report = await runE2E();
  printE2E(report);
}
