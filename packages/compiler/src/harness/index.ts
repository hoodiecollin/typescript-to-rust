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
 * A single persistent scratch crate is reused so the incremental-compile cache
 * stays warm. Access is serialized through a promise queue because the crate has
 * shared source files (`src/lib.rs`, `src/main.rs`); concurrent writers would
 * clobber each other.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CargoResult, cargoCheck, cargoRun, rustfmt } from "./cargo";

const SCRATCH_DIR = join(import.meta.dir, "..", "..", ".scratch");

/** A cargo crate the harness can write source into and compile/run. */
export class RustProject {
  readonly dir: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string = SCRATCH_DIR) {
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
        `Scratch crate missing Cargo.toml at ${this.dir}. Expected the committed .scratch crate to exist.`,
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
  run(source: string): Promise<CargoResult> {
    return this.lock(async () => {
      // A binary implicitly links the package library, so a `lib.rs` left
      // poisoned by a prior `check()` would break the build. Reset it.
      this.write("lib.rs", "");
      this.write("main.rs", source);
      return cargoRun(this.dir);
    });
  }
}

/** Shared instance backed by the committed `.scratch` crate. */
export const harness = new RustProject();

/** Convenience: compile a Rust source string, return the cargo result. */
export function checkRust(source: string): Promise<CargoResult> {
  return harness.check(source);
}

/** Convenience: compile + run, return the cargo result (`.stdout` = program output). */
export function runRust(source: string): Promise<CargoResult> {
  return harness.run(source);
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
