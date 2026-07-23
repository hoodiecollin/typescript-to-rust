/**
 * Byte-identical corpus snapshot for the series-109 `lower.ts` modularization.
 *
 *   bun run lower:snapshot        # write the baseline from the current tree
 *   bun run lower:verify          # recompute and diff against the baseline
 *
 * Phase 1 of the modularization (#93) is a *pure relocation* of lowering code into
 * a `lower/` folder-module: the emitted Rust must be **byte-identical** after every
 * extraction commit. This harness pins that. It drives the real production entry
 * (`compileEntry`) over a fixed, sorted corpus — every `.ts` under
 * `tests/fixtures` (recursively) plus every `.ts` in `benchmarks/corpus` — and
 * records, per entry, either the emitted
 * crate bytes or the fail-loud error message (rejections are behavior too). The
 * concatenation is the snapshot; `verify` fails loud on the first drift.
 *
 * The baseline lives at `packages/compiler/.lower-baseline.txt` (gitignored). Take
 * it once against the pre-refactor tree, then re-verify after each commit. A
 * non-empty diff is an extraction bug — never regenerate the baseline to "fix" it
 * (regenerate only from a known-good tree, e.g. the Phase-1 start commit).
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileEntry } from "../src/compile-entry";

const COMPILER_DIR = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(COMPILER_DIR, "..", "..");
const BASELINE = join(COMPILER_DIR, ".lower-baseline.txt");

/**
 * The two corpus roots. `fixtures` are compiled as-is from the filesystem (they
 * are authored to be entries). `benchmarks/corpus` programs are perf workloads
 * that `export function run` and carry no `main`; we mirror the bench harness'
 * `emitBinary` transform (strip the `export`, append a `console.log(run())`
 * driver) so they emit real Rust — exercising the hottest lowering paths — instead
 * of erroring at the top-level `export`.
 */
const CORPUS_ROOTS: Array<{ dir: string; benchWorkload: boolean }> = [
  { dir: join(COMPILER_DIR, "tests", "fixtures"), benchWorkload: false },
  { dir: join(REPO_ROOT, "benchmarks", "corpus"), benchWorkload: true },
];

/** Recursively collect every `.ts` file under `dir`, sorted for determinism. */
function collectTs(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** fs-backed `ReadFile`, identical to the CLI's resolver. */
function readFile(key: string): string | null {
  try {
    return readFileSync(key, "utf8");
  } catch {
    return null;
  }
}

/** Mirror the bench harness `emitBinary` transform for a perf workload. */
function benchBinarySource(src: string): string {
  const unexported = src.replace(/\bexport\s+function\s+run\b/, "function run");
  return `${unexported}\nconsole.log(run());\n`;
}

/** Compile one entry, returning the emitted crate bytes or the fail-loud message. */
function snapshotEntry(absPath: string, benchWorkload: boolean): string {
  try {
    let files: { path: string; content: string }[];
    let kind: string;
    if (benchWorkload) {
      const key = "/virtual/w.ts";
      const src = benchBinarySource(readFileSync(absPath, "utf8"));
      files = compileEntry(key, (k) => (k === key ? src : null)).files;
      kind = "bench";
    } else {
      const compiled = compileEntry(absPath, readFile);
      files = compiled.files;
      kind = compiled.isCrate ? "crate" : "single";
    }
    const body = files
      .map((f) => `// --- ${f.path} ---\n${f.content}`)
      .join("\n");
    return `[${kind}]\n${body}`;
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return `[error] ${msg}`;
  }
}

/** Build the full corpus snapshot as one deterministic string. */
function buildSnapshot(): string {
  const entries: string[] = [];
  for (const root of CORPUS_ROOTS) {
    for (const abs of collectTs(root.dir)) {
      const rel = abs.slice(REPO_ROOT.length + 1);
      entries.push(`===== ${rel} =====\n${snapshotEntry(abs, root.benchWorkload)}`);
    }
  }
  return `${entries.join("\n\n")}\n`;
}

/** Report the first differing line between baseline and current, with context. */
function firstDiff(baseline: string, current: string): string {
  const a = baseline.split("\n");
  const b = current.split("\n");
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      const ctx = (lines: string[]): string =>
        lines
          .slice(Math.max(0, i - 3), i + 4)
          .map((l, k) => `${Math.max(0, i - 3) + k === i ? "> " : "  "}${l}`)
          .join("\n");
      return [
        `First drift at line ${i + 1}:`,
        "--- baseline ---",
        ctx(a),
        "--- current ---",
        ctx(b),
      ].join("\n");
    }
  }
  return "(snapshots differ in length only)";
}

const mode = process.argv[2];
const snapshot = buildSnapshot();
const entryCount = (snapshot.match(/^===== /gm) ?? []).length;

if (mode === "snapshot") {
  writeFileSync(BASELINE, snapshot);
  console.log(`lower:snapshot — wrote baseline (${entryCount} entries) → ${BASELINE}`);
} else if (mode === "verify") {
  let baseline: string;
  try {
    baseline = readFileSync(BASELINE, "utf8");
  } catch {
    console.error(`lower:verify — no baseline at ${BASELINE}; run \`bun run lower:snapshot\` first.`);
    process.exit(2);
  }
  if (baseline === snapshot) {
    console.log(`lower:verify — OK, byte-identical (${entryCount} entries).`);
  } else {
    console.error(`lower:verify — DRIFT DETECTED (${entryCount} entries).`);
    console.error(firstDiff(baseline, snapshot));
    process.exit(1);
  }
} else {
  console.error("usage: bun run lower-snapshot.ts <snapshot|verify>");
  process.exit(2);
}
