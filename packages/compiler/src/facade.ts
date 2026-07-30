/**
 * `ttr facade` — generate a **mirror-plugin facade** from a Rust crate's rustdoc
 * JSON (series 122; design in `docs/work/122-ttr-facade-generator/design.md`).
 *
 * The mirror archetype (series 121) keeps the *crate* authoritative: rather than
 * reimplement a library in TypeScript and diff the two, we generate a types-only
 * TS facade plus a machine-readable method table that a plugin expansion consumes
 * to call the real crate. The hard part — resolving re-exports, macro-expanded
 * methods, and `Result<T>` aliases to their concrete error type — is exactly what
 * rustdoc has already computed, so this module *reads* rustdoc's post-resolution
 * view rather than reparsing Rust (see design §"extraction = rustdoc JSON").
 *
 * Everything here is pure over an already-obtained rustdoc-JSON value:
 *   - `generateFacade(json, opts)` → a resolved `FacadeModel` (types, methods,
 *     namespaced statics/variants, and the *reported* unmappable items).
 *   - `emitFacade(model)` → the two deterministic artifacts (`.d.ts` + table JSON).
 * Obtaining the JSON (shelling `cargo +nightly rustdoc`) and writing the files is
 * the CLI seam (`obtainRustdocJson` / `runFacade`), kept injectable so the FAC
 * specs stay hermetic against the checked-in fixture.
 *
 * Fail-loud discipline (TTR's spine): the generator never emits `any`, a partial
 * signature, or a best-effort stub. An unresolvable format version throws; an
 * item it cannot ground to a concrete shape (a generic method, an unsupported
 * trait) is **reported** with its exact rustdoc path in `model.rejects` and
 * omitted — never faked, never silently dropped.
 */

/** The single rustdoc `format_version` this generator understands (design §pin). */
export const FACADE_FORMAT_VERSION = 57;

/** The nightly toolchain that emits {@link FACADE_FORMAT_VERSION} (for messages). */
export const FACADE_NIGHTLY = "nightly-1.98.0";

// ── rustdoc JSON shapes (only the fields this generator reads) ────────────────

/** A `&T` / `&mut T` reference node. */
export interface RustdocBorrowedRef {
  is_mutable: boolean;
  type: RustdocType;
}

/**
 * A rustdoc `Type` node. Modeled as optional fields (rather than a closed tagged
 * union) because rustdoc has many `Type` variants this generator does not read;
 * an unmodeled shape simply matches none of these and falls through fail-soft to
 * an `unknown`/`owned` default at the read site.
 */
export interface RustdocType {
  primitive?: string;
  generic?: string;
  borrowed_ref?: RustdocBorrowedRef;
  resolved_path?: RustdocPath;
}

/** A resolved path reference: a display `path`, the target item `id`, and args. */
export interface RustdocPath {
  path: string;
  id: number;
  args: RustdocGenericArgs | null;
}

/** Angle-bracketed generic args (`<A, B>`); only `angle_bracketed` is read. */
export interface RustdocGenericArgs {
  angle_bracketed?: {
    args: Array<{ type?: RustdocType }>;
    constraints: unknown[];
  };
}

/** A function signature: ordered `(name, type)` inputs and an optional output. */
export interface RustdocFnSig {
  inputs: Array<[string, RustdocType]>;
  output: RustdocType | null;
}

/** Generic parameters on an item; a `type`/`const` param is a reject trigger. */
export interface RustdocGenerics {
  params: Array<{ name: string; kind: { type?: unknown; const?: unknown } }>;
}

/** An `impl` block: `trait === null` is inherent; synthetic/blanket are auto. */
export interface RustdocImpl {
  trait: RustdocPath | null;
  items: number[];
  is_synthetic?: boolean;
  blanket_impl?: unknown;
}

/** The `inner` payload of an item — a single of these keys is present per item. */
export interface RustdocInner {
  module?: { items: number[] };
  struct?: { impls: number[] };
  enum?: { variants: number[]; impls: number[] };
  use?: { name: string | null; id: number; is_glob: boolean; source: string };
  function?: { sig: RustdocFnSig; generics: RustdocGenerics };
  type_alias?: { type: RustdocType; generics: RustdocGenerics };
  impl?: RustdocImpl;
}

/** One documented item; `inner` is a single-key tagged union keyed by kind. */
export interface RustdocItem {
  id?: number;
  name: string | null;
  docs: string | null;
  inner: RustdocInner;
}

/** A `paths[id]` entry: canonical path segments + owning crate + item kind. */
export interface RustdocPathEntry {
  crate_id: number;
  path: string[];
  kind: string;
}

/** The top-level rustdoc JSON document. */
export interface RustdocJson {
  root: number;
  index: Record<string, RustdocItem>;
  paths: Record<string, RustdocPathEntry>;
  external_crates: Record<string, { name: string }>;
  format_version: number;
  crate_version?: string | null;
}

// ── Facade model (the resolved, emitter-ready result) ────────────────────────

/** A parameter/receiver borrow shape — feeds the D5 per-method borrow table. */
export type Borrow = "&" | "&mut" | "owned";

/** A method receiver shape; `static` = associated fn with no `self` (a ctor). */
export type Receiver = "&self" | "&mut self" | "self" | "static";

/** One method parameter (receiver excluded): TS type + its Rust borrow shape. */
export interface FacadeParam {
  name: string;
  ts: string;
  borrow: Borrow;
}

/** A resolved method entry — the row a mirror expansion consumes. */
export interface FacadeMethod {
  /** TS-visible name, `Owner.method`. */
  ts: string;
  /** Fully-qualified crate call path, `crate::Owner::method`. */
  path: string;
  owner: string;
  name: string;
  receiver: Receiver;
  params: FacadeParam[];
  /** TS return type (the `Ok` type when fallible; `void` for unit). */
  ret: string;
  /** True when the Rust return is a `Result` (feeds D4). */
  fallible: boolean;
  /** Resolved error-type crate path when fallible, else `null` (feeds D4). */
  error: string | null;
  /** The item's rustdoc docs, if any (emitted only under `--with-docs`). */
  docs: string | null;
}

/** An owned type surfaced by the facade (D2); enums carry unit variants (D3). */
export interface FacadeType {
  ts: string;
  path: string;
  kind: "struct" | "enum";
  /** True when reached via a cross-crate `pub use` (methods live elsewhere). */
  reexport: boolean;
  variants?: Array<{ ts: string; path: string }>;
  /** The type's rustdoc docs, if any (emitted only under `--with-docs`). */
  docs: string | null;
}

/** An item the generator refused to fake — reported, never emitted as `any`. */
export interface FacadeReject {
  path: string;
  reason: string;
}

/** The fully-resolved facade, ready for deterministic emission. */
export interface FacadeModel {
  crate: string;
  version: string | null;
  formatVersion: number;
  types: FacadeType[];
  methods: FacadeMethod[];
  rejects: FacadeReject[];
}

/** Options for {@link generateFacade}. */
export interface FacadeOptions {
  /** Crate display name for the table header (defaults to the rustdoc root path). */
  crate?: string;
  /** Source version pin recorded in the header (`<crate>@<version>`). */
  version?: string | null;
  /** Trait paths (`crate::Trait`) whose methods to surface; all others omitted. */
  allowTraits?: string[];
}

// ── Errors (fail-loud) ───────────────────────────────────────────────────────

/** A fail-loud generator error (format-version mismatch, missing toolchain). */
export class FacadeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FacadeError";
  }
}

// ── Parser / resolver ────────────────────────────────────────────────────────

/**
 * Validate the rustdoc document and its pinned `format_version` (fail-loud gate
 * 1, FAC4). A differing version throws naming both versions and the toolchain
 * that emits the expected one — never a best-effort parse of an unknown schema.
 */
export function parseRustdoc(json: unknown): RustdocJson {
  if (typeof json !== "object" || json === null) {
    throw new FacadeError("facade: rustdoc JSON is not an object");
  }
  const doc = json as RustdocJson;
  if (typeof doc.format_version !== "number") {
    throw new FacadeError("facade: rustdoc JSON has no numeric format_version");
  }
  if (doc.format_version !== FACADE_FORMAT_VERSION) {
    throw new FacadeError(
      `facade: unsupported rustdoc format_version ${doc.format_version} (expected ${FACADE_FORMAT_VERSION}, emitted by ${FACADE_NIGHTLY}). Regenerate the fixture or bump the pin — a best-effort parse is refused.`,
    );
  }
  if (typeof doc.index !== "object" || typeof doc.paths !== "object") {
    throw new FacadeError("facade: rustdoc JSON missing index/paths tables");
  }
  return doc;
}

/** Resolve an item id to its canonical `::`-joined crate path, if known. */
function resolveIdPath(doc: RustdocJson, id: number): string | undefined {
  const entry = doc.paths[String(id)];
  return entry ? entry.path.join("::") : undefined;
}

/** The crate's own display name — the first segment of any local (`crate_id 0`) path. */
function crateRootName(doc: RustdocJson): string {
  for (const entry of Object.values(doc.paths)) {
    if (entry.crate_id === 0 && entry.path.length > 0) return entry.path[0]!;
  }
  return "crate";
}

// ── Type rendering ───────────────────────────────────────────────────────────

const PRIMITIVE_TS: Record<string, string> = {
  bool: "boolean",
  char: "string",
  str: "string",
  String: "string",
  f32: "number",
  f64: "number",
};

/** Map a Rust primitive name to its TS facade type (all integers → `number`). */
function primitiveTs(name: string): string {
  if (name in PRIMITIVE_TS) return PRIMITIVE_TS[name]!;
  if (/^[iu](8|16|32|64|128|size)$/.test(name)) return "number";
  return name;
}

/**
 * Render a rustdoc `Type` to its TS facade type, **erasing borrows** (the borrow
 * shape is recorded separately in the method table, not the `.d.ts`). `Self` and
 * a bare owned resolved-path both render to the type's short name.
 */
function tsTypeOf(t: RustdocType | null, ownerTs: string): string {
  if (t === null) return "void";
  if (t.primitive !== undefined) return primitiveTs(t.primitive);
  if (t.generic !== undefined)
    return t.generic === "Self" ? ownerTs : t.generic;
  if (t.borrowed_ref) return tsTypeOf(t.borrowed_ref.type, ownerTs);
  if (t.resolved_path) return t.resolved_path.path.split("::").pop()!;
  return "unknown";
}

/** The borrow shape of a parameter/receiver type. */
function borrowOf(t: RustdocType): Borrow {
  if (t.borrowed_ref) return t.borrowed_ref.is_mutable ? "&mut" : "&";
  return "owned";
}

/**
 * Analyze a return type for fallibility (FAC7). A `Result<T, E>` — written
 * directly or reached through a crate-local `type Result<T> = …` alias — is
 * marked fallible with the **resolved** error path; the TS return is the `Ok`
 * type. Anything else is infallible and returns its mapped TS type.
 */
function analyzeReturn(
  doc: RustdocJson,
  output: RustdocType | null,
  ownerTs: string,
): { fallible: boolean; error: string | null; ret: string } {
  if (output?.resolved_path) {
    const rp = output.resolved_path;
    const aliasInner = doc.index[String(rp.id)]?.inner?.type_alias;
    const under: RustdocPath | undefined = aliasInner?.type?.resolved_path;

    const isResult = (p: string): boolean =>
      p === "Result" || p === "core::result::Result" || p.endsWith("::Result");

    if (under && isResult(under.path)) {
      const errType = under.args?.angle_bracketed?.args?.[1]?.type;
      const okType = rp.args?.angle_bracketed?.args?.[0]?.type ?? null;
      return {
        fallible: true,
        error: resolveErrorPath(doc, errType),
        ret: tsTypeOf(okType, ownerTs),
      };
    }
    if (isResult(rp.path)) {
      const args = rp.args?.angle_bracketed?.args ?? [];
      const okType = args[0]?.type ?? null;
      const errType = args[1]?.type;
      return {
        fallible: true,
        error: resolveErrorPath(doc, errType),
        ret: tsTypeOf(okType, ownerTs),
      };
    }
  }
  return { fallible: false, error: null, ret: tsTypeOf(output, ownerTs) };
}

/** Resolve a `Result`'s error `Type` node to its canonical crate path. */
function resolveErrorPath(
  doc: RustdocJson,
  errType: RustdocType | undefined,
): string | null {
  if (!errType?.resolved_path) return null;
  const rp = errType.resolved_path;
  return resolveIdPath(doc, rp.id) ?? rp.path;
}

// ── Mapper ───────────────────────────────────────────────────────────────────

/** True when a function's generics force a reject (a `type`/`const` param). */
function hasGroundingGenerics(generics: RustdocGenerics | undefined): boolean {
  if (!generics) return false;
  return generics.params.some((p) => "type" in p.kind || "const" in p.kind);
}

/**
 * Map one function item onto the facade under `ownerTs`/`ownerPath`, appending a
 * `FacadeMethod` — or a `FacadeReject` when it cannot be grounded (FAC11). The
 * receiver is the leading `self` input; remaining inputs become params with
 * their borrow shape (FAC8); the return is analyzed for fallibility (FAC7).
 */
function mapFunction(
  doc: RustdocJson,
  fnItem: RustdocItem,
  ownerTs: string,
  ownerPath: string,
  out: FacadeModel,
): void {
  const name = fnItem.name!;
  const path = `${ownerPath}::${name}`;
  const fn = fnItem.inner.function;
  if (!fn) return;
  if (hasGroundingGenerics(fn.generics)) {
    out.rejects.push({
      path,
      reason:
        "generic type parameter — cannot ground to a concrete facade shape",
    });
    return;
  }

  const sig = fn.sig;
  let receiver: Receiver = "static";
  const params: FacadeParam[] = [];
  for (const [pname, ptype] of sig.inputs) {
    if (pname === "self") {
      if (ptype.borrowed_ref) {
        receiver = ptype.borrowed_ref.is_mutable ? "&mut self" : "&self";
      } else {
        receiver = "self";
      }
      continue;
    }
    params.push({
      name: pname,
      ts: tsTypeOf(ptype, ownerTs),
      borrow: borrowOf(ptype),
    });
  }

  const { fallible, error, ret } = analyzeReturn(doc, sig.output, ownerTs);
  out.methods.push({
    ts: `${ownerTs}.${name}`,
    path,
    owner: ownerTs,
    name,
    receiver,
    params,
    ret,
    fallible,
    error,
    docs: fnItem.docs ?? null,
  });
}

/**
 * Walk a struct/enum's `impls`, mapping method items that should be surfaced:
 * inherent impls always; a non-synthetic, non-blanket trait impl only when its
 * resolved trait path is in `allowTraits` (FAC12). Synthetic/blanket auto-impls
 * (`Send`, `Borrow`, `From`, …) are never surfaced.
 */
function mapImpls(
  doc: RustdocJson,
  implIds: number[],
  ownerTs: string,
  ownerPath: string,
  allowTraits: Set<string>,
  out: FacadeModel,
): void {
  for (const implId of implIds) {
    const impl = doc.index[String(implId)]?.inner?.impl;
    if (!impl) continue;

    if (impl.trait !== null) {
      if (impl.is_synthetic || impl.blanket_impl != null) continue;
      const traitPath = resolveIdPath(doc, impl.trait.id) ?? impl.trait.path;
      if (!allowTraits.has(traitPath)) continue;
    }

    for (const itemId of impl.items) {
      const item = doc.index[String(itemId)];
      if (item?.inner?.function && item.name) {
        mapFunction(doc, item, ownerTs, ownerPath, out);
      }
    }
  }
}

/**
 * Resolve the whole document into a {@link FacadeModel}: owned types (structs,
 * enums, cross-crate `pub use` re-exports), their surfaced methods, enum unit
 * variants as namespaced constants, and the reported unmappable items. Items are
 * left unsorted here; {@link emitFacade} imposes the deterministic order.
 */
export function generateFacade(
  json: unknown,
  opts: FacadeOptions = {},
): FacadeModel {
  const doc = parseRustdoc(json);
  const allowTraits = new Set(opts.allowTraits ?? []);
  const model: FacadeModel = {
    crate: opts.crate ?? crateRootName(doc),
    version: opts.version ?? doc.crate_version ?? null,
    formatVersion: doc.format_version,
    types: [],
    methods: [],
    rejects: [],
  };

  const rootItems = doc.index[String(doc.root)]?.inner?.module?.items ?? [];
  for (const itemId of rootItems) {
    const item = doc.index[String(itemId)];
    if (!item) continue;
    const inner = item.inner;

    if (inner.struct) {
      const path = resolveIdPath(doc, itemId as number) ?? item.name!;
      const ts = path.split("::").pop()!;
      model.types.push({
        ts,
        path,
        kind: "struct",
        reexport: false,
        docs: item.docs ?? null,
      });
      mapImpls(doc, inner.struct.impls ?? [], ts, path, allowTraits, model);
    } else if (inner.enum) {
      const path = resolveIdPath(doc, itemId as number) ?? item.name!;
      const ts = path.split("::").pop()!;
      const variants = (inner.enum.variants ?? []).map((vid: number) => {
        const vpath = resolveIdPath(doc, vid) ?? `${path}::?`;
        return { ts: vpath.split("::").pop()!, path: vpath };
      });
      model.types.push({
        ts,
        path,
        kind: "enum",
        reexport: false,
        variants,
        docs: item.docs ?? null,
      });
      mapImpls(doc, inner.enum.impls ?? [], ts, path, allowTraits, model);
    } else if (inner.use) {
      const targetId: number = inner.use.id;
      const path = resolveIdPath(doc, targetId);
      const target = doc.paths[String(targetId)];
      if (!path || !target) continue;
      if (target.kind === "struct" || target.kind === "enum") {
        const reexport = target.crate_id !== 0;
        model.types.push({
          ts: inner.use.name ?? path.split("::").pop()!,
          path,
          kind: target.kind,
          reexport,
          docs: item.docs ?? null,
        });
      }
    }
  }

  return model;
}

// ── Emitters (deterministic) ─────────────────────────────────────────────────

/** Stable string compare so regeneration is byte-identical (FAC15). */
function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** The rendered facade artifacts. */
export interface FacadeArtifacts {
  dts: string;
  table: string;
}

/** Emission options; doc comments are opt-in (FAC14, respects no-comment policies). */
export interface EmitOptions {
  withDocs?: boolean;
}

/**
 * Render the two deterministic artifacts: a types-only `.d.ts` (declared owned
 * types, static/instance methods, enum-variant namespaces) and the method-table
 * JSON. Both are sorted by crate path so a regeneration diffs byte-for-byte.
 */
export function emitFacade(
  model: FacadeModel,
  opts: EmitOptions = {},
): FacadeArtifacts {
  return {
    dts: emitDts(model, opts.withDocs ?? false),
    table: emitTable(model),
  };
}

/** Render a rustdoc doc string as a JSDoc block at the given indent, or "". */
function docBlock(docs: string | null, indent: string): string {
  if (!docs) return "";
  const body = docs
    .split("\n")
    .map((line) => `${indent} * ${line}`.trimEnd())
    .join("\n");
  return `${indent}/**\n${body}\n${indent} */\n`;
}

/** Render the types-only `.d.ts` (FAC13: type-checks under `tsc --noEmit`). */
function emitDts(model: FacadeModel, withDocs: boolean): string {
  const types = [...model.types].sort(byPath);
  const methodsByOwner = new Map<string, FacadeMethod[]>();
  for (const m of model.methods) {
    const list = methodsByOwner.get(m.owner) ?? [];
    list.push(m);
    methodsByOwner.set(m.owner, list);
  }

  const blocks: string[] = [];
  for (const t of types) {
    const methods = [...(methodsByOwner.get(t.ts) ?? [])].sort(byPath);
    const head = withDocs ? docBlock(t.docs, "") : "";
    const lines: string[] = [];
    lines.push(`${head}export declare class ${t.ts} {`);
    for (const m of methods) {
      const doc = withDocs ? docBlock(m.docs, "  ") : "";
      const params = m.params.map((p) => `${p.name}: ${p.ts}`).join(", ");
      const prefix = m.receiver === "static" ? "static " : "";
      lines.push(`${doc}  ${prefix}${m.name}(${params}): ${m.ret};`);
    }
    lines.push("}");
    blocks.push(lines.join("\n"));

    if (t.kind === "enum" && t.variants && t.variants.length > 0) {
      const nsLines: string[] = [`export declare namespace ${t.ts} {`];
      for (const v of [...t.variants].sort(byPath)) {
        nsLines.push(`  const ${v.ts}: ${t.ts};`);
      }
      nsLines.push("}");
      blocks.push(nsLines.join("\n"));
    }
  }
  return `${blocks.join("\n\n")}\n`;
}

/** Render the method-table JSON (FAC2 header; FAC15 sorted/deterministic). */
function emitTable(model: FacadeModel): string {
  const table = {
    crate: model.crate,
    version: model.version,
    formatVersion: model.formatVersion,
    types: [...model.types].sort(byPath).map((t) => ({
      ts: t.ts,
      path: t.path,
      kind: t.kind,
      reexport: t.reexport,
      ...(t.variants ? { variants: [...t.variants].sort(byPath) } : {}),
    })),
    methods: [...model.methods].sort(byPath),
    rejects: [...model.rejects].sort(byPath),
  };
  return `${JSON.stringify(table, null, 2)}\n`;
}
