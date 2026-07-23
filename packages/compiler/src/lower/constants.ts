/**
 * Cross-cutting frozen constants shared across the `lower/` modules (series 109).
 *
 * These are the genuinely module-agnostic values — the `RustType` shortcuts, the
 * default-export symbol, the shared empty type-param set. Domain-specific tables
 * (regex/date/io/string method maps, bitwise-op sets, …) live with their own
 * module, not here.
 */

import type { RustType } from "../hir";

/** The Rust unit type `()`. */
export const UNIT: RustType = { kind: "unit" };

/** The default fallible error type: the `Error` message as a `String`. */
export const ERR_STRING: RustType = { kind: "String" };

/** The synthetic symbol a `export default <expr>` binds to (series 050). A default
 * import binds it via `use crate::<mod>::__default_export as <local>;`. */
export const DEFAULT_EXPORT_SYM = "__default_export";

/** A shared frozen empty set — the default `typeParams` of a non-generic `lowerType`
 * call (series 081), so no allocation per call and no accidental mutation. */
export const EMPTY_TYPE_PARAMS: Set<string> = new Set();
