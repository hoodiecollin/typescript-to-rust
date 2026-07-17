/**
 * The module-graph resolver (series 050) — the stage in front of `lowerCrate`.
 *
 * A single-file program lowers through `lower(program)`; a program that `import`s
 * a `./`-relative file becomes a **crate**: the entry file plus every module it
 * transitively imports, each mapped to a Rust module path mirroring its `./`-layout
 * (`./util/math` → `crate::util::math`). This resolver parses the entry, follows its
 * relative import/re-export edges (a **cycle-terminating** visited set — sibling
 * `mod`s in one crate are mutually visible, so a genuine cycle is *accepted*, the
 * set only bounds traversal), and returns the ordered `SourceModule[]` handed to
 * `lowerCrate`. A **bare/package** specifier (`"lodash"`, `"node:fs"`) is refused
 * fail-loud (no `node_modules`, no ambient modules); `@t2r/std` is the std shim, not
 * a module edge, so it is skipped here (recognized later in lowering).
 */

import { posix } from "node:path";
import { parseSync } from "oxc-parser";
import type { Program } from "./ast";
import { UnsupportedError } from "./errors";

/** One resolved source module in a crate. */
export interface SourceModule {
  /** Canonical (normalized) file key — an absolute path (CLI) or a virtual key (tests). */
  key: string;
  /**
   * The Rust module path from the crate root, mirroring the `./`-relative layout
   * (`["util","math"]` for `./util/math`). Empty (`[]`) for the entry (crate root).
   */
  modPath: string[];
  /** The parsed ESTree program. */
  program: Program;
  /** The raw source text (threaded for provenance; unused by lowering today). */
  source: string;
  /** The entry file (its top-level statements become `fn main`). */
  isEntry: boolean;
  /**
   * Each `./`-relative import/re-export specifier in this module → the target
   * module's `modPath`. `lowerCrate` reads this to translate `import { f } from
   * "./x"` into `use crate::<modPath>::f;`.
   */
  resolved: Map<string, string[]>;
}

/** How a source file is read — injected so tests supply an in-memory map. */
export type ReadFile = (key: string) => string | null;

/** A raw `./`-relative import/export edge extracted from a module body. */
interface Edge {
  /** The raw specifier string, e.g. `"./math"`. */
  source: string;
}

/** Collect every `./`-relative (and bare) module specifier a program references. */
function moduleEdges(program: Program): Edge[] {
  const edges: Edge[] = [];
  for (const stmt of program.body) {
    const s = stmt as { type: string; source?: { value?: unknown } | null };
    if (
      (s.type === "ImportDeclaration" ||
        s.type === "ExportNamedDeclaration" ||
        s.type === "ExportAllDeclaration") &&
      s.source &&
      typeof s.source.value === "string"
    ) {
      edges.push({ source: s.source.value });
    }
  }
  return edges;
}

/** Normalize a POSIX-style key so `./math.ts` and `math.ts` collapse to one. */
function canonical(key: string): string {
  const n = posix.normalize(key);
  return n.startsWith("./") ? n.slice(2) : n;
}

/**
 * Resolve a `./`-relative specifier against the importing file's directory,
 * trying `<spec>.ts`, then `<spec>/index.ts` (a barrel), then `<spec>` verbatim.
 * Returns the first key `readFile` can read, or throws fail-loud.
 */
function resolveRelative(
  fromDir: string,
  spec: string,
  readFile: ReadFile,
): string {
  const base = canonical(posix.join(fromDir, spec));
  const candidates = [`${base}.ts`, posix.join(base, "index.ts"), base].map(
    canonical,
  );
  for (const c of candidates) {
    if (readFile(c) !== null) return c;
  }
  throw new UnsupportedError({
    type: `cannot resolve module '${spec}' (looked for ${candidates.join(", ")})`,
  });
}

/**
 * Resolve a crate from its `entry` key, following `./`-relative import/re-export
 * edges transitively. Returns the modules in discovery order, entry first.
 * @throws {UnsupportedError} on a bare/package import or an unreadable file.
 */
export function resolveCrate(entry: string, readFile: ReadFile): SourceModule[] {
  const entryKey = canonical(entry);
  const entryDir = posix.dirname(entryKey);

  /** Map a resolved file key to its crate-root-relative Rust module path. */
  const keyToModPath = (key: string): string[] => {
    let rel = posix.relative(entryDir, key);
    rel = rel.replace(/\.ts$/, "");
    if (rel.startsWith("..")) {
      throw new UnsupportedError({
        type: `module '${key}' is outside the entry's directory (imports may not escape the crate root)`,
      });
    }
    return rel.split("/").filter((s) => s.length > 0);
  };

  const visited = new Map<string, SourceModule>();
  const order: SourceModule[] = [];

  const visit = (key: string, isEntry: boolean): void => {
    if (visited.has(key)) return;
    const source = readFile(key);
    if (source === null) {
      throw new UnsupportedError({ type: `cannot read module file '${key}'` });
    }
    const parsed = parseSync(key, source);
    if (parsed.errors.length > 0) {
      throw new UnsupportedError({
        type: `parse error in '${key}': ${parsed.errors[0]?.message ?? "unknown"}`,
      });
    }
    const program = parsed.program as unknown as Program;
    const mod: SourceModule = {
      key,
      modPath: isEntry ? [] : keyToModPath(key),
      program,
      source,
      isEntry,
      resolved: new Map(),
    };
    // Record before recursing so an import cycle terminates (the cycle itself is
    // accepted — sibling mods in one crate are mutually visible).
    visited.set(key, mod);
    order.push(mod);

    const fromDir = posix.dirname(key);
    for (const edge of moduleEdges(program)) {
      const spec = edge.source;
      // The `@t2r/std` std shim is not a module edge — recognized in lowering.
      if (spec === "@t2r/std") continue;
      if (!spec.startsWith(".")) {
        throw new UnsupportedError({
          type: `bare/package import '${spec}' (only \`./\`-relative imports; no node_modules)`,
        });
      }
      const targetKey = resolveRelative(fromDir, spec, readFile);
      mod.resolved.set(spec, keyToModPath(targetKey));
      visit(targetKey, false);
    }
  };

  visit(entryKey, true);
  return order;
}
