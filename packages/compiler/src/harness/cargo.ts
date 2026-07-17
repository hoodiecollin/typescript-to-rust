/**
 * Thin, typed driver around `cargo` / `rustfmt`.
 *
 * The whole point of owning this in TypeScript (rather than shelling out to a
 * makefile or comparing against hand-written `.rs` golden files) is leverage:
 * we parse cargo's structured JSON diagnostics, so the harness can reason about
 * *why* emitted Rust failed — error code, message, and source span — and map it
 * back to the originating TypeScript later. Plain string-equality against
 * hand-written Rust can't do that, and (as the old fixtures proved) lets invalid
 * Rust masquerade as a passing oracle.
 */

import { join } from "node:path";

/** A single source span attached to a rustc diagnostic. */
export interface DiagnosticSpan {
  file_name: string;
  line_start: number;
  line_end: number;
  column_start: number;
  column_end: number;
  is_primary: boolean;
}

/** A normalized rustc diagnostic extracted from `--message-format=json`. */
export interface RustDiagnostic {
  level: "error" | "warning" | "note" | "help" | string;
  message: string;
  /** rustc error code, e.g. `E0308`, when present. */
  code: string | null;
  spans: DiagnosticSpan[];
  /** The human-formatted block rustc would have printed to a terminal. */
  rendered: string;
}

/** Result of a `cargo` invocation. */
export interface CargoResult {
  ok: boolean;
  exitCode: number;
  diagnostics: RustDiagnostic[];
  errors: RustDiagnostic[];
  warnings: RustDiagnostic[];
  /** Raw stdout (cargo JSON for check; program output for run). */
  stdout: string;
  stderr: string;
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Program I/O fed **identically** to the Bun run and the Rust run of a
 * differential spec (series 100): `stdin` bytes, extra `argv` (the user args
 * after the binary/script name), and `env` overrides (merged over `process.env`
 * — e.g. `T2R_TMP`, `T2R_BASE_URL`). Threaded through `run`/`runBatch` →
 * `cargoRun`/`cargoBuildExamples` → the built binary, so a file-I/O round-trip,
 * an `args()`/`env()` echo, or a `readStdin()` all observe the same inputs.
 */
export interface IoInput {
  stdin?: string;
  args?: string[];
  env?: Record<string, string>;
}

async function spawn(
  cmd: string[],
  cwd: string,
  stdin?: string,
  envOverride?: Record<string, string>,
): Promise<SpawnResult> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    // Inherit the environment so the user's rust toolchain (rustup shims, etc.)
    // resolves exactly as it would in their shell; `envOverride` layers per-run
    // I/O vars (series 100) on top.
    env: { ...process.env, ...envOverride },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** The slice of cargo's `--message-format=json` schema this harness consumes. */
interface CargoMessage {
  reason?: string;
  message?: {
    level: string;
    message: string;
    code?: { code?: string } | null;
    spans?: Array<{
      file_name: string;
      line_start: number;
      line_end: number;
      column_start: number;
      column_end: number;
      is_primary?: boolean;
    }>;
    rendered?: string;
  };
}

/** Parse a stream of `cargo --message-format=json` lines into diagnostics. */
export function parseDiagnostics(jsonStream: string): RustDiagnostic[] {
  const out: RustDiagnostic[] = [];
  for (const line of jsonStream.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    let parsed: CargoMessage;
    try {
      parsed = JSON.parse(trimmed) as CargoMessage;
    } catch {
      continue;
    }
    if (parsed.reason !== "compiler-message" || !parsed.message) continue;
    const m = parsed.message;
    // The top-level "aborting due to N errors" summary has no code/spans and
    // only adds noise; skip it.
    if (
      !m.code &&
      (!m.spans || m.spans.length === 0) &&
      m.level === "error" &&
      /^aborting due to|^For more information about/.test(m.message)
    ) {
      continue;
    }
    out.push({
      level: m.level,
      message: m.message,
      code: m.code?.code ?? null,
      spans: (m.spans ?? []).map((s) => ({
        file_name: s.file_name,
        line_start: s.line_start,
        line_end: s.line_end,
        column_start: s.column_start,
        column_end: s.column_end,
        is_primary: !!s.is_primary,
      })),
      rendered: m.rendered ?? "",
    });
  }
  return out;
}

function classify(
  exitCode: number,
  diagnostics: RustDiagnostic[],
  stdout: string,
  stderr: string,
): CargoResult {
  const errors = diagnostics.filter((d) => d.level === "error");
  const warnings = diagnostics.filter((d) => d.level === "warning");
  return {
    ok: exitCode === 0 && errors.length === 0,
    exitCode,
    diagnostics,
    errors,
    warnings,
    stdout,
    stderr,
  };
}

/**
 * Run a cargo subcommand offline-first, falling back to online.
 *
 * Generated code may depend on crates.io packages (e.g. `tokio` for async). We
 * try `--offline` for speed when the cache is warm; if cargo fails *before
 * producing any compiler diagnostics* — the signature of a dependency-resolution
 * failure (cold cache) rather than a code error — we retry online so the crate
 * is fetched. Real compile errors always come back with diagnostics and never
 * trigger a (pointless) online retry.
 */
async function runCargo(
  subcommand: string[],
  cwd: string,
): Promise<SpawnResult> {
  const json = ["--message-format=json", "--color=never"];
  const offline = await spawn(
    ["cargo", ...subcommand, "--offline", ...json],
    cwd,
  );
  if (offline.exitCode === 0 || parseDiagnostics(offline.stdout).length > 0) {
    return offline;
  }
  return spawn(["cargo", ...subcommand, ...json], cwd);
}

/**
 * `cargo check` (no codegen) with structured diagnostics.
 *
 * Checks the *library* target so bare-function snippets (no `main`) still
 * verify — a Rust binary requires `main`, a library does not.
 */
export async function cargoCheck(cwd: string): Promise<CargoResult> {
  const { exitCode, stdout, stderr } = await runCargo(["check", "--lib"], cwd);
  return classify(exitCode, parseDiagnostics(stdout), stdout, stderr);
}

/**
 * Build the binary target and run it, returning the program's stdout.
 *
 * A single `cargo build --bins` (with structured JSON diagnostics) does the
 * codegen+link, then we exec the produced binary **directly**. This replaces the
 * old two-invocation path (`cargo check --bins` *then* `cargo run`), which paid
 * for a second cargo process that re-fingerprinted the whole dependency graph
 * and re-ran codegen. Compile errors still surface as structured diagnostics
 * (build emits the same JSON as check); a clean build guarantees the binary
 * exists. Exec-ing the binary directly also yields pure program stdout, with no
 * cargo status noise to strip.
 */
export async function cargoRun(
  cwd: string,
  io?: IoInput,
): Promise<CargoResult> {
  const build = await runCargo(["build", "--bins"], cwd);
  const diagnostics = parseDiagnostics(build.stdout);
  const checked = classify(
    build.exitCode,
    diagnostics,
    build.stdout,
    build.stderr,
  );
  if (!checked.ok) return checked;

  const bin = join(cwd, "target", "debug", "rust_oracle");
  // Thread the per-run I/O (series 100): argv after the binary, stdin, env.
  const { exitCode, stdout, stderr } = await spawn(
    [bin, ...(io?.args ?? [])],
    cwd,
    io?.stdin,
    io?.env,
  );
  return classify(exitCode, diagnostics, stdout, stderr);
}

/**
 * Pre-warm every declared dependency rlib in a single `cargo build`.
 *
 * The thundering-herd flake: when a crate is added to the oracle's `Cargo.toml`,
 * the FIRST differential batch that touches cargo pays the entire cold compile of
 * that crate (+ its transitive deps) — under a per-test / `beforeAll` timeout that
 * was sized for *warm* builds. The cold compile races that timeout, gets killed
 * mid-build, and leaves a partially-populated `target/` that cascades into a burst
 * of unrelated failures.
 *
 * A plain `cargo build` (lib + bin, no `--examples`) forces cargo to compile the
 * whole dependency graph — the same rlibs every later example batch reuses — once,
 * up front, with no competing timeout. Offline-first with an online fallback on a
 * cold registry cache, mirroring {@link runCargo}. stderr is inherited so the cold
 * compile is visible; this only runs on the cold / dep-changed path (the caller
 * skips it when the graph is unchanged), so it adds no noise to warm runs.
 * Returns whether the build succeeded.
 */
export async function prewarmDeps(cwd: string): Promise<boolean> {
  const build = (online: boolean): Promise<number> =>
    Bun.spawn(["cargo", "build", ...(online ? [] : ["--offline"])], {
      cwd,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
      env: { ...process.env },
    }).exited;
  // A cold registry cache fails `--offline` (the crate source isn't downloaded);
  // retry online to fetch, then compile. Our trivial lib/bin never fails to
  // compile, so an offline failure only ever means "needs the network".
  if ((await build(false)) === 0) return true;
  return (await build(true)) === 0;
}

/** Run `fn`s over `items` with at most `limit` in flight; preserves order. */
export async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return out;
}

/** One `compiler-message` / `compiler-artifact` line, with its owning target. */
interface TargetedMessage extends CargoMessage {
  target?: { name?: string; kind?: string[] };
  executable?: string | null;
}

/**
 * Batch-build many example programs in a single cargo invocation and run the
 * ones that compiled.
 *
 * All programs are `examples/<id>.rs` in the shared oracle crate, so the heavy
 * dependency rlibs are compiled **once** and reused across every example (and the
 * carve-out programs that are *expected* to fail). Only *this batch's* ids are
 * built — via explicit `--example <id>` flags rather than `--examples` — so the
 * persistent examples dir can hold every file's programs (see `runBatch`) without
 * this invocation recompiling anyone else's; unchanged examples from a prior run
 * stay cache-hit. `--keep-going` builds every listed example that can compile even
 * when others fail; `--message-format=json` attributes each compile error to its
 * example target, and each produced binary to its `executable` path. Programs that
 * build are executed (bounded concurrency) for their stdout; programs that fail to
 * build — or that build but exit non-zero at runtime — come back as `ok: false`,
 * which is exactly what the fail-loud carve-out specs assert. Returns a map keyed
 * by `id`.
 */
export async function cargoBuildExamples(
  cwd: string,
  ids: string[],
  ioById?: ReadonlyMap<string, IoInput>,
): Promise<Map<string, CargoResult>> {
  if (ids.length === 0) return new Map();
  const exampleFlags = ids.flatMap((id) => ["--example", id]);
  const build = await runCargo(["build", ...exampleFlags, "--keep-going"], cwd);

  const execById = new Map<string, string>();
  const errsById = new Map<string, RustDiagnostic[]>();
  for (const line of build.stdout.split("\n")) {
    const t = line.trim();
    if (!t || t[0] !== "{") continue;
    let m: TargetedMessage;
    try {
      m = JSON.parse(t) as TargetedMessage;
    } catch {
      continue;
    }
    const name = m.target?.name;
    if (!name) continue;
    if (
      m.reason === "compiler-artifact" &&
      m.target?.kind?.includes("example") &&
      m.executable
    ) {
      execById.set(name, m.executable);
    } else if (
      m.reason === "compiler-message" &&
      m.message?.level === "error"
    ) {
      const [d] = parseDiagnostics(t);
      if (d) (errsById.get(name) ?? errsById.set(name, []).get(name)!).push(d);
    }
  }

  const out = new Map<string, CargoResult>();
  await mapBounded(ids, 8, async (id) => {
    const exe = execById.get(id);
    if (exe) {
      // Thread the per-example I/O (series 100): argv, stdin, env.
      const io = ioById?.get(id);
      const { exitCode, stdout, stderr } = await spawn(
        [exe, ...(io?.args ?? [])],
        cwd,
        io?.stdin,
        io?.env,
      );
      out.set(id, classify(exitCode, [], stdout, stderr));
      return;
    }
    const errors = errsById.get(id) ?? [];
    out.set(id, {
      ok: false,
      exitCode: 1,
      diagnostics: errors,
      errors,
      warnings: [],
      stdout: "",
      stderr: "",
    });
  });
  return out;
}

/** Format a Rust source string via `rustfmt` (stdin → stdout). */
export async function rustfmt(
  source: string,
  edition = "2021",
): Promise<string> {
  const { exitCode, stdout } = await spawn(
    ["rustfmt", "--edition", edition],
    process.cwd(),
    source,
  );
  // If rustfmt can't parse the input it exits non-zero and emits nothing useful;
  // fall back to the original so callers still see something.
  return exitCode === 0 && stdout.length > 0 ? stdout : source;
}
