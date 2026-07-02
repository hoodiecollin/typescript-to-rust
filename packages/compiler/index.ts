/**
 * CLI: compile a strict-dialect TypeScript file to Rust.
 *
 *   bun run index.ts <file.ts>            # print emitted Rust
 *   bun run index.ts <file.ts> --check    # also `cargo check` the output
 *   bun run index.ts <file.ts> --run      # also compile & run, print stdout
 */

import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import type { Program } from "./src/ast";
import { emit } from "./src/emitter";
import { checkRust, formatRust, runRust, summarizeErrors } from "./src/harness";

async function main(): Promise<void> {
  const [file, ...flags] = process.argv.slice(2);
  if (!file) {
    console.error("usage: bun run index.ts <file.ts> [--check|--run]");
    process.exit(1);
  }

  const source = readFileSync(file, "utf8");
  const parsed = parseSync(file, source);
  if (parsed.errors.length > 0) {
    console.error("Parse errors:");
    for (const e of parsed.errors) console.error(`  ${e.message}`);
    process.exit(1);
  }

  const rust = await formatRust(emit(parsed.program as unknown as Program));
  console.log(rust);

  if (flags.includes("--check") || flags.includes("--run")) {
    const result = flags.includes("--run")
      ? await runRust(rust)
      : await checkRust(rust);
    if (!result.ok) {
      console.error("\n--- cargo rejected the emitted Rust ---");
      console.error(summarizeErrors(result));
      process.exit(1);
    }
    if (flags.includes("--run")) {
      console.error("\n--- program output ---");
      process.stdout.write(result.stdout);
    } else {
      console.error("\n✓ emitted Rust compiles");
    }
  }
}

main();
