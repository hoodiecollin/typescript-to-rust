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

async function spawn(
  cmd: string[],
  cwd: string,
  stdin?: string,
): Promise<SpawnResult> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    // Inherit the environment so the user's rust toolchain (rustup shims, etc.)
    // resolves exactly as it would in their shell.
    env: { ...process.env },
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
 * `cargo run`, returning the program's stdout. Checks the *binary* target first
 * so compile errors surface as structured diagnostics rather than opaque build
 * failure, then runs the binary for its output. The check step warms/fetches
 * dependencies, so the run itself can stay offline.
 */
export async function cargoRun(cwd: string): Promise<CargoResult> {
  const build = await runCargo(["check", "--bins"], cwd);
  const diagnostics = parseDiagnostics(build.stdout);
  const checked = classify(
    build.exitCode,
    diagnostics,
    build.stdout,
    build.stderr,
  );
  if (!checked.ok) return checked;

  const { exitCode, stdout, stderr } = await spawn(
    ["cargo", "run", "--offline", "--quiet", "--color=never"],
    cwd,
  );
  return classify(exitCode, diagnostics, stdout, stderr);
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
