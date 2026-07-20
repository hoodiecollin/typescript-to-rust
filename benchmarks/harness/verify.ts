/**
 * Correctness cross-check — the guard that node, bun, and TTR execute *equivalent*
 * logic before any timing is trusted. It builds the release workspace, then for
 * each workload runs the printing entry under node and bun and runs the TTR release
 * binary, asserting all three stdout values are byte-identical. A mismatch is a hard
 * error: a benchmark whose variants disagree is meaningless.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUILD_DIR,
  CORPUS_DIR,
  buildReleaseWorkspace,
  entrySource,
  listWorkloads,
  runTimed,
} from "./lib";

/** Write a workload's printing entry + corpus source to disk for node/bun runs. */
export function stageEntry(name: string): string {
  const genDir = join(BUILD_DIR, "verify", name);
  mkdirSync(genDir, { recursive: true });
  writeFileSync(
    join(genDir, `${name}.ts`),
    readFileSync(join(CORPUS_DIR, `${name}.ts`), "utf8"),
  );
  const entryPath = join(genDir, "main.ts");
  writeFileSync(entryPath, entrySource(name));
  return entryPath;
}

export interface VerifyResult {
  name: string;
  ok: boolean;
  node: string;
  bun: string;
  ttr: string;
}

export async function verifyAll(): Promise<VerifyResult[]> {
  const names = listWorkloads();
  const binaries = await buildReleaseWorkspace(names);

  const results: VerifyResult[] = [];
  for (const name of names) {
    const entryPath = stageEntry(name);
    const [node, bun, ttr] = await Promise.all([
      runTimed(["node", entryPath]).then((r) => r.stdout),
      runTimed(["bun", "run", entryPath]).then((r) => r.stdout),
      runTimed([binaries.get(name)!]).then((r) => r.stdout),
    ]);
    const ok = node === bun && bun === ttr && ttr.length > 0;
    results.push({ name, ok, node, bun, ttr });
    console.log(
      `${ok ? "✓" : "✗"} ${name.padEnd(12)} node=${node} bun=${bun} ttr=${ttr}`,
    );
  }
  return results;
}

if (import.meta.main) {
  const results = await verifyAll();
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} workload(s) disagree:`);
    for (const f of failed) {
      console.error(`  ${f.name}: node=${f.node} bun=${f.bun} ttr=${f.ttr}`);
    }
    process.exit(1);
  }
  console.log(`\nAll ${results.length} workloads agree across node/bun/ttr.`);
}
