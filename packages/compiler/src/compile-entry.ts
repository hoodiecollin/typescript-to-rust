/**
 * Compile a strict-dialect TypeScript **entry** file to Rust, following its
 * `./`-relative `import`/`export` edges transitively (series 050). The single
 * production path shared by the `ttr` CLI and its tests.
 *
 * A lone entry (no relative imports) lowers through `lower()`/`emitModule` and
 * yields one `main.rs` — byte-identical to the pre-crate single-file behavior. An
 * entry that imports `./`-relative modules becomes a **crate**: `resolveCrate`
 * builds the ordered `SourceModule[]`, `lowerCrate` merges it, and `emitCrate`
 * renders one `.rs` per module (+ the generated module root). A **bare/package**
 * specifier is refused fail-loud by `resolveCrate` (no `node_modules`).
 */

import { resolveCrate, type ReadFile } from "./crate";
import { type CrateFile, emitModule, emitCrate } from "./emitter";
import { lower, lowerCrate } from "./lower";

export interface CompiledEntry {
  /** The emitted crate files (`main.rs`, then any module files). */
  files: CrateFile[];
  /** De-duplicated non-fatal diagnostics gathered during lowering. */
  warnings: string[];
  /** True when the entry pulled in ≥1 `./`-relative module (a multi-file crate). */
  isCrate: boolean;
}

/**
 * Resolve, lower, and emit the crate rooted at `entryKey`. `readFile` maps a
 * canonical module key to its source (an fs read for the CLI, an in-memory map in
 * tests); it returns `null` for a missing file.
 * @throws {UnsupportedError} on a bare/package import, an unreadable/unresolvable
 *   module, or any fail-loud dialect shape encountered while lowering.
 */
export function compileEntry(
  entryKey: string,
  readFile: ReadFile,
): CompiledEntry {
  const modules = resolveCrate(entryKey, readFile);
  const dedup = (ws: string[] | undefined): string[] => [...new Set(ws ?? [])];

  // A lone entry keeps the faithful single-file emit (no crate wrapping).
  if (modules.length === 1) {
    const only = modules[0]!;
    const mod = lower(only.program, only.source);
    return {
      files: [{ path: "main.rs", content: emitModule(mod) }],
      warnings: dedup(mod.warnings),
      isCrate: false,
    };
  }

  const mod = lowerCrate(modules);
  return { files: emitCrate(mod), warnings: dedup(mod.warnings), isCrate: true };
}
