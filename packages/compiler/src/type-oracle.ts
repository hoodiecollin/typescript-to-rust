/**
 * TypeOracle (series 082) — a TypeScript-checker-backed type-resolution layer
 * coupled to the oxc front end. Graduates spike #44 (see
 * series 082; the exploratory
 * `044-type-layer-spike` code has since been pruned — see git history).
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

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, posix } from "node:path";
import type * as TS from "typescript";
import { DialectError } from "./errors";
import type { RustType } from "./hir";
import { typeResolvablePluginSpecifiers } from "./plugins";

const require = createRequire(import.meta.url);
const ts: typeof TS = require("typescript");

/**
 * The directory the v5.9.3 `typescript` package's `lib.*.d.ts` files live in
 * (beside `typescript.js`). Used by the lazy lib-backed program (series 099) to
 * serve the built-in libs so inference resolves *through* built-in signatures.
 */
const TS_LIB_DIR = dirname(require.resolve("typescript"));

/**
 * The pinned lib set (series 099-A, DECIDED): the `es2022` bundle, matching the
 * built-in surface the dialect already accepts (`Object.entries`, `.at`, `.map`,
 * template machinery, `Map`/`Set`/`Promise`). `es2022` transitively references
 * the whole `es5…es2021` chain, so the inferable surface is explicit and
 * deterministic — not the tsc default.
 */
const ORACLE_LIB = "lib.es2022.d.ts";

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
  /**
   * The inferred **binding** `RustType` at an oxc span (an initializer's span),
   * resolved *through* built-in signatures via the lazy lib-backed program
   * (series 099), then re-validated to a modeled `RustType`. Returns null for
   * anything outside the accepted surface (tuple, function type, anonymous
   * object, wide non-nullish union, `bigint`/`symbol`, an unresolved node) — the
   * caller then keeps its existing fail-loud "without a type annotation" throw.
   * Throws `DialectError` for an inferred `any`/`unknown` (forbidden, never
   * silently accepted). A `number` maps to `f64` (value position) so `numeric.ts`
   * refines it identically to an annotated `: number`. First call pays the
   * one-time lib-load cost; later calls reuse the cached lib program + checker.
   */
  inferredRustType(start: number, end: number): RustType | null;
  /**
   * The inferred **return** `RustType` for the function/method/getter node at an
   * oxc span (series 099). Resolves the tsc signature at the node and takes
   * `getReturnTypeOfSignature` (robust to multi-return / implicit `undefined`),
   * unwraps an inferred `Promise<T>` to `T` (async returns), then re-validates
   * exactly like `inferredRustType`. Null ⇒ caller keeps its existing
   * "without a return type annotation" throw.
   */
  inferredReturnRustType(start: number, end: number): RustType | null;
}

/**
 * One source file participating in an oracle program. A single-file oracle has a
 * lone entry with `base: 0`; a **crate** oracle gives each module a disjoint
 * offset `base` (its window), so a merged AST node's *global* span routes back to
 * its owning file and its file-local span.
 */
export interface OracleFile {
  /** The file's module key = its tsc file name (must match import resolution). */
  key: string;
  /** The raw source text. */
  source: string;
  /** The global-span window base: a node here has span `[base + localStart, …)`. */
  base: number;
}

/**
 * Build a `TypeOracle` over a single `source`. `structs` is the module's set of
 * nominal struct/class/enum names, so a struct-typed Map key/elem maps to `{kind:
 * "struct"}` exactly as `lowerType`/`lowerMapKeyType` do.
 */
export function createTypeOracle(source: string, structs: Set<string>): TypeOracle {
  return buildOracle([{ key: ORACLE_FILE, source, base: 0 }], structs);
}

/**
 * Build a crate-wide `TypeOracle` over ALL of a crate's source files (series 050,
 * #68). tsc compiles the whole program — walking `./`-relative imports — so a
 * cross-module binding (`const p = new Point(1,2)` with an imported `Point`, or
 * `importedFn().map(…)`) infers *through* the import exactly as a same-file binding
 * does. Each file carries a disjoint offset `base`; a merged AST node's global
 * `[start,end]` routes to the owning file and its local span, so the caller-facing
 * `(start,end)` `TypeOracle` interface is unchanged.
 */
export function createCrateTypeOracle(
  files: OracleFile[],
  structs: Set<string>,
): TypeOracle {
  return buildOracle(files, structs);
}

function buildOracle(files: OracleFile[], structs: Set<string>): TypeOracle {
  /** Canonicalize a key exactly as `resolveCrate` does (posix-normalize, drop a
   *  leading `./`) so routing, module resolution, and SourceFile lookup all agree. */
  const canon = (k: string): string => {
    const n = posix.normalize(k);
    return n.startsWith("./") ? n.slice(2) : n;
  };
  const normed = files.map((f) => ({
    key: canon(f.key),
    source: f.source,
    base: f.base,
  }));
  const byKey = new Map(normed.map((f) => [f.key, f]));

  // ── series 113 (#97): resolve registered plugin specifiers ────────────────
  //
  // A pure expand-to-HIR plugin's call return type is faithfully modeled by its
  // on-disk TS oracle package (the same source the differential harness runs
  // under Bun). Resolve each such specifier to that entry so `leftPad(…)` types
  // as `string` and a binding *through* a container literal infers with no
  // container-specific logic. `@ttr/std` is excluded (`SPECIAL_LOWERED`) — see
  // `typeResolvablePluginSpecifiers`. Degrades gracefully: if a plugin's TS
  // package isn't resolvable in this context the specifier is skipped, and the
  // caller keeps its existing fail-loud "without a type annotation" throw.
  const pluginEntry = new Map<string, string>(); // specifier → canon on-disk key
  const pluginDisk = new Map<string, string>(); // canon key → absolute on-disk path
  for (const spec of typeResolvablePluginSpecifiers()) {
    try {
      const abs = require.resolve(spec);
      const key = canon(abs);
      pluginEntry.set(spec, key);
      pluginDisk.set(key, abs);
    } catch {
      // not installed / not resolvable here — leave the specifier unresolved.
    }
  }
  /** The on-disk text for a resolved plugin entry key, or undefined. */
  const pluginText = (key: string): string | undefined => {
    const abs = pluginDisk.get(key);
    return abs ? readFileSync(abs, "utf8") : undefined;
  };

  // Offset windows (sorted by base): a global span whose `start` falls in
  // `[base, base+len]` belongs to that file; its file-local span subtracts `base`.
  const windows = normed
    .map((f) => ({ key: f.key, base: f.base, hi: f.base + f.source.length }))
    .sort((a, b) => a.base - b.base);
  const route = (start: number): { key: string; base: number } | null => {
    for (const w of windows) {
      if (start >= w.base && start <= w.hi) return { key: w.key, base: w.base };
    }
    return null;
  };

  /** Resolve a `./`-relative import to a crate file key — mirrors `resolveCrate`
   *  (`./x` → `x.ts` / `x/index.ts`). A bare / lib / `@ttr/std` specifier returns
   *  undefined (left to tsc's lib resolution, or harmlessly unresolved: such
   *  bindings are separately exempt from the annotation gate). */
  const resolveModuleNames = (
    names: string[],
    containingFile: string,
  ): (TS.ResolvedModule | undefined)[] =>
    names.map((name) => {
      if (!name.startsWith(".")) {
        // A registered plugin specifier (series 113) resolves to its on-disk TS
        // oracle entry; any other bare/lib specifier stays unresolved (left to
        // tsc's lib resolution, or harmlessly unresolved — such bindings are
        // separately exempt from the annotation gate).
        const entry = pluginEntry.get(name);
        return entry ? { resolvedFileName: entry } : undefined;
      }
      const dir = posix.dirname(canon(containingFile));
      const base = canon(posix.join(dir, name));
      for (const cand of [`${base}.ts`, posix.join(base, "index.ts"), base]) {
        const hit = byKey.get(canon(cand));
        if (hit) return { resolvedFileName: hit.key };
      }
      return undefined;
    });

  /** Fresh crate SourceFiles for a program (each program owns its SourceFiles). */
  const crateSfs = (target: TS.ScriptTarget): Map<string, TS.SourceFile> => {
    const m = new Map<string, TS.SourceFile>();
    for (const f of normed) {
      m.set(f.key, ts.createSourceFile(f.key, f.source, target, true));
    }
    return m;
  };

  /** A resolved plugin entry as a `SourceFile`, read from disk and cached per
   *  program (each program owns its SourceFiles), or undefined if `f` is not a
   *  resolved plugin entry (series 113). */
  const pluginSf = (
    f: string,
    target: TS.ScriptTarget | TS.CreateSourceFileOptions,
    cache: Map<string, TS.SourceFile>,
  ): TS.SourceFile | undefined => {
    const key = canon(f);
    if (!pluginDisk.has(key)) return undefined;
    const cached = cache.get(key);
    if (cached) return cached;
    const text = pluginText(key);
    if (text === undefined) return undefined;
    const sf = ts.createSourceFile(key, text, target, true);
    cache.set(key, sf);
    return sf;
  };

  // ── noLib tier (fast, explicit annotations) ───────────────────────────────
  const sfs = crateSfs(ts.ScriptTarget.Latest);
  const noLibPluginCache = new Map<string, TS.SourceFile>();
  const host: TS.CompilerHost = {
    getSourceFile: (f) =>
      sfs.get(canon(f)) ?? pluginSf(f, ts.ScriptTarget.Latest, noLibPluginCache),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (f) => sfs.has(canon(f)) || pluginDisk.has(canon(f)),
    readFile: (f) => byKey.get(canon(f))?.source ?? pluginText(canon(f)),
    getCanonicalFileName: (f) => canon(f),
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    resolveModuleNames,
  };
  const program = ts.createProgram(
    normed.map((f) => f.key),
    { noLib: true, target: ts.ScriptTarget.Latest },
    host,
  );
  const checker = program.getTypeChecker();

  /** tsc node whose [getStart, getEnd] === the (file-local) [start, end], or null. */
  function findBySpan(
    node: TS.Node,
    sf: TS.SourceFile,
    start: number,
    end: number,
  ): TS.Node | null {
    let best: TS.Node | null = null;
    if (node.getStart(sf) === start && node.getEnd() === end) best = node;
    ts.forEachChild(node, (c) => {
      const r = findBySpan(c, sf, start, end);
      if (r) best = r;
    });
    return best;
  }

  /** Route a global span to the owning file's SourceFile in `prog` + its node. */
  function nodeAt(
    prog: TS.Program,
    gstart: number,
    gend: number,
  ): TS.Node | null {
    const w = route(gstart);
    if (!w) return null;
    const sf = prog.getSourceFile(w.key);
    if (!sf) return null;
    return findBySpan(sf, sf, gstart - w.base, gend - w.base);
  }

  function typeAtSpan(start: number, end: number): TS.Type | null {
    const node = nodeAt(program, start, end);
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
    if (alias?.length) return alias;
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

  // ── series 099: lazy lib-backed inference tier ────────────────────────────
  //
  // The `noLib` program above resolves explicit annotations at ~1 ms. Inferring
  // *through* built-in method signatures (`.map`, template machinery, `.find` →
  // `T | undefined`) needs `lib.d.ts` loaded, which is the expensive part. So a
  // SECOND, lib-enabled program is built lazily on the first inference query and
  // memoized — a fully-annotated module never triggers it (zero perf change).

  /** Memoized lib-backed `{ prog, checker }`, built on first inference query. */
  let libTier: { prog: TS.Program; checker: TS.TypeChecker } | null = null;

  /** Resolve a requested lib file name to its on-disk path in `TS_LIB_DIR`. */
  function libPath(f: string): string | undefined {
    const cand = join(TS_LIB_DIR, basename(f));
    return existsSync(cand) ? cand : undefined;
  }

  function libProgram(): { prog: TS.Program; checker: TS.TypeChecker } {
    if (libTier) return libTier;
    // The lib-enabled program is multi-file too (each crate SourceFile + the libs),
    // so cross-module inference resolves *through* imports (#68).
    const libSfs = crateSfs(ts.ScriptTarget.Latest);
    const cache = new Map<string, TS.SourceFile>();
    const libHost: TS.CompilerHost = {
      getSourceFile: (f, langVersion) => {
        const crate = libSfs.get(canon(f));
        if (crate) return crate;
        const plugin = pluginSf(f, langVersion, cache);
        if (plugin) return plugin;
        const cached = cache.get(f);
        if (cached) return cached;
        const full = libPath(f);
        if (!full) return undefined;
        const text = readFileSync(full, "utf8");
        const sfLib = ts.createSourceFile(f, text, langVersion, true);
        cache.set(f, sfLib);
        return sfLib;
      },
      getDefaultLibFileName: () => ORACLE_LIB,
      writeFile: () => {},
      getCurrentDirectory: () => "",
      getDirectories: () => [],
      fileExists: (f) =>
        libSfs.has(canon(f)) || pluginDisk.has(canon(f)) || libPath(f) !== undefined,
      readFile: (f) =>
        byKey.get(canon(f))?.source ??
        pluginText(canon(f)) ??
        (libPath(f) ? readFileSync(libPath(f)!, "utf8") : undefined),
      getCanonicalFileName: (f) => canon(f),
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
      resolveModuleNames,
    };
    const libProg = ts.createProgram(
      normed.map((f) => f.key),
      // `strict` (→ `strictNullChecks`) is REQUIRED: without it `undefined` is
      // absorbed into every type, so a `.find(…)` → `T | undefined` collapses to
      // `T` and the nullish-union → `option` mapping never fires (INF5/INF8).
      {
        noLib: false,
        lib: [ORACLE_LIB],
        target: ts.ScriptTarget.ES2022,
        types: [],
        strict: true,
      },
      libHost,
    );
    libTier = { prog: libProg, checker: libProg.getTypeChecker() };
    return libTier;
  }

  /**
   * The re-validation gate (series 099 §2): map an inferred value-position `Type`
   * to a modeled `RustType`, or null (⇒ caller fails loud). Throws `DialectError`
   * on an inferred `any`/`unknown` (forbidden — never silently accepted). A
   * nullish union `T | undefined`/`T | null` maps to `option<inner>`; a wide
   * non-nullish union stays null (093 unions are name-driven — inferring an
   * anonymous enum from a join is exactly the guess fail-loud forbids).
   */
  function inferValueType(t: TS.Type, chk: TS.TypeChecker): RustType | null {
    if (t.flags & ts.TypeFlags.Any) throw new DialectError("`any` type");
    if (t.flags & ts.TypeFlags.Unknown) throw new DialectError("`unknown` type");
    if (t.isUnion()) {
      const nullish = ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void;
      const hasNullish = t.types.some((m) => m.flags & nullish);
      if (hasNullish) {
        const nn = chk.getNonNullableType(t);
        // Accept only when stripping the nullish members collapses to a single
        // modeled type — else it is a wide union wrapped in `| undefined`.
        if (!nn.isUnion()) {
          const inner = inferValueType(nn, chk);
          return inner ? { kind: "option", inner } : null;
        }
      }
      return null;
    }
    return rustTypeOf(t, false);
  }

  function inferredRustType(start: number, end: number): RustType | null {
    const { prog, checker: chk } = libProgram();
    const node = nodeAt(prog, start, end);
    if (!node) return null;
    return inferValueType(chk.getTypeAtLocation(node), chk);
  }

  function inferredReturnRustType(start: number, end: number): RustType | null {
    const { prog, checker: chk } = libProgram();
    const node = nodeAt(prog, start, end);
    if (!node) return null;
    const sig = chk.getSignatureFromDeclaration(node as TS.SignatureDeclaration);
    if (!sig) return null;
    let ret = chk.getReturnTypeOfSignature(sig);
    // async → `Promise<T>`: unwrap to `T` (the emitter wraps the async return).
    if ((ret.aliasSymbol?.name ?? ret.symbol?.name) === "Promise") {
      const inner = argsOf(ret)[0];
      if (!inner) return null;
      ret = inner;
    }
    return inferValueType(ret, chk);
  }

  return {
    typeAtSpan,
    collectionAtSpan,
    typeAtSpan_rustType,
    inferredRustType,
    inferredReturnRustType,
  };
}
