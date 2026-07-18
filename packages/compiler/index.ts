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
import {
  checkRust,
  formatRust,
  harness,
  runRust,
  summarizeErrors,
} from "./src/harness";

const USAGE =
  "usage: bun run index.ts <file.ts> [--fmt] [-o <path>] [--emit] [--check|--run]";

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

  let file: string | undefined;
  let fmt = false;
  let emitSibling = false;
  let check = false;
  let run = false;
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
  if (compiled.isCrate) {
    if (emitSibling) dirTargets.push(siblingCrateDir(file));
    if (dirTargets.length > 0) {
      for (const dir of dirTargets) {
        for (const f of files) {
          const dest = join(dir, f.path);
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, withNl(f.content));
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
