/**
 * The plugin system (epic #95, series 110) — design: `docs/work/110-plugin-system`.
 *
 * A plugin extends the compiler along three axes (new nodes, new recognition, new
 * "emit" behavior) **without** dissolving the two properties that define this
 * compiler: **fail-loud** and **emitter totality**. It does so by the one idea in
 * the design: a plugin **recognizes** its blessed valid-TS shape (anchored to a
 * reserved import specifier, never a name heuristic) and **expands** it into
 * **core HIR** — the same HIR the built-in lowerer produces. It never emits text.
 *
 * The seam is a single opaque HIR variant `{ kind: "plugin", owner, payload }`
 * (added once, in-tree in `hir.ts`) plus the `refinePlugins` pass here, which runs
 * **first** in the refine chain (`lower/index.ts`) and replaces every plugin node
 * with the owning plugin's `expand(payload)` output before any other pass sees it.
 * The emitter's `"plugin"` case is a fail-loud guard: a surviving plugin node is a
 * compiler bug, never real plugin logic (so totality is preserved — expansion is
 * forced to land in the already-exhaustive core-HIR space).
 *
 * This module is the registry that generalizes the `@ttr/std` std-shim lane
 * (`std-shim.ts`) — the "first plugin" — into a specifier → plugin table. It owns
 * the plugin contract type, registration-time completeness validation, the
 * import-binding scan, and the expansion pass. The concrete built-in plugins are
 * registered at the bottom of this file.
 */

import type {
  CallExpression,
  Expression,
  Identifier,
  ImportDeclaration,
  Program,
} from "./ast";
import { DialectError, UnsupportedError } from "./errors";
import type { HirArg, HirExpr, HirModule, HirStmt } from "./hir";
import { STD_SHIM_EXPORTS, STD_SHIM_SPECIFIER } from "./std-shim";

/**
 * A plugin's bundled Rust crate + the Cargo dependency line the emitted code
 * needs (design §4: bilingual from v1). `manifest` is the `[dependencies]` entry
 * (e.g. `foo = { path = "…" }`) declared in the oracle's `Cargo.toml` so
 * `ensureDepsWarm` pre-warms the crate. In v1 the manifest is authored by hand in
 * `rust-oracle/Cargo.toml`; the value here is the single source that entry mirrors
 * and that `pluginCrateManifests()` reports for tooling / auditing.
 */
export interface PluginCrate {
  /** The Cargo package name (e.g. `ttr-plugin-leftpad`). */
  readonly name: string;
  /** The `[dependencies]` line the emitted code depends on. */
  readonly manifest: string;
}

/**
 * The v1 plugin contract — four declared parts (design §"contract"). A conforming
 * plugin recognizes its owned shapes and expands them to **core HIR only**;
 * faithfulness is automatic because it can only produce HIR the compiler already
 * emits correctly.
 */
export interface Plugin {
  /** (1) The reserved import specifier this plugin owns (e.g. `@acme/thing`). */
  readonly specifier: string;
  /** (2) The names this plugin exports from its specifier (the MODELED surface). */
  readonly exports: ReadonlySet<string>;
  /**
   * (3a) Map an owned call shape to an opaque payload. `lowerArg` lowers an
   * argument expression to core HIR (the plugin never reaches into the lowerer).
   * Throws (fail-loud) on a shape it recognizes-by-specifier but refuses (bad
   * arity, unsupported form) — its negative reject case gets a corpus fixture.
   */
  recognize(
    exportName: string,
    call: CallExpression,
    lowerArg: (e: Expression) => HirExpr,
  ): unknown;
  /** (3b) Expand a payload to **core HIR** (never text). */
  expand(payload: unknown): HirExpr;
  /** (4) The bundled Rust crate + its Cargo-dep manifest. */
  readonly crate: PluginCrate;
}

/** A resolved import binding: the local alias's owning plugin + exported name. */
export interface PluginBinding {
  /** The owning plugin's specifier. */
  readonly owner: string;
  /** The exported name this local alias refers to. */
  readonly export: string;
}

/** The specifier → plugin registry. Populated by `registerPlugin` at module load. */
const REGISTRY = new Map<string, Plugin>();

/**
 * Register a plugin, **failing loud at registration** on an incomplete contract
 * (design §"contract": all four parts required for v1). This is the registration-
 * time completeness guard: a half-built plugin never silently half-works.
 * `@throws {DialectError}`.
 */
export function registerPlugin(plugin: Plugin): void {
  if (!plugin.specifier) {
    throw new DialectError("a plugin must declare a non-empty owned specifier");
  }
  if (!plugin.exports || plugin.exports.size === 0) {
    throw new DialectError(
      `plugin '${plugin.specifier}' must declare at least one exported name`,
    );
  }
  if (
    typeof plugin.recognize !== "function" ||
    typeof plugin.expand !== "function"
  ) {
    throw new DialectError(
      `plugin '${plugin.specifier}' must declare both \`recognize\` and \`expand\``,
    );
  }
  if (!plugin.crate || !plugin.crate.name || !plugin.crate.manifest) {
    throw new DialectError(
      `plugin '${plugin.specifier}' must declare a Rust crate + Cargo-dep manifest (bilingual from v1)`,
    );
  }
  REGISTRY.set(plugin.specifier, plugin);
}

/** Resolve a plugin by its owned specifier, or `undefined` if unregistered. */
export function pluginForSpecifier(specifier: string): Plugin | undefined {
  return REGISTRY.get(specifier);
}

/** Every registered specifier — the set of module imports the validator accepts. */
export function registeredSpecifiers(): ReadonlySet<string> {
  return new Set(REGISTRY.keys());
}

/** Every registered plugin's Cargo-dep manifest line (for tooling / auditing). */
export function pluginCrateManifests(): string[] {
  return [...REGISTRY.values()].map((p) => p.crate.manifest);
}

/**
 * The specifiers whose *lowering* is handled off the generic `recognize`/`expand`
 * seam. `@ttr/std` is registered for **recognition** (so the registry is the one
 * authority the validator consults — design §2, task 10), but its lowering stays
 * special-cased (`std-shim.ts` / `io-shim.ts`): the fallibility fixpoint, the
 * `fsAsync`/`http` namespaces, and the `JsonValue`/`Writer`/`HttpResponse` type
 * intrinsics are not a pure expand-to-HIR-call, so it is not migrated onto the
 * generic seam. `collectPluginBindings` skips these so lowering never double-routes.
 */
const SPECIAL_LOWERED = new Set<string>([STD_SHIM_SPECIFIER]);

/**
 * Scan a program's top-level imports and bind each local alias to its owning
 * plugin + exported name — the generic analog of `collectStdShimBindings`.
 * Recognition is by the reserved specifier only. Specifiers whose lowering is
 * special-cased (`SPECIAL_LOWERED`, i.e. `@ttr/std`) are skipped here — they keep
 * their dedicated binding scan + routing. An import of a registered specifier of a
 * name the plugin does not export is left for the validator to reject.
 */
export function collectPluginBindings(
  program: Program,
): Map<string, PluginBinding> {
  const bindings = new Map<string, PluginBinding>();
  for (const stmt of program.body) {
    if (stmt.type !== "ImportDeclaration") continue;
    const decl = stmt as unknown as ImportDeclaration;
    const source = decl.source.value;
    if (typeof source !== "string") continue;
    if (SPECIAL_LOWERED.has(source)) continue;
    const plugin = REGISTRY.get(source);
    if (!plugin) continue;
    for (const spec of decl.specifiers) {
      if (spec.type !== "ImportSpecifier") continue;
      if (plugin.exports.has(spec.imported.name)) {
        bindings.set(spec.local.name, {
          owner: source,
          export: spec.imported.name,
        });
      }
    }
  }
  return bindings;
}

/**
 * Lower a recognized plugin-owned call to the single opaque `{ kind: "plugin" }`
 * node (design §3 step 1). The plugin's `recognize` builds the opaque payload
 * (lowering args via `lowerArg`); lowering does no plugin-specific work beyond
 * this routing. Called from `lowerCall` for a callee bound in `analysis.plugins`.
 */
export function recognizePluginCall(
  binding: PluginBinding,
  call: CallExpression,
  lowerArg: (e: Expression) => HirExpr,
): HirExpr {
  const plugin = REGISTRY.get(binding.owner);
  if (!plugin) {
    // A binding was collected for a specifier that is no longer registered — a
    // compiler-internal inconsistency, so fail loud rather than emit anything.
    throw new UnsupportedError({
      type: `plugin '${binding.owner}' is not registered (recognition/registration are out of sync)`,
    });
  }
  const payload = plugin.recognize(binding.export, call, lowerArg);
  return { kind: "plugin", owner: binding.owner, payload };
}

/**
 * Is `e` a direct call to a plugin-bound intrinsic (epic #95)? A plugin call is
 * typed by construction — its `expand()` produces core HIR of a concrete type that
 * Rust infers — so a `const x = leftPad(…)` binding needs no dialect annotation,
 * exactly like the `@ttr/std` by-construction exemptions. Keyed off the recorded
 * specifier-anchored binding, never a name heuristic.
 */
export function isPluginCallInit(
  e: Expression | undefined,
  plugins: Map<string, PluginBinding>,
): boolean {
  if (!e || e.type !== "CallExpression") return false;
  const callee = (e as CallExpression).callee;
  return (
    callee.type === "Identifier" && plugins.has((callee as Identifier).name)
  );
}

// ── The expansion pass (refinePlugins) ───────────────────────────────────────

/**
 * Replace every `{ kind: "plugin" }` node with **core HIR** produced by the
 * owning plugin's `expand(payload)` (design §3 step 2). Runs **first** in the
 * refine chain (innermost, wrapping `module` before `refineBitwise`), so all
 * downstream passes and the emitter see ordinary core HIR and treat plugin output
 * exactly like built-in output.
 *
 * Expansion recurses into its own result, so a nested plugin call
 * (`f(g(x))` — `g`'s node sits in `f`'s expanded call args) is fully expanded. A
 * position the walker does not descend into degrades **safely**: the plugin node
 * survives to the emitter's fail-loud `"plugin"` guard rather than mis-emitting.
 */
export function refinePlugins(module: HirModule): HirModule {
  const bodies: HirStmt[][] = [];
  for (const item of module.items) {
    if (item.kind === "fn") bodies.push(item.body);
    else if (item.kind === "class") {
      if (item.ctor) bodies.push(item.ctor.body);
      for (const m of item.methods) bodies.push(m.body);
    }
  }
  bodies.push(module.main);
  for (const body of bodies) walkStmts(body);
  return module;
}

/** Post-order rewrite of one expression: expand a plugin node (recursing into the
 * expansion so nested plugin nodes resolve), else recurse into children. */
function transform(e: HirExpr): HirExpr {
  if (e.kind === "plugin") {
    const plugin = REGISTRY.get(e.owner);
    if (!plugin) {
      throw new UnsupportedError({
        type: `plugin '${e.owner}' is not registered — cannot expand its node`,
      });
    }
    return transform(plugin.expand(e.payload));
  }
  mapChildren(e, transform);
  return e;
}

/** Apply `transform` to every direct child expression of `e`, in place. */
function mapChildren(e: HirExpr, f: (c: HirExpr) => HirExpr): void {
  switch (e.kind) {
    // Leaves + generator-internal / handle nodes with no expr children.
    case "number":
    case "string":
    case "bool":
    case "ident":
    case "path":
    case "raw":
    case "none":
    case "mapNew":
    case "setNew":
    case "bumpNew":
    case "arcClone":
    case "varPat":
      break;
    case "binary":
      e.left = f(e.left);
      e.right = f(e.right);
      break;
    case "strConcat":
      e.parts = e.parts.map(f);
      break;
    case "strAppend":
      e.target = f(e.target);
      e.parts = e.parts.map(f);
      break;
    case "strSplitIter":
      e.recv = f(e.recv);
      e.sep = f(e.sep);
      break;
    case "strSplitCount":
      e.recv = f(e.recv);
      e.sep = f(e.sep);
      break;
    case "strSplitNth":
      e.recv = f(e.recv);
      e.sep = f(e.sep);
      e.index = f(e.index);
      break;
    case "jsObjectStr":
      e.value = f(e.value);
      break;
    case "update":
      e.target = f(e.target);
      e.step = f(e.step);
      break;
    case "jsMinMax":
      e.args = e.args.map(f);
      break;
    case "unary":
      e.operand = f(e.operand);
      break;
    case "deref":
      e.expr = f(e.expr);
      break;
    case "ushr":
      e.value = f(e.value);
      e.shift = f(e.shift);
      break;
    case "cast":
      e.expr = f(e.expr);
      break;
    case "assign":
      e.target = f(e.target);
      e.value = f(e.value);
      break;
    case "cond":
      e.test = f(e.test);
      e.conseq = f(e.conseq);
      e.alt = f(e.alt);
      break;
    case "call":
      for (const a of e.args) a.expr = f(a.expr);
      break;
    case "println":
      e.args = e.args.map(f);
      break;
    case "method":
      e.receiver = f(e.receiver);
      e.args = e.args.map(f);
      break;
    case "jsOp":
      e.receiver = f(e.receiver);
      e.arg = f(e.arg);
      break;
    case "index":
      e.object = f(e.object);
      e.index = f(e.index);
      break;
    case "field":
    case "len":
      e.object = f(e.object);
      break;
    case "array":
      e.elements = e.elements.map(f);
      break;
    case "hashmap":
      for (const entry of e.entries) {
        entry.key = f(entry.key);
        entry.value = f(entry.value);
      }
      break;
    case "ref":
      e.expr = f(e.expr);
      break;
    case "collectVec":
      e.iter = f(e.iter);
      break;
    case "genStepTuple":
      e.recv = f(e.recv);
      if (e.sent) e.sent = f(e.sent);
      break;
    case "genPrefixPull":
      e.source = f(e.source);
      break;
    case "structLit":
      for (const fld of e.fields) fld.value = f(fld.value);
      break;
    case "enumVariant":
      for (const fld of e.fields) fld.value = f(fld.value);
      if (e.newtype) e.newtype = f(e.newtype);
      break;
    case "optMember":
      e.receiver = f(e.receiver);
      break;
    case "jsonStringify":
      e.value = f(e.value);
      break;
    case "parseJson":
      e.source = f(e.source);
      break;
    case "rngNew":
      e.seed = f(e.seed);
      break;
    case "fromJsonValue":
    case "toJsonValue":
      e.value = f(e.value);
      break;
    case "jsonParse":
      e.source = f(e.source);
      break;
    case "some":
    case "boxNew":
      e.value = f(e.value);
      break;
    case "optDisplay":
    case "unwrapOpt":
    case "isTruthy":
      e.value = f(e.value);
      break;
    case "truthyLogical":
      e.left = f(e.left);
      e.right = f(e.right);
      break;
    case "ok":
      if (e.value) e.value = f(e.value);
      break;
    case "try":
    case "await":
    case "joinHandleAwait":
    case "spawn":
      e.expr = f(e.expr);
      break;
    case "tryBreak":
      e.expr = f(e.expr);
      break;
    case "join":
    case "tryJoin":
    case "select":
      e.futures = e.futures.map(f);
      break;
    case "tuple":
      e.elems = e.elems.map(f);
      break;
    case "closure":
      e.body = f(e.body);
      break;
    case "joinAll":
    case "tryJoinAll":
      e.iter = f(e.iter);
      break;
    case "sleep":
      e.ms = f(e.ms);
      break;
    case "asyncMove":
      walkStmts(e.stmts);
      break;
    case "iterMap":
    case "iterFilter":
    case "iterFlatMap":
    case "iterFind":
    case "iterAny":
    case "iterAll":
    case "iterSortBy":
      e.receiver = f(e.receiver);
      e.forwarded = e.forwarded.map(f);
      break;
    case "arrayFromMap":
      e.source = f(e.source);
      e.forwarded = e.forwarded.map(f);
      break;
    case "iterReduce":
      e.receiver = f(e.receiver);
      e.forwarded = e.forwarded.map(f);
      e.init = f(e.init);
      break;
    case "iterSortDefault":
      e.receiver = f(e.receiver);
      break;
    case "objectKeys":
    case "objectValues":
    case "objectEntries":
      e.map = f(e.map);
      break;
    case "tupleField":
      e.tuple = f(e.tuple);
      break;
    case "mapBuild":
      if (e.base) e.base = f(e.base);
      for (const part of e.parts) {
        if (part.kind === "spread") part.expr = f(part.expr);
        else {
          part.key = f(part.key);
          part.value = f(part.value);
        }
      }
      break;
    case "rcNew":
      e.inner = f(e.inner);
      break;
    case "rcClone":
    case "lockAccess":
      e.expr = f(e.expr);
      break;
    case "bumpVec":
      e.elements = e.elements.map(f);
      break;
    // A `bumpString` carries a raw string only; a `plugin` node is handled in
    // `transform` before `mapChildren`. Generator-state-machine internals never
    // hold a plugin node (they are synthesized post-lowering).
    default:
      break;
  }
}

/** Apply `transform` to every expression across `stmts`, descending nested bodies. */
function walkStmts(stmts: HirStmt[]): void {
  for (const s of stmts) {
    reassignStmtExprs(s);
    for (const body of childBodies(s)) walkStmts(body);
  }
}

function reassignStmtExprs(s: HirStmt): void {
  switch (s.kind) {
    case "let":
      s.init = transform(s.init);
      break;
    case "return":
      if (s.value) s.value = transform(s.value);
      break;
    case "expr":
      s.expr = transform(s.expr);
      break;
    case "if":
    case "while":
      s.cond = transform(s.cond);
      break;
    case "ifLet":
      s.scrutinee = transform(s.scrutinee);
      break;
    case "forIn":
      s.iter = transform(s.iter);
      break;
    case "forRange":
      s.start = transform(s.start);
      s.end = transform(s.end);
      break;
    case "match":
      s.disc = transform(s.disc);
      for (const arm of s.arms) if (arm.guard) arm.guard = transform(arm.guard);
      break;
    case "throw":
      s.value = transform(s.value);
      break;
    case "breakTry":
      s.value = transform(s.value);
      break;
    case "yieldReturn":
      if (s.value) s.value = transform(s.value);
      break;
    default:
      break;
  }
}

function childBodies(s: HirStmt): HirStmt[][] {
  switch (s.kind) {
    case "if":
      return s.alt ? [s.conseq, s.alt] : [s.conseq];
    case "ifLet":
      return s.noneBody ? [s.someBody, s.noneBody] : [s.someBody];
    case "while":
    case "block":
    case "forIn":
    case "forRange":
      return [s.body];
    case "match":
      return s.arms.map((a) => a.body);
    case "tryCatch":
      return [
        s.tryBody,
        s.catchBody,
        ...(s.finallyBody ? [s.finallyBody] : []),
      ];
    case "tryBlock":
      return [
        s.tryBody,
        ...(s.catchBody ? [s.catchBody] : []),
        ...(s.finallyBody ? [s.finallyBody] : []),
      ];
    default:
      return [];
  }
}

// ── Built-in plugins ─────────────────────────────────────────────────────────

/**
 * The reference plugin (design §"reference plugin"; task 9). `@ttr/plugin-leftpad`
 * owns the specifier `@ttr/plugin-leftpad` and exports `leftPad(s, width, fill)` —
 * JS `String.prototype.padStart` fidelity — expanded to a core-HIR `call` into the
 * bundled `crates/ttr-plugin-leftpad` crate. It demonstrates the whole seam
 * end-to-end: recognize (with a fail-loud arity guard) → opaque node → expand to a
 * crate call → warmed via the oracle Cargo dep.
 */
const LEFTPAD_PLUGIN: Plugin = {
  specifier: "@ttr/plugin-leftpad",
  exports: new Set(["leftPad"]),
  recognize(exportName, call, lowerArg) {
    if (exportName !== "leftPad") {
      throw new UnsupportedError({
        type: `'${exportName}' has no lowering in "@ttr/plugin-leftpad" (exports: leftPad)`,
      });
    }
    if (call.arguments.length !== 3) {
      throw new UnsupportedError({
        type: `leftPad(s, width, fill) takes exactly 3 arguments (got ${call.arguments.length})`,
      });
    }
    // `left_pad(s: &str, width: f64, fill: &str)`: the strings by reference, the
    // width by value. Args are lowered here; `expand` just assembles the call.
    const args: HirArg[] = call.arguments.map((a, i) => ({
      borrow: i === 1 ? "owned" : "ref",
      expr: lowerArg(a as Expression),
    }));
    return { args };
  },
  expand(payload) {
    const p = payload as { args: HirArg[] };
    return {
      kind: "call",
      callee: "ttr_plugin_leftpad::left_pad",
      args: p.args,
    };
  },
  crate: {
    name: "ttr-plugin-leftpad",
    manifest:
      'ttr-plugin-leftpad = { path = "../../../crates/ttr-plugin-leftpad" }',
  },
};

/**
 * `@ttr/std` registered for **recognition** (task 10): its specifier + exports
 * resolve through this registry so the validator consults one authority, proving
 * the registry generalizes the std-shim's specifier-anchoring (design §2). Its
 * lowering is **special-cased** (see `SPECIAL_LOWERED`) — `recognize`/`expand`
 * here are never invoked (a call would be a routing bug), so they fail loud.
 */
const STD_SHIM_PLUGIN: Plugin = {
  specifier: STD_SHIM_SPECIFIER,
  exports: STD_SHIM_EXPORTS,
  recognize() {
    throw new UnsupportedError({
      type: `"${STD_SHIM_SPECIFIER}" uses special-cased lowering, not the generic plugin \`recognize\` seam`,
    });
  },
  expand() {
    throw new UnsupportedError({
      type: `"${STD_SHIM_SPECIFIER}" uses special-cased lowering, not the generic plugin \`expand\` seam`,
    });
  },
  crate: {
    name: "tslib",
    manifest: 'tslib = { path = "../../../crates/tslib" }',
  },
};

registerPlugin(LEFTPAD_PLUGIN);
registerPlugin(STD_SHIM_PLUGIN);
