/**
 * TypeOracle (series 082) — a TypeScript-checker-backed type-resolution layer
 * coupled to the oxc front end. Graduates spike #44 (see
 * `docs/work/082-type-oracle/design.md` and the spike under
 * `docs/work/044-type-layer-spike/`).
 *
 * The front end is `oxc-parser` (syntax only, no checker), so the transpiler
 * hand-rolls its type layer (`bindingTypes`, `structFields`, `collectionOf`, …).
 * That layer can only answer "what type is this expression" for shapes it keys
 * on — `collectionOf` resolves a `Map`/`Set` receiver ONLY when it is a bare
 * identifier. This oracle answers `getTypeAtLocation` for *any* expression shape
 * by building one in-memory `ts.Program` over the same source and reconciling an
 * oxc node's `[start, end]` span to the matching tsc node. oxc and tsc both
 * count in UTF-16 code units (verified in the spike, incl. surrogate pairs), so
 * spans align with no translation.
 *
 * Slice 1 is `noLib` — it resolves types from **explicit annotations** (all the
 * `collectionOf` cut-over needs), at ~1 ms per compile. Inference *through*
 * built-in method signatures (e.g. an un-annotated inferred return) needs
 * `lib.d.ts` and is a later, lazy tier.
 *
 * IMPORTANT: Bun's bare `"typescript"` specifier resolves to a v7.0.2 native
 * shim with NO compiler API. We load the real v5.9.3 JS API via `createRequire`
 * (Node resolution → the workspace package), keeping types via `import type`.
 */

import { createRequire } from "node:module";
import type * as TS from "typescript";
import type { RustType } from "./hir";

const require = createRequire(import.meta.url);
const ts: typeof TS = require("typescript");

/** The synthetic in-memory file name the oracle's Program is built over. */
const ORACLE_FILE = "__ttr_type_oracle__.ts";

export interface TypeOracle {
  /** The tsc `Type` at an oxc span, or null if no node matches the span. */
  typeAtSpan(start: number, end: number): TS.Type | null;
  /**
   * The `Map`/`Set` `RustType` for the receiver at an oxc span, or null when the
   * span is not a map/set (or its key/elem type is unmodeled). Slice-1 surface
   * `collectionOf` falls back to when `bindingTypes` can't resolve a receiver.
   */
  collectionAtSpan(start: number, end: number): RustType | null;
  /**
   * The **general** `RustType` at an oxc span (series 083) — not just the
   * Map/Set filter. Powers `receiverTypeOf`'s Tier-3 so a primitive-method
   * dispatch (`getName().toUpperCase()`, `this.count.toString()`) can classify a
   * receiver of any shape. A `number` here is a **value** position (`f64`, never
   * `orderedFloat`) — a method receiver is never a hash key. Returns null for
   * anything unmodeled (fail-loud fallback preserved).
   */
  typeAtSpan_rustType(start: number, end: number): RustType | null;
}

/**
 * Build a `TypeOracle` over `source`. `structs` is the module's set of nominal
 * struct/class/enum names, so a struct-typed Map key/elem maps to `{kind:
 * "struct"}` exactly as `lowerType`/`lowerMapKeyType` do.
 */
export function createTypeOracle(source: string, structs: Set<string>): TypeOracle {
  const sf = ts.createSourceFile(ORACLE_FILE, source, ts.ScriptTarget.Latest, true);
  const host: TS.CompilerHost = {
    getSourceFile: (f) => (f === ORACLE_FILE ? sf : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (f) => f === ORACLE_FILE,
    readFile: (f) => (f === ORACLE_FILE ? source : undefined),
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram(
    [ORACLE_FILE],
    { noLib: true, target: ts.ScriptTarget.Latest },
    host,
  );
  const checker = program.getTypeChecker();

  /** tsc node whose [getStart, getEnd] === the oxc [start, end], or null. */
  function findBySpan(node: TS.Node, start: number, end: number): TS.Node | null {
    let best: TS.Node | null = null;
    if (node.getStart(sf) === start && node.getEnd() === end) best = node;
    ts.forEachChild(node, (c) => {
      const r = findBySpan(c, start, end);
      if (r) best = r;
    });
    return best;
  }

  function typeAtSpan(start: number, end: number): TS.Type | null {
    const node = findBySpan(sf, start, end);
    return node ? checker.getTypeAtLocation(node) : null;
  }

  /** A type's nominal name — via the alias view (unresolved lib types like
   * `Map`/`Set` under noLib) or the resolved symbol (in-file structs). */
  function nameOf(t: TS.Type): string | undefined {
    return t.aliasSymbol?.name ?? t.symbol?.name;
  }

  /** The `[K, V]` / `[T]` type arguments — alias view first (noLib Map/Set),
   * then the resolved reference view (present once a lib tier lands). */
  function argsOf(t: TS.Type): readonly TS.Type[] {
    const alias = t.aliasTypeArguments;
    if (alias && alias.length) return alias;
    const ref = checker.getTypeArguments(t as TS.TypeReference);
    return ref ?? [];
  }

  /**
   * Translate a tsc `Type` to a `RustType`, mirroring `lowerType` /
   * `lowerMapKeyType` for exactly what a Map/Set key/elem/value can be in the
   * accepted dialect. `asKey` distinguishes a hashable key/elem position (a
   * `number` there is `OrderedFloat`) from a value position (`number` → `f64`).
   * Returns null for anything unmodeled, so `collectionAtSpan` yields null and
   * the caller falls back rather than emitting a wrong type.
   */
  function rustTypeOf(t: TS.Type, asKey: boolean): RustType | null {
    const f = t.flags;
    if (f & ts.TypeFlags.StringLike) return { kind: "String" };
    if (f & ts.TypeFlags.NumberLike) return asKey ? { kind: "orderedFloat" } : { kind: "f64" };
    if (f & ts.TypeFlags.BooleanLike) return { kind: "bool" };
    const name = nameOf(t);
    if (name === "Map") {
      const [k, v] = argsOf(t);
      if (!k || !v) return null;
      const key = rustTypeOf(k, true);
      const value = rustTypeOf(v, false);
      return key && value ? { kind: "hashmap", key, value } : null;
    }
    if (name === "Set") {
      const [e] = argsOf(t);
      if (!e) return null;
      const elem = rustTypeOf(e, true);
      return elem ? { kind: "set", elem } : null;
    }
    // `Array<T>` / `ReadonlyArray<T>` → `{kind:"vec", elem}` (series 083), so
    // `elementTypeOf`'s oracle tier resolves a non-identifier array receiver.
    // An array element is a value position (`number` → `f64`).
    if (name === "Array" || name === "ReadonlyArray") {
      const [e] = argsOf(t);
      if (!e) return null;
      const elem = rustTypeOf(e, false);
      return elem ? { kind: "vec", elem } : null;
    }
    if (name && structs.has(name)) return { kind: "struct", name };
    return null;
  }

  function collectionAtSpan(start: number, end: number): RustType | null {
    const t = typeAtSpan(start, end);
    if (!t) return null;
    const rt = rustTypeOf(t, false);
    return rt && (rt.kind === "hashmap" || rt.kind === "set") ? rt : null;
  }

  function typeAtSpan_rustType(start: number, end: number): RustType | null {
    const t = typeAtSpan(start, end);
    if (!t) return null;
    return rustTypeOf(t, false);
  }

  return { typeAtSpan, collectionAtSpan, typeAtSpan_rustType };
}
