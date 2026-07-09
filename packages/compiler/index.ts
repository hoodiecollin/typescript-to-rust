/**
 * CLI: compile a strict-dialect TypeScript file to Rust.
 *
 *   bun run index.ts <file.ts>              # print raw emitted Rust to stdout
 *   bun run index.ts <file.ts> --fmt        # rustfmt-normalize the output
 *   bun run index.ts <file.ts> -o out.rs    # write the .rs to a path
 *   bun run index.ts <file.ts> --emit       # write a sibling .rs next to source
 *   bun run index.ts <file.ts> --check      # also `cargo check` the output
 *   bun run index.ts <file.ts> --run        # also compile & run, print stdout
 *
 * Emitter output is RAW by default (faithful for debugging what the emitter
 * produces); pass `--fmt` to run it through rustfmt. Formatting is applied
 * uniformly — to stdout, to any file written, and to what `--check`/`--run`
 * compiles — so what you inspect is exactly what got verified.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSync } from "oxc-parser";
import type { Program } from "./src/ast";
import { emit } from "./src/emitter";
import { checkRust, formatRust, runRust, summarizeErrors } from "./src/harness";

const USAGE =
  "usage: bun run index.ts <file.ts> [--fmt] [-o <path>] [--emit] [--check|--run]";

/** Derive the sibling `.rs` path for a TypeScript source file. */
function siblingRustPath(tsFile: string): string {
  return `${tsFile.replace(/\.[cm]?tsx?$/, "")}.rs`;
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

  const source = readFileSync(file, "utf8");
  const parsed = parseSync(file, source);
  if (parsed.errors.length > 0) {
    console.error("Parse errors:");
    for (const e of parsed.errors) console.error(`  ${e.message}`);
    process.exit(1);
  }

  const emitted = emit(parsed.program as unknown as Program);
  const rust = fmt ? await formatRust(emitted) : emitted;

  // Resolve every file destination (explicit `-o` paths plus `--emit` sibling).
  const targets = [...outPaths];
  if (emitSibling) targets.push(siblingRustPath(file));

  if (targets.length > 0) {
    // File output requested — write each target, keep stdout quiet, report paths.
    for (const target of targets) {
      writeFileSync(target, rust.endsWith("\n") ? rust : `${rust}\n`);
      console.error(`wrote ${resolve(target)}`);
    }
  } else {
    console.log(rust);
  }

  if (check || run) {
    const result = run ? await runRust(rust) : await checkRust(rust);
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
