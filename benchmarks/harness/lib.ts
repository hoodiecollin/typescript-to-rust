/**
 * Shared benchmark-harness plumbing: enumerate the corpus, emit each workload to
 * Rust via the real compiler (`compileEntry`), assemble release cargo crates, and
 * run commands while capturing wall-clock + peak RSS.
 *
 * Every workload in `corpus/` exports a pure `run(): number`. It is consumed three
 * ways: imported directly (mitata, under node and bun), compiled to a `pub fn run`
 * lib crate (criterion), and wrapped in a printing entry compiled to a release
 * binary (end-to-end wall-clock).
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileEntry } from "../../packages/compiler/src/compile-entry";

/**
 * Write only when the content differs. Cargo fingerprints on mtime, so rewriting a
 * byte-identical source would needlessly invalidate its cache and force a recompile;
 * skipping the write keeps the mtime stable and lets a re-run genuinely cache-hit.
 */
function writeIfChanged(path: string, content: string): void {
  try {
    if (readFileSync(path, "utf8") === content) return;
  } catch {
    // missing/unreadable → fall through and write
  }
  writeFileSync(path, content);
}

export const ROOT = join(import.meta.dir, "..", "..");
export const CORPUS_DIR = join(import.meta.dir, "..", "corpus");
export const BUILD_DIR = join(import.meta.dir, "..", ".build");
export const ORACLE_TOML = join(
  ROOT,
  "packages/compiler/rust-oracle/Cargo.toml",
);

/** The corpus workload names (file stems of `corpus/*.ts`), sorted stably. */
export function listWorkloads(): string[] {
  return readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.replace(/\.ts$/, ""))
    .sort();
}

/**
 * Source of the printing entry that wraps a workload for the e2e binary. The
 * import carries an explicit `.ts` extension: Node's native type-stripping does no
 * extension resolution (extensionless `./name` throws `ERR_MODULE_NOT_FOUND`),
 * while Bun and TTR both accept the explicit form.
 */
export function entrySource(name: string): string {
  return `import { run } from "./${name}.ts";\nconsole.log(run());\n`;
}

/** Read a corpus workload's TS source. */
export function workloadSource(name: string): string {
  return readFileSync(join(CORPUS_DIR, `${name}.ts`), "utf8");
}

/**
 * Strip the `export` keyword off the workload's `run` so the source is a plain
 * single-file program. A single-file emit keeps hoisted arrow-callback functions
 * (`__cb_map_*`, sort comparators) in the *same* module as their call sites — a
 * two-file crate would hoist them into the entry root where the workload submodule
 * cannot see them (a cross-module callback-hoist limitation).
 */
function unexport(src: string): string {
  return src.replace(/\bexport\s+function\s+run\b/, "function run");
}

/** Compile a single-file TS source to one Rust module via the real compiler. */
function emitSingle(src: string): string {
  const key = "/virtual/w.ts";
  const { files } = compileEntry(key, (k) => (k === key ? src : null));
  return files[0]!.content;
}

/**
 * Emit the e2e **binary** source: the workload plus a `console.log(run())` entry,
 * as one module (`fn run` + `fn main`). Built to a release binary and also run for
 * the correctness cross-check.
 */
export function emitBinary(name: string): string {
  return emitSingle(`${unexport(workloadSource(name))}\nconsole.log(run());\n`);
}

/**
 * Emit the criterion **lib** source: just the workload (`fn run` + any hoisted
 * callbacks, no `main`), with `run` promoted to `pub` so a bench in a sibling
 * crate can call it.
 */
export function emitLib(name: string): string {
  const rust = emitSingle(unexport(workloadSource(name)));
  const pubbed = rust.replace(/\bfn run\(/, "pub fn run(");
  if (!pubbed.includes("pub fn run(")) {
    throw new Error(`emitLib(${name}): could not find \`fn run(\` to promote`);
  }
  return pubbed;
}

/**
 * The `[dependencies]` block from the oracle crate, with the two `crates/*` path
 * deps rewritten to absolute so a generated crate anywhere on disk resolves them.
 * Mirroring the oracle keeps versions/features identical and the cargo cache warm.
 */
export function depsBlock(): string {
  const toml = readFileSync(ORACLE_TOML, "utf8");
  const lines = toml.split("\n");
  const start = lines.findIndex((l) => l.trim() === "[dependencies]");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\[/.test(lines[i]!.trim())) {
      end = i;
      break;
    }
  }
  const cratesAbs = join(ROOT, "crates");
  return lines
    .slice(start + 1, end)
    .map((l) =>
      l
        .replace(
          '{ path = "../../../crates/ts-primitives" }',
          `{ path = "${join(cratesAbs, "ts-primitives")}" }`,
        )
        .replace(
          '{ path = "../../../crates/tslib" }',
          `{ path = "${join(cratesAbs, "tslib")}" }`,
        ),
    )
    .join("\n")
    .trim();
}

/** Ship-grade release profile: what a user compiling for production would pick. */
export const RELEASE_PROFILE = `[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1
panic = "abort"
strip = true`;

/** Root of the generated release workspace (one bin crate per workload). */
export const RUST_WS = join(BUILD_DIR, "rust");

/**
 * The dependency set the corpus needs, with `crates/*` as absolute path deps.
 * Deliberately trimmed from the oracle's full set (no tokio/reqwest/serde/…): the
 * corpus is sync + network-free, and dropping the heavy async/HTTP crates keeps the
 * one-time release build fast. `tslib` still transitively pulls its own deps
 * (regex, chrono) which compile once and are shared across every member.
 */
export function benchDeps(): string {
  const crates = join(ROOT, "crates");
  return [
    `ts-primitives = { path = "${join(crates, "ts-primitives")}" }`,
    `tslib = { path = "${join(crates, "tslib")}" }`,
    `indexmap = "2"`,
    `ordered-float = "4"`,
  ].join("\n");
}

/** The release binary path for a workload (valid after `buildReleaseWorkspace`). */
export function binaryPath(name: string): string {
  return join(RUST_WS, "target", "release", name);
}

/**
 * Materialize the release workspace: a virtual-manifest root carrying the shared
 * `[profile.release]`, plus one `wl_<name>` bin crate per workload whose `main.rs`
 * is the emitted binary source. All members share ONE `target/`, so the dependency
 * rlibs compile a single time.
 */
export function writeReleaseWorkspace(names: string[]): void {
  const members = names.map((n) => `"wl_${n}"`).join(", ");
  mkdirSync(RUST_WS, { recursive: true });
  writeIfChanged(
    join(RUST_WS, "Cargo.toml"),
    `# Generated by benchmarks/harness — do not edit by hand.\n[workspace]\nresolver = "2"\nmembers = [${members}]\n\n${RELEASE_PROFILE}\n`,
  );
  const deps = benchDeps();
  for (const name of names) {
    const crateDir = join(RUST_WS, `wl_${name}`);
    mkdirSync(join(crateDir, "src"), { recursive: true });
    writeIfChanged(
      join(crateDir, "Cargo.toml"),
      `[package]\nname = "wl_${name}"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[[bin]]\nname = "${name}"\npath = "src/main.rs"\n\n[dependencies]\n${deps}\n`,
    );
    writeIfChanged(join(crateDir, "src", "main.rs"), `${emitBinary(name)}\n`);
  }
}

/** Root of the generated criterion workspace (lib crate per workload + runner). */
export const CRIT_WS = join(BUILD_DIR, "criterion");

/**
 * Materialize the criterion workspace: one `wl_<name>` **lib** crate per workload
 * (exposing `pub fn run`), plus a `runner` crate whose criterion bench calls each
 * `run` under `black_box`. All share one `target/`, so deps (and criterion itself)
 * compile once. criterion runs `default-features = false` — no plotters/html — to
 * keep the build lean; measurement is unaffected.
 */
export function writeCriterionWorkspace(names: string[]): void {
  const members = [...names.map((n) => `"wl_${n}"`), `"runner"`].join(", ");
  mkdirSync(CRIT_WS, { recursive: true });
  writeIfChanged(
    join(CRIT_WS, "Cargo.toml"),
    `# Generated by benchmarks/harness — do not edit by hand.\n[workspace]\nresolver = "2"\nmembers = [${members}]\n\n${RELEASE_PROFILE}\n`,
  );
  const deps = benchDeps();
  for (const name of names) {
    const crateDir = join(CRIT_WS, `wl_${name}`);
    mkdirSync(join(crateDir, "src"), { recursive: true });
    writeIfChanged(
      join(crateDir, "Cargo.toml"),
      `[package]\nname = "wl_${name}"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[lib]\npath = "src/lib.rs"\n\n[dependencies]\n${deps}\n`,
    );
    writeIfChanged(join(crateDir, "src", "lib.rs"), `${emitLib(name)}\n`);
  }

  // The runner: depends on every lib crate + criterion, one bench target.
  const runnerDir = join(CRIT_WS, "runner");
  mkdirSync(join(runnerDir, "benches"), { recursive: true });
  const libDeps = names
    .map((n) => `wl_${n} = { path = "../wl_${n}" }`)
    .join("\n");
  writeIfChanged(
    join(runnerDir, "Cargo.toml"),
    `[package]\nname = "runner"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[dependencies]\n${libDeps}\n\n[dev-dependencies]\ncriterion = { version = "0.5", default-features = false }\n\n[[bench]]\nname = "all"\nharness = false\n`,
  );
  // Defeat const-folding: `run` is a nullary pure fn, so LTO would precompute it
  // and `black_box` on the *result* can't stop that. Black-boxing the fn *pointer*
  // forces an opaque indirect call each iteration, so the body actually runs.
  const calls = names
    .map(
      (n) =>
        `    c.bench_function("${n}", |b| {\n        let f = black_box(wl_${n}::run as fn() -> f64);\n        b.iter(|| black_box(f()));\n    });`,
    )
    .join("\n");
  writeIfChanged(
    join(runnerDir, "benches", "all.rs"),
    `use criterion::{black_box, criterion_group, criterion_main, Criterion};\n\nfn benches(c: &mut Criterion) {\n${calls}\n}\n\ncriterion_group!(g, benches);\ncriterion_main!(g);\n`,
  );
}

/**
 * Run `cargo bench` over the criterion workspace (streaming output), then parse
 * each workload's `target/criterion/<name>/new/estimates.json` for the median
 * estimate. Returns the map of workload → median nanoseconds.
 */
export async function runCriterion(
  names: string[],
): Promise<Map<string, number>> {
  writeCriterionWorkspace(names);
  const proc = Bun.spawn(
    ["cargo", "bench", "--manifest-path", join(CRIT_WS, "Cargo.toml")],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await proc.exited) !== 0) throw new Error("cargo bench failed");

  const out = new Map<string, number>();
  for (const name of names) {
    const p = join(
      CRIT_WS,
      "target",
      "criterion",
      name,
      "new",
      "estimates.json",
    );
    const j = JSON.parse(readFileSync(p, "utf8"));
    // criterion writes point estimates in nanoseconds; keys have varied in case
    // across versions, so accept either.
    const median = j.median ?? j.Median;
    out.set(name, median.point_estimate);
  }
  return out;
}

export interface StartupBaseline {
  /** A `console.log(0)` TS entry (run under node/bun). */
  tsEntry: string;
  /** A native binary that just prints `0` (the TTR-side floor). */
  binary: string;
}

/**
 * Build the startup baseline — the near-empty program whose runtime is pure
 * process start + interpreter/runtime init, no workload. Subtracting it from a
 * workload's wall-clock isolates the compute cost from fixed startup. Built as a
 * standalone dep-free crate (compiles in ~1s, so it needs no shared target).
 */
export async function buildStartupBaseline(): Promise<StartupBaseline> {
  const tsDir = join(BUILD_DIR, "startup-ts");
  mkdirSync(tsDir, { recursive: true });
  const tsEntry = join(tsDir, "main.ts");
  writeFileSync(tsEntry, "console.log(0);\n");

  const rsDir = join(BUILD_DIR, "startup-rs");
  mkdirSync(join(rsDir, "src"), { recursive: true });
  writeFileSync(
    join(rsDir, "Cargo.toml"),
    `[package]\nname = "startup"\nversion = "0.0.0"\nedition = "2021"\npublish = false\n\n[[bin]]\nname = "startup"\npath = "src/main.rs"\n\n${RELEASE_PROFILE}\n\n[workspace]\n`,
  );
  writeFileSync(
    join(rsDir, "src", "main.rs"),
    'fn main() {\n    println!("0");\n}\n',
  );
  const proc = Bun.spawn(
    [
      "cargo",
      "build",
      "--release",
      "--manifest-path",
      join(rsDir, "Cargo.toml"),
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await proc.exited) !== 0)
    throw new Error("startup baseline build failed");
  return { tsEntry, binary: join(rsDir, "target", "release", "startup") };
}

/**
 * Build the whole release workspace (`cargo build --release`), streaming cargo's
 * output so a hang or error is visible. Returns the map of workload → binary path.
 * Throws if cargo fails.
 */
export async function buildReleaseWorkspace(
  names: string[],
): Promise<Map<string, string>> {
  writeReleaseWorkspace(names);
  const proc = Bun.spawn(
    [
      "cargo",
      "build",
      "--release",
      "--manifest-path",
      join(RUST_WS, "Cargo.toml"),
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`cargo build --release failed (exit ${code})`);
  }
  return new Map(names.map((n) => [n, binaryPath(n)]));
}

export interface RunStats {
  /** Trimmed stdout of the process. */
  stdout: string;
  /** Wall-clock milliseconds for the process (harness-measured). */
  ms: number;
  /** Peak resident set size in bytes (from `/usr/bin/time -l`), or null. */
  rssBytes: number | null;
  /** Process exit code. */
  code: number;
}

/**
 * Run `argv` under `/usr/bin/time -l` (macOS) so we capture peak RSS alongside
 * wall-clock. `time`'s report goes to stderr; stdout is the program's own. The
 * harness also stamps its own wall-clock around the spawn as the timing of record
 * (monotonic, excludes `time`'s negligible overhead).
 */
export async function runTimed(
  argv: string[],
  opts?: { cwd?: string },
): Promise<RunStats> {
  const wrapped = ["/usr/bin/time", "-l", ...argv];
  const t0 = Bun.nanoseconds();
  const proc = Bun.spawn(wrapped, {
    cwd: opts?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TZ: "UTC" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  const ms = (Bun.nanoseconds() - t0) / 1e6;
  const m = stderr.match(/(\d+)\s+maximum resident set size/);
  const rssBytes = m ? Number(m[1]) : null;
  return { stdout: stdout.trim(), ms, rssBytes, code };
}

/** Convenience: minimum/mean/median/stdev over a numeric sample. */
export function summarize(xs: number[]): {
  min: number;
  mean: number;
  median: number;
  stdev: number;
} {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const median =
    n % 2 === 0 ? (s[n / 2 - 1]! + s[n / 2]!) / 2 : s[(n - 1) / 2]!;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { min: s[0]!, mean, median, stdev: Math.sqrt(variance) };
}
