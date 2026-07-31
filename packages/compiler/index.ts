/**
 * CLI: compile a strict-dialect TypeScript entry file to Rust, following its
 * `./`-relative imports transitively into a multi-file crate (series 050).
 *
 *   bun run index.ts <file.ts>              # print raw emitted Rust to stdout
 *   bun run index.ts <file.ts> --fmt        # rustfmt-normalize the output
 *   bun run index.ts <file.ts> -o out.rs    # write the .rs to a path (crate: a dir)
 *   bun run index.ts <file.ts> --emit       # write output next to source
 *   bun run index.ts <file.ts> --check      # also `cargo check` the output
 *   bun run index.ts <file.ts> --run        # also compile & run, print stdout
 *   bun run index.ts <file.ts> --emit --pin-toolchain   # + a rust-toolchain.toml
 *
 * A lone entry emits one file; an entry that imports `./`-relative modules emits a
 * **crate** (one `.rs` per module). A bare/package import is refused fail-loud.
 *
 * Emitter output is RAW by default (faithful for debugging what the emitter
 * produces); pass `--fmt` to run it through rustfmt. Formatting is applied
 * uniformly — to stdout, to any file written, and to what `--check`/`--run`
 * compiles — so what you inspect is exactly what got verified.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CrateFile } from "./src/emitter";
import { compileEntry } from "./src/compile-entry";
import { FacadeError } from "./src/facade";
import { runFacade } from "./src/facade-cli";
import {
  ToolchainError,
  emittedPinChannel,
  generateRustToolchainToml,
  loadToolchainConfig,
  normalizeChannelVersion,
} from "./src/toolchain";
import {
  checkRust,
  formatRust,
  harness,
  runRust,
  summarizeErrors,
} from "./src/harness";

const USAGE =
  "usage: bun run index.ts <file.ts> [--fmt] [-o <path>] [--emit] [--check|--run] [--pin-toolchain [--toolchain <channel>]]";

/**
 * The `ttr facade <crate>` subcommand (series 122) — generate a mirror-plugin
 * facade from a Rust crate's rustdoc JSON. Dispatched ahead of the default
 * compile flow so `facade` is a first-class verb, not a flag.
 */
async function facadeCommand(argv: string[]): Promise<void> {
  try {
    const { dtsPath, tablePath, model } = await runFacade(argv);
    console.error(`wrote ${resolve(dtsPath)}`);
    console.error(`wrote ${resolve(tablePath)}`);
    const omitted =
      model.rejects.length > 0 ? `, ${model.rejects.length} omitted` : "";
    console.error(
      `facade: ${model.types.length} type(s), ${model.methods.length} method(s)${omitted}`,
    );
  } catch (err) {
    const loud = err instanceof FacadeError || err instanceof ToolchainError;
    console.error(loud ? (err as Error).message : String(err));
    process.exit(1);
  }
}

/** Derive the sibling `.rs` path for a TypeScript source file. */
function siblingRustPath(tsFile: string): string {
  return `${tsFile.replace(/\.[cm]?tsx?$/, "")}.rs`;
}

/** Derive the sibling crate-directory path (`<stem>.crate/`) for a crate emit. */
function siblingCrateDir(tsFile: string): string {
  return `${tsFile.replace(/\.[cm]?tsx?$/, "")}.crate`;
}

/** Render a crate's files to a single stdout blob, each under a `// === path ===` header. */
function joinCrate(files: CrateFile[]): string {
  return files.map((f) => `// === ${f.path} ===\n${f.content}`).join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv[0] === "facade") {
    await facadeCommand(argv.slice(1));
    return;
  }

  let file: string | undefined;
  let fmt = false;
  let emitSibling = false;
  let check = false;
  let run = false;
  let pinToolchain = false;
  let toolchainOverride: string | undefined;
  const outPaths: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "--fmt":
        fmt = true;
        break;
      case "--emit":
        emitSibling = true;
        break;
      case "--check":
        check = true;
        break;
      case "--run":
        run = true;
        break;
      case "--pin-toolchain":
        pinToolchain = true;
        break;
      case "--toolchain": {
        const value = argv[++i];
        if (!value) {
          console.error("--toolchain requires a channel argument");
          process.exit(1);
        }
        toolchainOverride = value;
        break;
      }
      case "-o":
      case "--out": {
        const value = argv[++i];
        if (!value) {
          console.error(`${arg} requires a path argument`);
          process.exit(1);
        }
        outPaths.push(value);
        break;
      }
      default:
        if (arg.startsWith("-")) {
          console.error(`unknown flag: ${arg}\n${USAGE}`);
          process.exit(1);
        }
        if (file) {
          console.error(`unexpected extra argument: ${arg}\n${USAGE}`);
          process.exit(1);
        }
        file = arg;
    }
  }

  if (!file) {
    console.error(USAGE);
    process.exit(1);
  }

  // Resolve the entry to an absolute key; `compileEntry` follows `./`-relative
  // imports transitively (a lone entry stays single-file). A bare/package import
  // or unresolvable module throws — surfaced below as a fail-loud diagnostic.
  const entryKey = resolve(file);
  const readFile = (key: string): string | null => {
    try {
      return readFileSync(key, "utf8");
    } catch {
      return null;
    }
  };

  let compiled: ReturnType<typeof compileEntry>;
  try {
    compiled = compileEntry(entryKey, readFile);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Optionally rustfmt each file (a separate file is formatted independently).
  const files: CrateFile[] = fmt
    ? await Promise.all(
        compiled.files.map(async (f) => ({
          path: f.path,
          content: await formatRust(f.content),
        })),
      )
    : compiled.files;

  // Non-fatal diagnostics (series 056) — e.g. the bitwise wide-int divergence —
  // surface on stderr, independent of `--fmt` (which only touches the source text).
  for (const warning of compiled.warnings) {
    console.error(`warning: ${warning}`);
  }

  const withNl = (s: string): string => (s.endsWith("\n") ? s : `${s}\n`);

  // ── File output (`-o` / `--emit`) ─────────────────────────────────────────
  // A single-file emit honors `-o <path>` verbatim; a crate writes its tree under
  // a directory (`-o <dir>` / the `<stem>.crate/` sibling for `--emit`).
  const dirTargets = [...outPaths];
  if (compiled.isCrate && emitSibling) dirTargets.push(siblingCrateDir(file));

  // A `rust-toolchain.toml` pins the emitted crate's toolchain (series 123, stretch
  // phase). It is opt-in (`--pin-toolchain`) and needs a directory to live in, so it
  // only applies to a crate emit written to a directory; misuse fails loud.
  if (pinToolchain && !(compiled.isCrate && dirTargets.length > 0)) {
    console.error(
      "--pin-toolchain requires a crate emit to a directory (-o <dir> or --emit)",
    );
    process.exit(1);
  }
  const pinChannel = pinToolchain
    ? toolchainOverride
      ? normalizeChannelVersion(toolchainOverride)
      : emittedPinChannel(loadToolchainConfig({ cwd: process.cwd() }))
    : "";

  if (compiled.isCrate) {
    if (dirTargets.length > 0) {
      for (const dir of dirTargets) {
        for (const f of files) {
          const dest = join(dir, f.path);
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, withNl(f.content));
        }
        if (pinToolchain) {
          const dest = join(dir, "rust-toolchain.toml");
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(
            dest,
            generateRustToolchainToml({ channel: pinChannel }),
          );
          console.error(
            `wrote ${resolve(dest)} (pinned toolchain: ${pinChannel})`,
          );
        }
        console.error(`wrote ${files.length} file(s) to ${resolve(dir)}/`);
      }
    } else {
      console.log(joinCrate(files));
    }
  } else {
    const rust = files[0]!.content;
    const fileTargets = [...outPaths];
    if (emitSibling) fileTargets.push(siblingRustPath(file));
    if (fileTargets.length > 0) {
      for (const target of fileTargets) {
        writeFileSync(target, withNl(rust));
        console.error(`wrote ${resolve(target)}`);
      }
    } else {
      console.log(rust);
    }
  }

  // ── Optional compile / run ────────────────────────────────────────────────
  if (check || run) {
    let result: Awaited<ReturnType<typeof runRust>>;
    if (compiled.isCrate) {
      // A crate builds as a directory example so cargo sees all its module files.
      const batch = await harness.runBatch([{ id: "ttr_cli", files }]);
      result = batch.get("ttr_cli")!;
    } else {
      const rust = files[0]!.content;
      result = run ? await runRust(rust) : await checkRust(rust);
    }
    if (!result.ok) {
      console.error("\n--- cargo rejected the emitted Rust ---");
      console.error(summarizeErrors(result));
      process.exit(1);
    }
    if (run) {
      console.error("\n--- program output ---");
      process.stdout.write(result.stdout);
    } else {
      console.error("\n✓ emitted Rust compiles");
    }
  }
}

main();
