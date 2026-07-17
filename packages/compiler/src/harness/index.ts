/**
 * The verification harness — the project's real test oracle.
 *
 * Instead of asserting that emitted Rust string-matches a hand-written `.rs`
 * file (brittle, and historically full of Rust that didn't even compile), the
 * harness compiles and runs the emitted Rust with a real `cargo` toolchain:
 *
 *   - `check(src)`   — does it compile? (structured diagnostics on failure)
 *   - `run(src)`     — compile, run, capture stdout (behavioral oracle)
 *   - `format(src)`  — rustfmt-normalize (for human-readable snapshots)
 *
 * A single persistent oracle crate is reused so the incremental-compile cache
 * stays warm. Access is serialized through a promise queue because the crate has
 * shared source files (`src/lib.rs`, `src/main.rs`); concurrent writers would
 * clobber each other.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  type CargoResult,
  type IoInput,
  cargoBuildExamples,
  cargoCheck,
  cargoRun,
  prewarmDeps,
  rustfmt,
} from "./cargo";

const ORACLE_DIR = join(import.meta.dir, "..", "..", "rust-oracle");

/** A cargo crate the harness can write source into and compile/run. */
export class RustProject {
  readonly dir: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string = ORACLE_DIR) {
    this.dir = dir;
    this.ensureCrate();
  }

  private ensureCrate(): void {
    const srcDir = join(this.dir, "src");
    if (!existsSync(srcDir)) mkdirSync(srcDir, { recursive: true });
    if (!existsSync(join(srcDir, "main.rs")))
      writeFileSync(join(srcDir, "main.rs"), "fn main() {}\n");
    if (!existsSync(join(srcDir, "lib.rs")))
      writeFileSync(join(srcDir, "lib.rs"), "// scratch\n");
    if (!existsSync(join(this.dir, "Cargo.toml"))) {
      throw new Error(
        `Oracle crate missing Cargo.toml at ${this.dir}. Expected the committed rust-oracle crate to exist.`,
      );
    }
  }

  /** Serialize crate access — one src/main.rs, one writer at a time. */
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private write(target: "lib.rs" | "main.rs", source: string): void {
    writeFileSync(
      join(this.dir, "src", target),
      source.endsWith("\n") ? source : `${source}\n`,
    );
  }

  /**
   * Compile `source` as a library (no `main` required); resolves whether or not
   * it compiled (inspect `.ok`). Use for any item/expression snippet.
   */
  check(source: string): Promise<CargoResult> {
    return this.lock(async () => {
      this.write("lib.rs", source);
      return cargoCheck(this.dir);
    });
  }

  /**
   * Compile `source` as a binary and run it, capturing program stdout. Requires
   * a `fn main`. Use for behavioral / differential assertions.
   */
  run(source: string, io?: IoInput): Promise<CargoResult> {
    return this.lock(async () => {
      // A binary implicitly links the package library, so a `lib.rs` left
      // poisoned by a prior `check()` would break the build. Reset it.
      this.write("lib.rs", "");
      this.write("main.rs", source);
      return cargoRun(this.dir, io);
    });
  }

  /**
   * Compile the whole dependency graph once (see {@link prewarmDeps}). Serialized
   * through the same crate lock as every other operation, and writes the exact
   * trivial sources `runBatch` resets to, so it neither fights a concurrent writer
   * nor thrashes the lib/bin fingerprint the first real batch relies on. Returns
   * whether the pre-warm build succeeded.
   */
  prewarm(): Promise<boolean> {
    return this.lock(async () => {
      this.write("lib.rs", "");
      this.write("main.rs", "fn main() {}");
      return prewarmDeps(this.dir);
    });
  }

  /**
   * Compile many programs as `examples/<id>.rs` in ONE cargo invocation and run
   * the ones that compiled. The heavy dependency rlibs are built once and shared
   * across the whole batch, and cargo parallelizes the per-example codegen across
   * cores — far cheaper than N separate `run()` calls. Returns a map keyed by the
   * program `id` (each result's `.ok`/`.stdout`/`.errors` mirror `run()`).
   */
  runBatch(
    programs: { id: string; src: string; io?: IoInput }[],
  ): Promise<Map<string, CargoResult>> {
    return this.lock(async () => {
      // Reset the shared bin/lib so a program left by a prior run() can't break
      // the example build, and rewrite the examples dir from scratch so only
      // this batch's programs are present.
      this.write("lib.rs", "");
      this.write("main.rs", "fn main() {}");
      const exDir = join(this.dir, "examples");
      rmSync(exDir, { recursive: true, force: true });
      mkdirSync(exDir, { recursive: true });
      const ioById = new Map<string, IoInput>();
      for (const p of programs) {
        writeFileSync(
          join(exDir, `${p.id}.rs`),
          p.src.endsWith("\n") ? p.src : `${p.src}\n`,
        );
        if (p.io) ioById.set(p.id, p.io);
      }
      return cargoBuildExamples(
        this.dir,
        programs.map((p) => p.id),
        ioById,
      );
    });
  }
}

/** Shared instance backed by the committed `rust-oracle` crate. */
export const harness = new RustProject();

/**
 * Sentinel recording the dependency-graph fingerprint the target was last
 * pre-warmed for. Lives INSIDE `target/` so `cargo clean` (or a fresh checkout)
 * drops it and forces a re-warm; `/target` is gitignored so it never lands in vcs.
 */
const PREWARM_SENTINEL = join(ORACLE_DIR, "target", ".t2r-prewarm");

/** Fingerprint the inputs that determine the oracle's dependency graph. */
function depFingerprint(): string {
  const h = createHash("sha256");
  // `Cargo.toml` is the human-facing dep declaration (edited to add a crate);
  // `Cargo.lock` captures the exact resolved versions (transitive bumps). Either
  // changing means the compiled rlibs may be stale.
  for (const f of ["Cargo.toml", "Cargo.lock"]) {
    const p = join(ORACLE_DIR, f);
    h.update(f);
    h.update("\0");
    if (existsSync(p)) h.update(readFileSync(p));
    h.update("\0");
  }
  return h.digest("hex");
}

let depsWarmed: Promise<void> | null = null;

/**
 * Ensure every oracle dependency rlib is compiled before the suite runs any
 * cargo-backed spec — the fix for the cargo thundering-herd flake.
 *
 * Change-detected: the dependency graph is fingerprinted (the oracle's
 * `Cargo.toml` + `Cargo.lock`) and compared against {@link PREWARM_SENTINEL}. On a
 * match — the common case — this is a single file read and returns instantly. On a
 * mismatch (a crate was added / version-bumped) or a missing sentinel (a fresh or
 * `cargo clean`ed target) it runs {@link RustProject.prewarm} ONCE, serialized and
 * untimed, then records the fingerprint so later runs skip it. Memoized per
 * process; never rejects (a failed pre-warm just lets the individual specs surface
 * the real cargo diagnostics rather than aborting the whole suite).
 */
export function ensureDepsWarm(): Promise<void> {
  if (depsWarmed) return depsWarmed;
  depsWarmed = (async () => {
    try {
      const want = depFingerprint();
      if (
        existsSync(PREWARM_SENTINEL) &&
        readFileSync(PREWARM_SENTINEL, "utf8") === want
      ) {
        return; // deps already warm for this exact graph — nothing to do
      }
      console.error(
        "[t2r] rust-oracle dependency graph changed (or target cold) — " +
          "pre-warming rlibs once to avoid the cargo thundering-herd flake…",
      );
      const ok = await harness.prewarm();
      if (ok) {
        mkdirSync(dirname(PREWARM_SENTINEL), { recursive: true });
        writeFileSync(PREWARM_SENTINEL, want);
        console.error("[t2r] rust-oracle dependencies pre-warmed.");
      } else {
        console.error(
          "[t2r] pre-warm build did not succeed; specs will surface the real " +
            "cargo diagnostics.",
        );
      }
    } catch (err) {
      console.error(`[t2r] pre-warm skipped after error: ${String(err)}`);
    }
  })();
  return depsWarmed;
}

/** Convenience: compile a Rust source string, return the cargo result. */
export function checkRust(source: string): Promise<CargoResult> {
  return harness.check(source);
}

/** Convenience: compile + run, return the cargo result (`.stdout` = program output). */
export function runRust(source: string, io?: IoInput): Promise<CargoResult> {
  return harness.run(source, io);
}

/** Convenience: rustfmt-normalize a Rust source string. */
export function formatRust(source: string): Promise<string> {
  return rustfmt(source);
}

/** Compact one-line summary of the first error, for test failure messages. */
export function summarizeErrors(result: CargoResult): string {
  if (result.errors.length === 0) return "(no errors)";
  return result.errors
    .map((e) => {
      const span = e.spans.find((s) => s.is_primary) ?? e.spans[0];
      const loc = span ? `${span.line_start}:${span.column_start} ` : "";
      const code = e.code ? `[${e.code}] ` : "";
      return `${loc}${code}${e.message}`;
    })
    .join("\n");
}
