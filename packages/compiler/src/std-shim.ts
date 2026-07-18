/**
 * The `@ttr/std` std-shim recognition surface (series 084, epic #52).
 *
 * `@ttr/std` is a third routing lane: blessed TS functions the developer imports
 * *instead of* footgun APIs, recognized by the compiler **by the reserved import
 * specifier** — never a name heuristic. This module owns the specifier + the set
 * of intrinsic names, and the AST scan that collects a module's local→intrinsic
 * bindings. Both `validate.ts` (fail-loud guard) and `lower.ts` (call routing)
 * consume it, so the recognition rule lives in exactly one place.
 */

import type { ImportDeclaration, ImportSpecifier, Program } from "./ast";

/** The reserved import specifier. Recognition keys off exactly this string. */
export const STD_SHIM_SPECIFIER = "@ttr/std";

/**
 * The intrinsic names `@ttr/std` exports (the Tier-A surface). `JsonValue`
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
  | "JsonValue"
  // I/O surface (series 100, epic #52). Flat sync fs / env / process / stdin
  // intrinsics + the `fsAsync`/`http` namespace objects + the `Writer`/
  // `HttpResponse` type intrinsics (recognized for import + type resolution).
  | "readFile"
  | "writeFile"
  | "appendFile"
  | "exists"
  | "removeFile"
  | "readDir"
  | "mkdir"
  | "removeDir"
  | "env"
  | "args"
  | "exit"
  | "readStdin"
  | "readLine"
  | "stdout"
  | "stderr"
  | "fsAsync"
  | "http"
  | "Writer"
  | "HttpResponse"
  // Date/time surface (series 102, epic #56). `clock(epochMs)` is the seeded,
  // differential-stable replacement for ambient `Date.now()`/`new Date()` (the
  // `Date` analog of `rng(seed)`) — a `tslib::date::Clock` handle.
  | "clock";

/** The set of exported intrinsic names, for membership + "not exported" errors. */
export const STD_SHIM_EXPORTS: ReadonlySet<string> = new Set<StdShimName>([
  "parseJson",
  "stringifyJson",
  "rng",
  "parseJsonValue",
  "fromJsonValue",
  "toJsonValue",
  "JsonValue",
  // I/O (series 100)
  "readFile",
  "writeFile",
  "appendFile",
  "exists",
  "removeFile",
  "readDir",
  "mkdir",
  "removeDir",
  "env",
  "args",
  "exit",
  "readStdin",
  "readLine",
  "stdout",
  "stderr",
  "fsAsync",
  "http",
  "Writer",
  "HttpResponse",
  // Date/time (series 102)
  "clock",
]);

/**
 * The `@ttr/std` I/O intrinsics whose lowering is **fallible** — a call reaches
 * the 049 fallibility fixpoint as a fallible leaf (its containing fn becomes
 * `Result`-returning; the call site threads `?`, or `.await?` for the async
 * ones). The infallible carve-outs (`exists`/`env`/`args`/`exit`/`stdout`/
 * `stderr`, and handle *acquisition*) are absent here (design §5).
 */
export const FALLIBLE_SYNC_IO: ReadonlySet<StdShimName> = new Set([
  "readFile",
  "writeFile",
  "appendFile",
  "removeFile",
  "readDir",
  "mkdir",
  "removeDir",
  "readStdin",
  "readLine",
]);

/**
 * Scan a program's top-level `import { … } from "@ttr/std"` statements and build
 * the local-alias → intrinsic-name map (`import { parseJson as pj }` →
 * `pj → "parseJson"`). Imports from any other specifier are ignored here (the
 * validator rejects them separately); an unknown `@ttr/std` name is likewise the
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
