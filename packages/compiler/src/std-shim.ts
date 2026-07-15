/**
 * The `@t2r/std` std-shim recognition surface (series 084, epic #52).
 *
 * `@t2r/std` is a third routing lane: blessed TS functions the developer imports
 * *instead of* footgun APIs, recognized by the compiler **by the reserved import
 * specifier** — never a name heuristic. This module owns the specifier + the set
 * of intrinsic names, and the AST scan that collects a module's local→intrinsic
 * bindings. Both `validate.ts` (fail-loud guard) and `lower.ts` (call routing)
 * consume it, so the recognition rule lives in exactly one place.
 */

import type { ImportDeclaration, ImportSpecifier, Program } from "./ast";

/** The reserved import specifier. Recognition keys off exactly this string. */
export const STD_SHIM_SPECIFIER = "@t2r/std";

/**
 * The intrinsic names `@t2r/std` exports (the Tier-A surface). `JsonValue`
 * (series 090) is a **type** intrinsic, not a callable one — it is recognized so
 * `import { JsonValue }` validates and a `JsonValue` type reference resolves, but
 * it is never lowered as a value call.
 */
export type StdShimName =
  | "parseJson"
  | "stringifyJson"
  | "rng"
  | "parseJsonValue"
  | "fromJsonValue"
  | "toJsonValue"
  | "JsonValue";

/** The set of exported intrinsic names, for membership + "not exported" errors. */
export const STD_SHIM_EXPORTS: ReadonlySet<string> = new Set<StdShimName>([
  "parseJson",
  "stringifyJson",
  "rng",
  "parseJsonValue",
  "fromJsonValue",
  "toJsonValue",
  "JsonValue",
]);

/**
 * Scan a program's top-level `import { … } from "@t2r/std"` statements and build
 * the local-alias → intrinsic-name map (`import { parseJson as pj }` →
 * `pj → "parseJson"`). Imports from any other specifier are ignored here (the
 * validator rejects them separately); an unknown `@t2r/std` name is likewise the
 * validator's job. This scan only *collects* the recognized bindings.
 */
export function collectStdShimBindings(
  program: Program,
): Map<string, StdShimName> {
  const bindings = new Map<string, StdShimName>();
  for (const stmt of program.body) {
    if (stmt.type !== "ImportDeclaration") continue;
    const decl = stmt as unknown as ImportDeclaration;
    if (decl.source.value !== STD_SHIM_SPECIFIER) continue;
    for (const spec of decl.specifiers) {
      if (spec.type !== "ImportSpecifier") continue;
      const s = spec as ImportSpecifier;
      if (STD_SHIM_EXPORTS.has(s.imported.name)) {
        bindings.set(s.local.name, s.imported.name as StdShimName);
      }
    }
  }
  return bindings;
}
