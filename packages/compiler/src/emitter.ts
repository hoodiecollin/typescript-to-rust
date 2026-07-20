/**
 * HIR → idiomatic Rust. Memory model: Option A (plain `T` / `&T` / `&mut T`).
 *
 * This stage is deliberately *pure and total*: every ownership, mutability,
 * type, and dialect decision has already been made in `lower.ts` and baked into
 * the HIR, so there is nothing to analyze and nothing to reject here — each HIR
 * node maps to a Rust string. `emit(program)` is the convenience entry that
 * lowers then emits; `UnsupportedError` is re-exported from lowering so the
 * public surface is unchanged.
 *
 * Output is always a complete, compilable module: top-level declarations become
 * items and top-level statements become a generated `fn main()` (that split, and
 * the fail-loud rejection, happen in lowering — see hir.ts).
 */

import type { Program } from "./ast";
import {
  type StructTable,
  buildStructTable,
  structDeriveClause,
  structDerivesPartialEq,
} from "./derives";
import type {
  ElemMode,
  GenericParam,
  HirArg,
  HirCatchArm,
  HirClass,
  HirEnum,
  HirErrorEnum,
  HirUnionEnum,
  HirExpr,
  HirFn,
  HirGenerator,
  HirItem,
  HirLazyStatic,
  HirMatchArm,
  HirModule,
  HirStmt,
  HirMod,
  HirStruct,
  HirStructKey,
  HirTrait,
  RustType,
  Vis,
} from "./hir";
import { DialectError, UnsupportedError, lower } from "./lower";

export { UnsupportedError, DialectError };

const INDENT = "    ";

function indent(block: string): string {
  return block
    .split("\n")
    .map((line) => (line.length > 0 ? INDENT + line : line))
    .join("\n");
}

// ── Identifier hygiene (series 031, gap C) ────────────────────────────────────

/** Rust keywords (strict + reserved) that collide with a bare identifier. */
const RUST_KEYWORDS: ReadonlySet<string> = new Set([
  "as",
  "async",
  "await",
  "break",
  "const",
  "continue",
  "crate",
  "dyn",
  "else",
  "enum",
  "extern",
  "false",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "match",
  "mod",
  "move",
  "mut",
  "pub",
  "ref",
  "return",
  "self",
  "Self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "type",
  "unsafe",
  "use",
  "where",
  "while",
  "abstract",
  "become",
  "box",
  "do",
  "final",
  "gen",
  "macro",
  "override",
  "priv",
  "try",
  "typeof",
  "unsized",
  "virtual",
  "yield",
  "union",
]);

/**
 * Keywords that cannot be written as raw identifiers (`r#…`). `self` is exempt:
 * lowering emits it for `this`, so it passes through — a *user* binding named
 * `self` is a rare, cargo-caught residual, not worth failing every method on.
 */
const NON_RAW: ReadonlySet<string> = new Set(["crate", "super", "Self"]);

/**
 * Render a user identifier, escaping a Rust-keyword collision as a raw identifier
 * (`box` → `r#box`). The handful that can't be raw fail loud.
 * @throws {UnsupportedError} on `crate`/`super`/`Self`.
 */
function rid(name: string): string {
  if (name === "self") return name;
  if (!RUST_KEYWORDS.has(name)) return name;
  if (NON_RAW.has(name)) {
    throw new UnsupportedError({
      type: `identifier \`${name}\` collides with a Rust keyword that cannot be a raw identifier`,
    });
  }
  return `r#${name}`;
}

/** Render a possibly path-qualified callee (`f`, `Class::new`), escaping each segment. */
function ridPath(callee: string): string {
  return callee.split("::").map(rid).join("::");
}

/**
 * Emit a complete Rust module for `program`.
 * @throws {UnsupportedError} on any construct outside the implemented dialect.
 */
export function emit(program: Program, source?: string): string {
  return emitModule(lower(program, source));
}

/**
 * The std-import `use` lines a single emitted file needs, deep-scanned from just
 * *its own* items (+ `main` for the crate root). The emitter is the sole producer
 * of each node, so every scan is exact. Split out of `emitModule` (series 050) so
 * each module file computes its own prelude — items in a separate file don't see
 * the crate root's `use`s. `Rc`/`RefCell` travel together (`"use rc"`).
 */
function stdImports(items: HirItem[], main: HirStmt[]): string[] {
  const scan = { items, main };
  const imports: string[] = [];
  // `Record`/object types are backed by `IndexMap` (series 041) so key/value
  // iteration matches JS's insertion order (`HashMap` does not preserve it).
  if (
    usesKind(scan, "hashmap") ||
    usesKind(scan, "mapBuild") ||
    usesKind(scan, "mapNew")
  )
    imports.push("use indexmap::IndexMap;");
  // `Set<T>` → `IndexSet` (series 061), same insertion-order fidelity as `IndexMap`.
  if (usesKind(scan, "set") || usesKind(scan, "setNew"))
    imports.push("use indexmap::IndexSet;");
  // Scalar-`f64` map keys / set elements wrap in `OrderedFloat` (series 061); a
  // synthesized f64-bearing struct-key newtype (series 074) wraps its `f64` leaves
  // in `OrderedFloat` at hash/eq time, so it needs the import too.
  if (
    usesKind(scan, "orderedFloat") ||
    usesKind(scan, "structKey") ||
    items.some((i) => i.kind === "structKey")
  )
    imports.push("use ordered_float::OrderedFloat;");
  if (
    usesKind(scan, "rc") ||
    usesKind(scan, "rcNew") ||
    usesKind(scan, "rcClone")
  ) {
    imports.push("use std::rc::Rc;", "use std::cell::RefCell;");
  }
  // A state-machine generator (series 075) drives its arms via `GenStep<Y, R>`
  // (tslib); import it so the `impl Steppable` / `step()` arms name it unqualified.
  if (items.some((i) => i.kind === "generator"))
    imports.push("use tslib::gen::GenStep;");
  // A module-level value default (#70) → a `LazyLock` static; a non-scalar payload
  // is `Rc`-wrapped. Import each unqualified (deduped against the `rc` branch above).
  if (items.some((i) => i.kind === "lazyStatic"))
    imports.push("use std::sync::LazyLock;");
  if (
    items.some((i) => i.kind === "lazyStatic" && i.rc) &&
    !imports.includes("use std::rc::Rc;")
  )
    imports.push("use std::rc::Rc;");
  return imports;
}

/** Does any item across the whole crate use JSON? (Series 045/090 serde derives.) */
function crateUsesJson(scan: unknown): boolean {
  return (
    usesKind(scan, "jsonStringify") ||
    usesKind(scan, "jsonParse") ||
    usesKind(scan, "parseJson") ||
    // The 090 JsonValue boundary deserializes (`from_value`) / serializes
    // (`to_value`) modeled structs, so they need the serde derives too.
    usesKind(scan, "fromJsonValue") ||
    usesKind(scan, "toJsonValue")
  );
}

/** Emit the generated `fn main` (with its `Result`/`#[tokio::main]` shape). */
function emitMain(mod: HirModule): string {
  const body = mod.main.map((s) => indent(emitStmt(s))).join("\n");
  // A fallible script makes `main` return `Result<(), String>` (its trailing
  // `Ok(())` is already in `mod.main`, added by lowering); else a bare `main`.
  const ret = mod.mainRet ? ` -> ${emitType(mod.mainRet)}` : "";
  // A script that `await`s needs an async runtime: `#[tokio::main] async fn main`.
  const attr = mod.mainAsync ? "#[tokio::main]\n" : "";
  const asyncKw = mod.mainAsync ? "async " : "";
  return `${attr}${asyncKw}fn main()${ret} {\n${body}\n}`;
}

/**
 * Emit a complete Rust module from already-lowered HIR. Single-file fast path: a
 * multi-file crate (`mod.mods` present, series 050) instead goes through
 * {@link emitCrate}; this stays the single-`main.rs` renderer for every existing
 * `lower()` result, byte-for-byte unchanged.
 */
export function emitModule(mod: HirModule): string {
  // Inline `namespace` mods (series 050d, Axis 4) render *within* this single file
  // as `mod Foo { … }`. A single-file `lower()` only ever produces inline mods (a
  // real crate goes through `emitCrate`); their items join the struct table + JSON
  // scan so a namespace struct's derives resolve.
  const inlineMods = (mod.mods ?? []).filter((m) => m.inline);
  const allItems = [...mod.items, ...inlineMods.flatMap((m) => m.items)];
  // A struct table (interface + class field shapes) drives on-demand trait
  // derivation (`derives.ts`); threaded through item emission.
  const structs = buildStructTable(allItems);
  // Generated structs derive serde traits only when the module uses JSON (045).
  const usesJson = crateUsesJson({ items: allItems, main: mod.main });
  const parts = inlineMods.map((m) => emitInlineMod(m, structs, usesJson));
  parts.push(...mod.items.map((item) => emitItem(item, structs, usesJson)));
  if (mod.main.length > 0) parts.push(emitMain(mod));
  const imports = stdImports(mod.items, mod.main);
  const prelude = imports.length > 0 ? `${imports.join("\n")}\n\n` : "";
  return `${prelude}${parts.join("\n\n")}\n`;
}

/** One emitted crate source file: a repo-relative path + its Rust contents. */
export interface CrateFile {
  /** Path relative to the crate `src`/example root, e.g. `main.rs`, `util/math.rs`. */
  path: string;
  content: string;
}

/**
 * Emit a **multi-file** crate (series 050) from a `lowerCrate` result: the entry
 * becomes `main.rs` (its items + generated `mod foo;` declarations + `fn main`),
 * and each non-`inline` `HirMod` becomes its own `.rs` file at its `modPath`
 * (`math.rs`, `util/math.rs`). Directory segments with no file of their own get a
 * synthetic module file carrying just their child `mod …;` declarations. Every
 * file computes its own std-import prelude (a separate file can't see the root's
 * `use`s). The struct table + JSON-usage flag are crate-global so a struct's
 * derives resolve regardless of which file declares or uses it. Runs one binary,
 * so the differential oracle (stdout diff) is unchanged.
 */
export function emitCrate(mod: HirModule): CrateFile[] {
  const mods = mod.mods ?? [];
  // Crate-global struct table + JSON flag (a struct in one file may be used with a
  // JSON boundary in another, and its derives must match).
  const allItems = [...mod.items, ...mods.flatMap((m) => m.items)];
  const structs = buildStructTable(allItems);
  const usesJson = crateUsesJson({ items: allItems, main: mod.main });

  const renderItems = (items: HirItem[]): string =>
    items.map((item) => emitItem(item, structs, usesJson)).join("\n\n");

  // `mod …;` declaration edges: for every real (file) mod, each modPath prefix's
  // last segment is declared in its parent (crate root for a top-level segment).
  // A key is the parent's modPath joined by "/" ("" = crate root).
  const fileMods = mods.filter((m) => !m.inline);
  const declsByParent = new Map<string, Set<string>>();
  const addDecl = (parent: string, child: string): void => {
    (declsByParent.get(parent) ?? declsByParent.set(parent, new Set()).get(parent)!).add(child);
  };
  for (const m of fileMods) {
    for (let i = 1; i <= m.modPath.length; i++) {
      addDecl(m.modPath.slice(0, i - 1).join("/"), m.modPath[i - 1] as string);
    }
  }
  // `pub(crate) mod` (not bare `mod`): a nested module path (`crate::util::math`)
  // is only reachable crate-wide if every segment is at least `pub(crate)` — a
  // private child `mod math;` inside `util` would make `crate::util::math` an
  // E0603 ("module is private") from the root. Visibility-only, so behavior is
  // unchanged; a single-segment module was already reachable but stays consistent.
  const declLines = (parent: string): string[] =>
    [...(declsByParent.get(parent) ?? [])].map((c) => `pub(crate) mod ${rid(c)};`);

  // Inline namespace mods (Axis 4) render *within* their parent file as `mod n { … }`.
  const inlineMods = mods.filter((m) => m.inline);
  const inlineFor = (parent: string): string[] =>
    inlineMods
      .filter((m) => m.modPath.slice(0, -1).join("/") === parent)
      .map((m) => emitInlineMod(m, structs, usesJson));

  const files: CrateFile[] = [];

  // ── Crate root (main.rs) ──────────────────────────────────────────────────
  const rootParts: string[] = [];
  rootParts.push(...declLines(""));
  const rootUses = mod.uses ?? [];
  if (rootUses.length > 0) rootParts.push(rootUses.join("\n"));
  rootParts.push(...inlineFor(""));
  if (mod.items.length > 0) rootParts.push(renderItems(mod.items));
  if (mod.main.length > 0) rootParts.push(emitMain(mod));
  const rootImports = stdImports(mod.items, mod.main);
  const rootPrelude =
    rootImports.length > 0 ? `${rootImports.join("\n")}\n\n` : "";
  files.push({
    path: "main.rs",
    content: `${rootPrelude}${rootParts.filter((p) => p.length > 0).join("\n\n")}\n`,
  });

  // ── Real module files ─────────────────────────────────────────────────────
  const fileByPath = new Map<string, HirMod>();
  for (const m of fileMods) fileByPath.set(m.modPath.join("/"), m);

  // Every real leaf file + every synthetic directory module (a prefix that
  // declares children but has no file of its own).
  const emittedPaths = new Set<string>();
  const emitModFile = (key: string): void => {
    if (emittedPaths.has(key) || key === "") return;
    emittedPaths.add(key);
    const m = fileByPath.get(key);
    const parts: string[] = [];
    parts.push(...declLines(key));
    parts.push(...inlineFor(key));
    let items: HirItem[] = [];
    if (m) {
      if (m.uses.length > 0) parts.push(m.uses.join("\n"));
      items = m.items;
      if (items.length > 0) parts.push(renderItems(items));
    }
    const imports = stdImports(items, []);
    const prelude = imports.length > 0 ? `${imports.join("\n")}\n\n` : "";
    files.push({
      path: `${key}.rs`,
      content: `${prelude}${parts.filter((p) => p.length > 0).join("\n\n")}\n`,
    });
  };
  // Directory modules first (parents), then leaves — order is irrelevant to cargo.
  for (const parent of declsByParent.keys()) emitModFile(parent);
  for (const m of fileMods) emitModFile(m.modPath.join("/"));

  return files;
}

/** Render an inline namespace module (Axis 4): `[pub] mod name { <uses> <items> }`. */
function emitInlineMod(
  m: HirMod,
  structs: StructTable,
  usesJson: boolean,
): string {
  const inner: string[] = [];
  // A `mod { … }` block does not inherit the file's `use` prelude, so each inline
  // mod computes its own std imports from its items (series 050d).
  const imports = stdImports(m.items, []);
  if (imports.length > 0) inner.push(imports.join("\n"));
  if (m.uses.length > 0) inner.push(m.uses.join("\n"));
  for (const item of m.items) inner.push(emitItem(item, structs, usesJson));
  const body = inner.map((s) => indent(s)).join("\n\n");
  return `mod ${rid(m.name)} {\n${body}\n}`;
}

/**
 * Does any HIR node in the tree carry `kind: <kind>`? A generic deep-scan — every
 * HIR node is a plain object tagged with `kind` — used to decide which std `use`
 * imports the module needs (`HashMap`, `Rc`/`RefCell`). The emitter is the sole
 * producer of each, so the scan is exact.
 */
function usesKind(node: unknown, kind: string): boolean {
  if (Array.isArray(node)) return node.some((n) => usesKind(n, kind));
  if (node !== null && typeof node === "object") {
    if ((node as { kind?: string }).kind === kind) return true;
    return Object.values(node).some((n) => usesKind(n, kind));
  }
  return false;
}

// ── Items ────────────────────────────────────────────────────────────────────

/**
 * Render an item/field/method visibility keyword prefix (series 050): `"pub "` /
 * `"pub(crate) "`, or `""` for a private (default) item. Placed right before the
 * `fn`/`struct`/`enum` keyword (after any `#[derive]`/attribute), so
 * `#[derive(…)]\npub(crate) struct Foo` is well-formed.
 */
function visKw(vis: Vis | undefined): string {
  return vis === "pub" ? "pub " : vis === "pub(crate)" ? "pub(crate) " : "";
}

function emitItem(
  item: HirItem,
  structs: StructTable,
  usesJson: boolean,
): string {
  switch (item.kind) {
    case "fn":
      return emitFn(item);
    case "struct":
      return emitStruct(item, structs, usesJson);
    case "structKey":
      return emitStructKey(item);
    case "class":
      return emitClass(item, structs, usesJson);
    case "errorEnum":
      return emitErrorEnum(item);
    case "enum":
      return emitEnum(item);
    case "unionEnum":
      return emitUnionEnum(item);
    case "trait":
      return emitTrait(item);
    case "generator":
      return emitGenerator(item);
    case "lazyStatic":
      return emitLazyStatic(item);
  }
}

/**
 * A module-level value default (#70) → `pub(crate) static <name>: LazyLock<T> =
 * LazyLock::new(|| <init>);`. A non-scalar payload is `Rc`-wrapped so a
 * cross-module consumer's owned use is a cheap `Rc::clone`.
 */
function emitLazyStatic(item: HirLazyStatic): string {
  const vis =
    item.vis === "pub(crate)" ? "pub(crate) " : item.vis === "pub" ? "pub " : "";
  const tyText = item.rc ? `Rc<${emitType(item.ty)}>` : emitType(item.ty);
  const initText = item.rc
    ? `Rc::new(${emitExpr(item.init)})`
    : emitExpr(item.init);
  return `${vis}static ${rid(item.name)}: LazyLock<${tyText}> = LazyLock::new(|| ${initText});`;
}

/**
 * A generator state machine (series 052) → four Rust items:
 *   1. `struct <StructName> { state: u32, <params>, <across-yield locals> }`
 *   2. `impl <StructName> { fn new(<params>) -> Self { … } }` (params captured by
 *      value; local fields seeded with `Default::default()`, overwritten by their
 *      defining state arm)
 *   3. `impl Iterator for <StructName> { type Item = T; fn next(&mut self) ->
 *      Option<T> { loop { match self.state { <arms>, _ => return None } } } }`
 *   4. `fn <name>(<params>) -> impl Iterator<Item = T> { <StructName>::new(…) }`
 * The public wrapper keeps the 035 shape, so `for-of` consumption composes with
 * no change.
 */
function emitGenerator(g: HirGenerator): string {
  const sname = rid(g.structName);
  const itemTy = emitType(g.item);
  const retTy = emitType(g.retTy);

  // 1. struct — `state: u32` first, then owned params, then across-yield locals.
  // A `return <value>` generator (075) also carries `__ret: Option<R>` (stashed at
  // the terminal, `take()`n by `step()`). `yield*` delegate fields box either a `dyn
  // Iterator` (065 unread) or a `dyn Steppable` (075 read-completion) trait object,
  // `None` until the delegating state is first entered.
  const delegateFieldLines = g.delegateFields.map((f) => {
    const ty = f.steppable
      ? `Option<Box<dyn tslib::gen::Steppable<${itemTy}, ${emitType(f.delegateRet)}>>>`
      : `Option<Box<dyn Iterator<Item = ${itemTy}>>>`;
    return `${INDENT}${rid(f.name)}: ${ty},`;
  });
  // A bidirectional generator (076) also carries `__sent: Option<TNext>` — the send
  // value stashed by `resume(sent)` before the loop, `take()`n at the resumed arm.
  const nextTy = emitType(g.nextTy);
  const fieldLines = [
    `${INDENT}state: u32,`,
    ...(g.hasReturnValue ? [`${INDENT}__ret: Option<${retTy}>,`] : []),
    ...(g.bidirectional ? [`${INDENT}__sent: Option<${nextTy}>,`] : []),
    ...g.params.map((p) => `${INDENT}${rid(p.name)}: ${emitType(p.ty)},`),
    ...g.localFields.map((f) => `${INDENT}${rid(f.name)}: ${emitType(f.ty)},`),
    ...delegateFieldLines,
  ].join("\n");
  const struct = `struct ${sname} {\n${fieldLines}\n}`;

  // 2. impl New — params move in (field-init shorthand); locals default-seeded.
  const ctorParams = g.params
    .map((p) => `${rid(p.name)}: ${emitType(p.ty)}`)
    .join(", ");
  const ctorInits = [
    "state: 0",
    ...(g.hasReturnValue ? ["__ret: None"] : []),
    ...(g.bidirectional ? ["__sent: None"] : []),
    ...g.params.map((p) => rid(p.name)),
    ...g.localFields.map((f) => `${rid(f.name)}: Default::default()`),
    ...g.delegateFields.map((f) => `${rid(f.name)}: None`),
  ].join(", ");
  const newFn = [
    `impl ${sname} {`,
    `${INDENT}fn new(${ctorParams}) -> Self {`,
    `${INDENT}${INDENT}${sname} { ${ctorInits} }`,
    `${INDENT}}`,
    `}`,
  ].join("\n");

  // 3. the state-machine body — `loop { match self.state { … } }` returning
  // `GenStep<Y, R>` (052 state arms, 075 completion-value payload). This is the
  // shared driver: it lives in `step()` for a pull-only generator (075), or in
  // `resume(sent)` for a bidirectional one (076) with `step()`/`next()` routing
  // through `resume(<default>)`.
  const arms = g.states
    .map((s) => {
      const body = s.body.map((st) => indent(indent(emitStmt(st)))).join("\n");
      return `${INDENT}${INDENT}${INDENT}${s.id} => {\n${body}\n${INDENT}${INDENT}${INDENT}}`;
    })
    .join("\n");
  // The terminal fall-through (`_`) re-returns the completion value: `()` re-returns
  // freely; a non-`()` `R` has no value left after the first `take()` → fail-loud on
  // a repeated `step()` past done (a documented 075 residual, panics rather than
  // mis-values). This keeps `Iterator::next` (which drops `R`) returning `None`.
  const terminalArm = g.hasReturnValue
    ? `${INDENT}${INDENT}${INDENT}${INDENT}_ => return GenStep::Return(self.__ret.take().expect("generator stepped past completion (return value already consumed)")),`
    : `${INDENT}${INDENT}${INDENT}${INDENT}_ => return GenStep::Return(()),`;
  const driverLoop = [
    `${INDENT}${INDENT}loop {`,
    `${INDENT}${INDENT}${INDENT}match self.state {`,
    arms,
    terminalArm,
    `${INDENT}${INDENT}${INDENT}}`,
    `${INDENT}${INDENT}}`,
  ].join("\n");

  const items: string[] = [struct, newFn];

  if (g.bidirectional) {
    // 076: `resume(&mut self, sent: TNext)` is the driver — it stashes the send
    // value in `__sent` (the resumed arm `take()`s it, binding the `const x = yield
    // e` target) then runs the shared state loop.
    const resume = [
      `impl ${sname} {`,
      `${INDENT}fn resume(&mut self, sent: ${nextTy}) -> GenStep<${itemTy}, ${retTy}> {`,
      `${INDENT}${INDENT}self.__sent = Some(sent);`,
      driverLoop,
      `${INDENT}}`,
      `}`,
    ].join("\n");
    items.push(resume);

    // When `TNext` is defaultable (`Option<T>`, default `None` — the 066 undefined
    // model), the generator keeps the pull-only surfaces via `resume(<default>)`:
    // `Steppable::step` and `impl Iterator` both route through it, so `for-of` /
    // spread / `.collect()` / `yield*` still compose (JS sends `undefined` there).
    // A non-defaultable `TNext` is `resume`-only — no `step`/`Iterator` (for-of /
    // collect over it is fail-loud at the consumption site).
    if (g.nextDefaultable) {
      const steppable = [
        `impl tslib::gen::Steppable<${itemTy}, ${retTy}> for ${sname} {`,
        `${INDENT}fn step(&mut self) -> GenStep<${itemTy}, ${retTy}> {`,
        `${INDENT}${INDENT}self.resume(Default::default())`,
        `${INDENT}}`,
        `}`,
      ].join("\n");
      const iter = [
        `impl Iterator for ${sname} {`,
        `${INDENT}type Item = ${itemTy};`,
        `${INDENT}fn next(&mut self) -> Option<${itemTy}> {`,
        `${INDENT}${INDENT}match self.resume(Default::default()) {`,
        `${INDENT}${INDENT}${INDENT}GenStep::Yield(__v) => Some(__v),`,
        `${INDENT}${INDENT}${INDENT}GenStep::Return(_) => None,`,
        `${INDENT}${INDENT}}`,
        `${INDENT}}`,
        `}`,
      ].join("\n");
      items.push(steppable, iter);
    }
  } else {
    // 075 pull-only path (byte-for-byte): `Steppable::step` is the driver; `impl
    // Iterator::next` delegates to it, dropping the completion value.
    const steppable = [
      `impl tslib::gen::Steppable<${itemTy}, ${retTy}> for ${sname} {`,
      `${INDENT}fn step(&mut self) -> GenStep<${itemTy}, ${retTy}> {`,
      driverLoop,
      `${INDENT}}`,
      `}`,
    ].join("\n");
    const iter = [
      `impl Iterator for ${sname} {`,
      `${INDENT}type Item = ${itemTy};`,
      `${INDENT}fn next(&mut self) -> Option<${itemTy}> {`,
      `${INDENT}${INDENT}match tslib::gen::Steppable::step(self) {`,
      `${INDENT}${INDENT}${INDENT}GenStep::Yield(__v) => Some(__v),`,
      `${INDENT}${INDENT}${INDENT}GenStep::Return(_) => None,`,
      `${INDENT}${INDENT}}`,
      `${INDENT}}`,
      `}`,
    ].join("\n");
    items.push(steppable, iter);
  }

  // 5. wrapper fn — the public surface. Normally `impl Iterator<Item = Y>` (065,
  // byte-for-byte). A manually-stepped generator (075) returns the concrete struct
  // so `step()` / `Steppable` is reachable through the binding (`for-of` still
  // composes — the struct is `IntoIterator` via its `Iterator`). A `resume`-only
  // bidirectional generator (076, non-defaultable `TNext`) has no `impl Iterator`,
  // so its wrapper must also return the concrete struct.
  const wrapArgs = g.params.map((p) => rid(p.name)).join(", ");
  const wrapRet =
    g.exposesStep || (g.bidirectional && !g.nextDefaultable)
      ? sname
      : `impl Iterator<Item = ${itemTy}>`;
  const wrapper = `${visKw(g.vis)}fn ${rid(g.name)}(${ctorParams}) -> ${wrapRet} { ${sname}::new(${wrapArgs}) }`;
  items.push(wrapper);

  return items.join("\n\n");
}

/**
 * A synthesized shared trait `IA` (series 053b): method **signatures** for the
 * base class's public methods, plus (on demand, 053c) read-only accessor
 * signatures for base fields read through a `dyn IA`. Every concrete class then
 * provides *all* of these in its own `impl IA for Name` (the base supplies the
 * real bodies, a subclass its overrides + forwarders + accessor bodies) — those
 * are emitted next to the class in `emitClass`. Bodyless signatures keep `Self`
 * data-free, so no default ever touches a field the impl might not have.
 */
function emitTrait(t: HirTrait): string {
  const methods = t.methods.map((f) => indent(emitFnSig(f) + ";"));
  const accessors = t.accessors.map((a) =>
    indent(`fn ${rid(a.field)}(&self) -> &${emitType(a.ty)};`),
  );
  // Interface-inheritance getters return by value (series 059).
  const byValue = (t.byValueAccessors ?? []).map((a) =>
    indent(`fn ${rid(a.field)}(&self) -> ${emitType(a.ty)};`),
  );
  const body = [...byValue, ...accessors, ...methods].join("\n");
  return `trait ${rid(t.name)} {\n${body}\n}`;
}

/**
 * The receiver segment of a method's parameter list: `&mut self` (`refMut`),
 * `&self` (`ref`), an owned `self` (`owned`, a consuming method — series 068), or
 * none (a free/associated fn with no receiver).
 */
function selfReceiver(recv: HirFn["recv"]): string[] {
  if (recv === "refMut") return ["&mut self"];
  if (recv === "ref") return ["&self"];
  if (recv === "owned") return ["self"];
  return [];
}

/** A function signature (no body) — `[async ]fn name(&self, …)[ -> R]`. */
function emitFnSig(fn: HirFn): string {
  const asyncKw = fn.isAsync ? "async " : "";
  const self = selfReceiver(fn.recv);
  const rest = fn.params.map(
    (p) => `${p.pat ?? rid(p.name)}: ${emitType(p.ty)}`,
  );
  const params = [...self, ...rest].join(", ");
  const ret = fn.ret.kind === "unit" ? "" : ` -> ${emitType(fn.ret)}`;
  return `${asyncKw}fn ${rid(fn.name)}${fnGenericClause(fn)}(${params})${ret}`;
}

/**
 * A C-like `enum` → `#[derive(Clone, Copy, PartialEq)]\nenum Name { A, B = 1, … }`.
 * The derives make the value copyable and comparable (a `switch` guard needs
 * `PartialEq`); an explicit `disc` renders as `= <n>`.
 */
function emitEnum(e: HirEnum): string {
  const variants = e.variants
    .map((v) =>
      indent(
        v.disc === null ? `${rid(v.name)},` : `${rid(v.name)} = ${v.disc},`,
      ),
    )
    .join("\n");
  return `#[derive(Clone, Copy, PartialEq)]\n${visKw(e.vis)}enum ${rid(e.name)} {\n${variants}\n}`;
}

/**
 * The whole-program error enum (series 049) → a `#[derive(thiserror::Error,
 * Debug)]` `enum AppError` whose variants each carry ordered typed fields
 * (`message: String` first) under a `#[error(display)]` attribute (thiserror
 * generates `Display` + `std::error::Error`). Plus the `From<String>` /
 * `From<&str>` impls constructing the `Other` catch-all, so a `String`/`&str`
 * flowing into an `AppError` slot (`.into()`, `?` on a `Result<_, String>`)
 * composes. `thiserror::Error` is fully-qualified, so no `use` prelude is needed.
 */
function emitErrorEnum(e: HirErrorEnum): string {
  const variants = e.variants
    .map((v) => {
      const fields = v.fields
        .map((f) => `${rid(f.name)}: ${emitType(f.ty)}`)
        .join(", ");
      return [
        indent(`#[error(${JSON.stringify(v.display)})]`),
        indent(`${rid(v.name)} { ${fields} },`),
      ].join("\n");
    })
    .join("\n");
  const enumDecl = `#[derive(thiserror::Error, Debug)]\nenum AppError {\n${variants}\n}`;
  const fromString = [
    `impl From<String> for AppError {`,
    `${INDENT}fn from(message: String) -> AppError {`,
    `${INDENT}${INDENT}AppError::Other { message }`,
    `${INDENT}}`,
    `}`,
  ].join("\n");
  const fromStr = [
    `impl From<&str> for AppError {`,
    `${INDENT}fn from(message: &str) -> AppError {`,
    `${INDENT}${INDENT}AppError::Other { message: message.to_string() }`,
    `${INDENT}}`,
    `}`,
  ].join("\n");
  return [enumDecl, fromString, fromStr].join("\n\n");
}

/**
 * A union-type enum (series 093) → its `enum` definition plus, for a **literal**
 * union (`displayImpl`), an `impl Display` whose arms round-trip each fieldless
 * variant to its original source literal. A struct variant (`Circle { r: f64 }`,
 * later stages) renders its fields; a fieldless variant is a bare `North,`. The
 * `Display` arg is a Rust string literal (`JSON.stringify`), so `{`/`"`/`\` in a
 * source literal round-trip safely.
 */
function emitUnionEnum(e: HirUnionEnum): string {
  const variants = e.variants
    .map((v) => {
      if (v.newtype) return indent(`${rid(v.name)}(${emitType(v.newtype)}),`);
      if (v.fields.length === 0) return indent(`${rid(v.name)},`);
      const fields = v.fields
        .map((f) => `${rid(f.name)}: ${emitType(f.ty)}`)
        .join(", ");
      return indent(`${rid(v.name)} { ${fields} },`);
    })
    .join("\n");
  const decl = `#[derive(${e.derives.join(", ")})]\n${visKw(e.vis)}enum ${rid(e.name)} {\n${variants}\n}`;
  if (!e.displayImpl) return decl;
  const arms = e.variants
    .map((v) =>
      indent(
        indent(
          // A **newtype** variant (primitive/mixed union F, series 093/094): bind
          // the inner and render it via `Display` — `Str(s)`/`Num(n)`/`Bool(b)` all
          // print as JS `String(v)` does. A **fieldless** variant (literal union
          // A/B) round-trips to its source literal.
          v.newtype
            ? `${rid(e.name)}::${rid(v.name)}(inner) => write!(f, "{}", inner),`
            : `${rid(e.name)}::${rid(v.name)} => write!(f, "{}", ${JSON.stringify(v.display ?? "")}),`,
        ),
      ),
    )
    .join("\n");
  const display = [
    `impl std::fmt::Display for ${rid(e.name)} {`,
    `${INDENT}fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {`,
    `${INDENT}${INDENT}match self {`,
    arms,
    `${INDENT}${INDENT}}`,
    `${INDENT}}`,
    `}`,
  ].join("\n");
  return `${decl}\n\n${display}`;
}

/** A `class` → its `struct` definition, an `impl` block, and (if any) `Drop`. */
function emitClass(
  c: HirClass,
  structs: StructTable,
  usesJson: boolean,
): string {
  const struct = emitStruct(
    {
      kind: "struct",
      name: c.name,
      vis: c.vis,
      fields: c.fields,
      generics: c.generics,
    },
    structs,
    usesJson,
  );
  // The inherent-impl generic clause (series 081): `impl<T: Clone> Box<T>` /
  // `impl<T: IShape + Clone> Boxed<T>`. Each param carries a `Clone` bound because
  // an inherent method returning a `T`/`param` field clones it (`self.v.clone()`),
  // which needs `T: Clone` on the *inherent* impl (the struct's `#[derive(Clone)]`
  // only bounds the derive-generated impl). This is the derive-driven cost of
  // decision 2 — a `Box<NonClone>` fails at this bound (accepted). The `for`-target
  // uses only the param names (`Box<T>`, no bound). `""` for a non-generic class.
  const implGen = implGenericClause(c.generics);
  const selfTy =
    c.generics && c.generics.length > 0
      ? `${rid(c.name)}<${c.generics.map((g) => rid(g.name)).join(", ")}>`
      : rid(c.name);
  // Class inheritance (series 053): trait methods (an override or a forwarder,
  // named in `overrides`) go in the `impl IA for Name` block, *not* the inherent
  // `impl` — else a duplicate definition. The inherent impl keeps `new` + any
  // non-trait method.
  const inherent = c.methods.filter((m) => !c.overrides?.has(m.name));
  // `static` fields → associated `const`s; `static` methods → associated `fn`s
  // with no `self` receiver (series 060). Consts lead the impl body.
  const consts = (c.staticConsts ?? []).map((k) =>
    indent(`const ${rid(k.name)}: ${emitType(k.ty)} = ${emitExpr(k.value)};`),
  );
  const fns = [c.ctor, ...(c.statics ?? []), ...inherent].filter(
    (f): f is HirFn => f !== null,
  );
  const body = [...consts, ...fns.map((f) => indent(emitFn(f)))].join("\n");
  const parts = [`${struct}\n\nimpl${implGen} ${selfTy} {\n${body}\n}`];
  // The `impl IA for Name` block carries the trait methods this class *provides*
  // (its overrides + forwarders for non-overridden methods) plus any on-demand
  // field accessors. A class that uses every trait default and reads no field
  // polymorphically emits an empty `impl IA for Name {}` (inheriting defaults).
  if (c.implTrait) {
    const traitFns = c.methods
      .filter((m) => c.overrides?.has(m.name))
      .map((f) => indent(emitFn(f)));
    const accessorFns = (c.accessors ?? []).map((a) =>
      indent(
        `fn ${rid(a.field)}(&self) -> &${emitType(a.ty)} { &${emitExpr(a.proj)} }`,
      ),
    );
    const implBody = [...accessorFns, ...traitFns].join("\n");
    parts.push(
      implBody.length === 0
        ? `impl ${rid(c.implTrait)} for ${rid(c.name)} {}`
        : `impl ${rid(c.implTrait)} for ${rid(c.name)} {\n${implBody}\n}`,
    );
  }
  // Behavioral-interface conformance (series 071): one `impl I<I> for C` per
  // implemented interface — data-field getters (clone) + method forwarders to the
  // inherent method (`self.m(..)`; inherent resolution wins, so no recursion).
  for (const it of c.interfaceImpls ?? []) {
    const getters = it.getters.map((g) =>
      indent(
        `fn ${rid(g.field)}(&self) -> ${emitType(g.ty)} { self.${rid(g.field)}.clone() }`,
      ),
    );
    const forwarders = it.methods.map((m) =>
      indent(
        `${emitFnSig(m)} { self.${rid(m.name)}(${m.params
          .map((p) => rid(p.name))
          .join(", ")}) }`,
      ),
    );
    const implBody = [...getters, ...forwarders].join("\n");
    parts.push(
      implBody.length === 0
        ? `impl ${rid(it.trait)} for ${rid(c.name)} {}`
        : `impl ${rid(it.trait)} for ${rid(c.name)} {\n${implBody}\n}`,
    );
  }
  // A `[Symbol.dispose]` method → `impl Drop` (RAII for `using`, series 025).
  if (c.dispose) {
    const dropBody = c.dispose
      .map((s) => indent(indent(emitStmt(s))))
      .join("\n");
    parts.push(
      `impl Drop for ${rid(c.name)} {\n${INDENT}fn drop(&mut self) {\n${dropBody}\n${INDENT}}\n}`,
    );
  }
  return parts.join("\n\n");
}

/**
 * `[#[derive(...)]\n]struct Name {\n    field: Ty,\n …\n}` (or `Name {}` when
 * field-less). The derive clause is computed on-demand from field eligibility
 * (`derives.ts`) — `Clone` (for the ownership pass) + `Debug` (for `console.log`).
 */
function emitStruct(
  s: HirStruct,
  structs: StructTable,
  usesJson = false,
): string {
  const derive = structDeriveClause(s, structs, usesJson);
  const gen = genericClause(s.generics);
  // An `undefined`-only field omits its JSON key when `None` (series 091) — but
  // the `#[serde(...)]` helper attribute is only valid when serde is actually
  // derived (else "cannot find attribute `serde`"), so gate on the derive itself.
  const serdeDerived = derive.includes("serde::Serialize");
  const emitField = (f: HirStruct["fields"][number]): string => {
    const field = `${visKw(f.vis)}${rid(f.name)}: ${emitType(f.ty)},`;
    return serdeDerived && f.omitIfNone
      ? indent(`#[serde(skip_serializing_if = "Option::is_none")]\n${field}`)
      : indent(field);
  };
  const decl =
    s.fields.length === 0
      ? `${derive}${visKw(s.vis)}struct ${rid(s.name)}${gen} {}`
      : `${derive}${visKw(s.vis)}struct ${rid(s.name)}${gen} {\n${s.fields
          .map(emitField)
          .join("\n")}\n}`;
  // Interface inheritance (series 059): a getter-trait impl per extended base. Each
  // getter clones its (flattened) field, so a base-typed `&impl IA` reads by value.
  const impls = (s.implTraits ?? []).map((it) => {
    const getters = it.getters
      .map((g) =>
        indent(
          `fn ${rid(g.field)}(&self) -> ${emitType(g.ty)} { self.${rid(g.field)}.clone() }`,
        ),
      )
      .join("\n");
    return `impl ${rid(it.trait)} for ${rid(s.name)} {\n${getters}\n}`;
  });
  // Object-literal interface synthesis (series 071 increment 2): the per-literal
  // struct's `impl I<Name>` — each data field a by-value getter (clone), each
  // method a call through the stored `fn`-pointer field `(self.m)(args)`.
  if (s.litImpl) {
    const li = s.litImpl;
    const getterFns = li.getters.map((g) =>
      indent(
        `fn ${rid(g.field)}(&self) -> ${emitType(g.ty)} { self.${rid(g.field)}.clone() }`,
      ),
    );
    const methodFns = li.methods.map(({ sig, field }) =>
      indent(
        `${emitFnSig(sig)} { (self.${rid(field)})(${sig.params
          .map((p) => rid(p.name))
          .join(", ")}) }`,
      ),
    );
    const body = [...getterFns, ...methodFns].join("\n");
    impls.push(`impl ${rid(li.trait)} for ${rid(s.name)} {\n${body}\n}`);
  }
  // Structural `===` over a struct-typed generic `T` (series 088): a `PartialEq`
  // struct also implements `tslib::ops::JsEq` (delegating to `==`).
  const jsEq = jsEqImpl(s, structs);
  if (jsEq) impls.push(jsEq);
  return [decl, ...impls].join("\n\n");
}

/**
 * The per-struct `impl tslib::ops::JsEq` block (series 088) for structural `===`
 * over a struct-typed generic `T`, or `""` when the struct doesn't derive
 * `PartialEq` (so the impl wouldn't compile) or is itself generic (a struct-typed
 * `T` is always a concrete named struct). Delegates to the derived `PartialEq`
 * (`self == o`), so it stays consistent with concrete struct `===`.
 */
function jsEqImpl(
  s: {
    name: string;
    fields: { name: string; ty: RustType }[];
    hashEq?: boolean;
    generics?: GenericParam[];
  },
  structs: StructTable,
): string {
  if (s.generics && s.generics.length > 0) return "";
  if (!structDerivesPartialEq(s, structs)) return "";
  return [
    `impl tslib::ops::JsEq for ${rid(s.name)} {`,
    `${INDENT}fn js_eq(&self, o: &Self) -> bool { self == o }`,
    `${INDENT}fn js_ne(&self, o: &Self) -> bool { self != o }`,
    `}`,
  ].join("\n");
}

/** The Rust name for a `structKey` type — the base struct name, `Key`-suffixed. */
function structKeyRustName(struct: string): string {
  return `${rid(struct)}Key`;
}

/**
 * The tuple-struct *constructor* name that wraps a raw key/element into its
 * hashable Rust key type in a `new Map(x)`/`new Set(x)` `.map` closure (series
 * 072): `OrderedFloat` for a scalar number, `<Struct>Key` for an f64-bearing
 * struct key. Distinct from `emitType` (which renders `OrderedFloat<f64>`).
 */
function wrapCtor(ty: RustType): string {
  return ty.kind === "structKey" ? structKeyRustName(ty.name) : "OrderedFloat";
}

/**
 * A synthesized SameValueZero key newtype (series 074): the tuple struct
 * `<Struct>Key(<Struct>)` plus custom `PartialEq`/`Eq`/`Hash` impls. Each `f64`
 * leaf is wrapped in `OrderedFloat` at compare/hash time (JS SameValueZero:
 * `NaN == NaN`, `-0`/`+0` collapse); every other field uses plain `==`/`.hash()`.
 * `Clone`/`Debug` derive via the wrapped struct. The wrapped struct keeps its raw
 * `f64` fields (arithmetic untouched) and its `===`-faithful derived `PartialEq`.
 */
function emitStructKey(k: HirStructKey): string {
  const name = structKeyRustName(k.struct);
  const wrapped = rid(k.struct);
  // `OrderedFloat(<proj>)` for an f64 leaf; the bare `<proj>` otherwise.
  const proj = (recv: string, field: string, f64: boolean): string => {
    const p = `${recv}.0.${rid(field)}`;
    return f64 ? `OrderedFloat(${p})` : p;
  };
  const decl = `struct ${name}(${wrapped});`;

  const eqBody =
    k.fields.length === 0
      ? "true"
      : k.fields
          .map(
            (f) =>
              `${proj("self", f.name, f.f64)} == ${proj("o", f.name, f.f64)}`,
          )
          .join("\n            && ");
  const partialEq = [
    `impl PartialEq for ${name} {`,
    `${INDENT}fn eq(&self, o: &Self) -> bool {`,
    `${INDENT}${INDENT}${eqBody}`,
    `${INDENT}}`,
    "}",
  ].join("\n");

  const eq = `impl Eq for ${name} {}`;

  const hashBody = k.fields
    .map((f) => `${INDENT}${INDENT}${proj("self", f.name, f.f64)}.hash(s);`)
    .join("\n");
  const hash = [
    `impl std::hash::Hash for ${name} {`,
    `${INDENT}fn hash<H: std::hash::Hasher>(&self, s: &mut H) {`,
    hashBody,
    `${INDENT}}`,
    "}",
  ].join("\n");

  return [decl, partialEq, eq, hash].join("\n\n");
}

function emitFn(fn: HirFn): string {
  const asyncKw = fn.isAsync ? "async " : "";
  // A method's `self` receiver leads the parameter list; free/associated fns omit it.
  const self = selfReceiver(fn.recv);
  const rest = fn.params.map(
    (p) => `${p.pat ?? rid(p.name)}: ${emitType(p.ty)}`,
  );
  const params = [...self, ...rest].join(", ");
  const ret = fn.ret.kind === "unit" ? "" : ` -> ${emitType(fn.ret)}`;
  return `${visKw(fn.vis)}${asyncKw}fn ${rid(fn.name)}${fnGenericClause(fn)}(${params})${ret} ${block(fn.body)}`;
}

/**
 * A generic clause for a class/struct — `<T>` / `<T: IShape>` / `<A, B>` (series
 * 081), or `""` when there are none. Rendered on the `struct` header and the
 * `impl` block (the impl repeats the same params). A bound joins with `: <trait>`.
 */
function genericClause(generics: GenericParam[] | undefined): string {
  if (!generics || generics.length === 0) return "";
  const parts = generics.map((g) => paramBoundStr(g, false));
  return `<${parts.join(", ")}>`;
}

/**
 * Render one generic param's bound list (series 081 + 088): the interface `bound`
 * (081), then the JS-operator trait bounds (`opBounds`, 088), then — on the
 * inherent impl only (`withClone`) — the derive-driven `Clone`. `<T>` when the
 * param is unbounded and `Clone` isn't forced; `<T: A + B + Clone>` when several
 * apply. Order is stable so emission is deterministic.
 */
function paramBoundStr(g: GenericParam, withClone: boolean): string {
  const bounds: string[] = [];
  if (g.bound) bounds.push(rid(g.bound));
  if (g.opBounds) bounds.push(...g.opBounds);
  if (withClone) bounds.push("Clone");
  return bounds.length === 0 ? rid(g.name) : `${rid(g.name)}: ${bounds.join(" + ")}`;
}

/**
 * The **inherent-impl** generic clause (series 081): like `genericClause` but each
 * param also carries a `Clone` bound (`<T: Clone>` / `<T: IShape + Clone>`), needed
 * because an inherent method's `return self.field` of a `param` field clones it.
 * The struct header keeps the bare `genericClause` (its `#[derive]`s add the
 * per-derive bound); only the inherent impl needs the explicit `Clone`.
 */
function implGenericClause(generics: GenericParam[] | undefined): string {
  if (!generics || generics.length === 0) return "";
  const parts = generics.map((g) => paramBoundStr(g, true));
  return `<${parts.join(", ")}>`;
}

/** A **method/fn's own** generic clause `<U: Clone, …>` (series 081), rendered
 * after the fn name; `""` for a non-generic fn. Each param carries a `Clone` bound
 * (derive-driven) so a body that returns/moves a `U` element clones it
 * (`xs[0].clone()`), which needs `U: Clone` on the fn. */
function fnGenericClause(fn: HirFn): string {
  if (!fn.generics || fn.generics.length === 0) return "";
  return `<${fn.generics.map((g) => `${rid(g)}: Clone`).join(", ")}>`;
}

/** Render a braced, indented statement block (`{\n …\n}`, or `{\n}` if empty). */
function block(stmts: HirStmt[]): string {
  if (stmts.length === 0) return "{\n}";
  return `{\n${stmts.map((s) => indent(emitStmt(s))).join("\n")}\n}`;
}

// ── Statements ───────────────────────────────────────────────────────────────

/** The inline note attached to a line carrying a bitwise op (series 056). */
const BITWISE_NOTE = " // bitwise: wide-int (i128), not JS int32";

/**
 * Does this expression tree carry a bitwise-origin node (series 056)? A `binary`/
 * `unary` with the `bitwise` marker, or a `ushr` (`>>>`). Used to attach the inline
 * divergence note; scans only the expression, not nested statement bodies.
 */
function exprHasBitwise(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(exprHasBitwise);
  if (node !== null && typeof node === "object") {
    const n = node as { kind?: string; bitwise?: boolean };
    if (n.kind === "ushr") return true;
    if ((n.kind === "binary" || n.kind === "unary") && n.bitwise === true)
      return true;
    return Object.values(node).some(exprHasBitwise);
  }
  return false;
}

function emitStmt(stmt: HirStmt): string {
  switch (stmt.kind) {
    case "let": {
      // A tuple-destructuring binding (series 051a): `let (a, b) = join!(…)`.
      // Rust infers the tuple type, so no annotation is emitted.
      if (stmt.names) {
        const pat = stmt.names.map(rid).join(", ");
        return `let (${pat}) = ${emitExpr(stmt.init)};`;
      }
      // A struct-pattern destructuring binding (series 067): `let Point { x, y } =
      // <source>;`. The pattern is pre-built by the lowerer; field names bind the
      // source's struct fields, so no type annotation is emitted.
      if (stmt.pat) {
        return `let ${stmt.pat} = ${emitExpr(stmt.init)};`;
      }
      const mut = stmt.mut ? "mut " : "";
      const ty = stmt.ty ? `: ${emitType(stmt.ty)}` : "";
      // A task-escape share wrap (series 051c increment 2): the initializer is
      // wrapped in `Arc::new(…)` (shared read) / `Arc::new(Mutex::new(…))`
      // (shared mutation). The binding's type annotation is dropped — Rust infers
      // the `Arc<…>` — so the wrap reads cleanly.
      if (stmt.share) {
        const inner = emitExpr(stmt.init);
        const wrapped =
          stmt.share === "arcMutex"
            ? `std::sync::Arc::new(std::sync::Mutex::new(${inner}))`
            : `std::sync::Arc::new(${inner})`;
        return `let ${mut}${rid(stmt.name)} = ${wrapped};`;
      }
      return `let ${mut}${rid(stmt.name)}${ty} = ${emitExpr(stmt.init)};${exprHasBitwise(stmt.init) ? BITWISE_NOTE : ""}`;
    }
    case "return":
      return stmt.value
        ? `return ${emitExpr(stmt.value)};${exprHasBitwise(stmt.value) ? BITWISE_NOTE : ""}`
        : "return;";
    case "expr":
      return `${emitExpr(stmt.expr)};${exprHasBitwise(stmt.expr) ? BITWISE_NOTE : ""}`;
    case "if": {
      const head = `if ${emitExpr(stmt.cond)} ${block(stmt.conseq)}`;
      if (stmt.alt === null) return head;
      // An `else if` chain: a lone `if` alternate renders as `else if …`,
      // never the un-idiomatic `else { if … }`.
      const [only] = stmt.alt;
      if (stmt.alt.length === 1 && only?.kind === "if") {
        return `${head} else ${emitStmt(only)}`;
      }
      return `${head} else ${block(stmt.alt)}`;
    }
    case "ifLet": {
      const head = `if let Some(${rid(stmt.binding)}) = ${emitExpr(stmt.scrutinee)} ${block(stmt.someBody)}`;
      return stmt.noneBody === null
        ? head
        : `${head} else ${block(stmt.noneBody)}`;
    }
    case "while":
      return `${loopLabel(stmt.label)}while ${emitExpr(stmt.cond)} ${block(stmt.body)}`;
    case "block":
      // A bare scope-containing block; no trailing `;` as a statement.
      return block(stmt.body);
    case "forIn": {
      // The default (ref / unset) `iter` already bakes in `.iter()` — emit it
      // verbatim. The 064 element-ownership modes carry a *bare* collection: `&mut
      // xs` (refMut), `xs` (owned — dead after the loop), `xs.iter().cloned()`
      // (cloned — owned elements, `xs` still live).
      let iter = emitExpr(stmt.iter);
      if (stmt.mode === "refMut") iter = `&mut ${iter}`;
      else if (stmt.mode === "cloned") iter = `${iter}.iter().cloned()`;
      return `${loopLabel(stmt.label)}for ${rid(stmt.pat)} in ${iter} ${block(stmt.body)}`;
    }
    case "forInReborrow":
      return emitReborrowLoop(stmt);
    case "forRange": {
      const dots = stmt.inclusive ? "..=" : "..";
      // An `i64` counter (series 103b-2) pins the range element type so Rust does
      // not default the untyped range literals to `i32`: suffix a literal endpoint
      // (`0i64`), or cast a non-literal one (`(e as i64)`).
      const endpoint = (e: HirExpr): string =>
        stmt.counterTy === "i64"
          ? e.kind === "number" && Number.isInteger(e.value)
            ? `${e.value}i64`
            : `(${emitExpr(e)} as i64)`
          : emitExpr(e);
      let range = `${endpoint(stmt.start)}${dots}${emitExpr(stmt.end)}`;
      // A non-ascending / non-unit-step range (series 064). `.rev()` needs the
      // parenthesized range; `.step_by(k)` takes the positive stride.
      if (stmt.descending) range = `(${range}).rev()`;
      if (stmt.step && stmt.step !== 1) {
        range = stmt.descending
          ? `${range}.step_by(${stmt.step})`
          : `(${range}).step_by(${stmt.step})`;
      }
      return `${loopLabel(stmt.label)}for ${rid(stmt.counter)} in ${range} ${block(stmt.body)}`;
    }
    case "match": {
      const arms = stmt.arms.map((arm) => indent(emitArm(arm))).join("\n");
      return `match ${emitExpr(stmt.disc)} {\n${arms}\n}`;
    }
    case "break":
      return stmt.label ? `break '${stmt.label};` : "break;";
    case "continue":
      return stmt.label ? `continue '${stmt.label};` : "continue;";
    case "yieldReturn":
      // A generator suspend point (052): record the resume arm, then hand the
      // yielded value back to the caller. Emitted inside `step()` — the primary
      // driver (series 075) — so it wraps in `GenStep::Yield`; `next()` delegates.
      return `self.state = ${stmt.resumeState};\nreturn GenStep::Yield(${emitExpr(stmt.value)});`;
    case "gotoState":
      // A straight-through generator transition (052) — the enclosing
      // `loop { match self.state { … } }` re-enters the target arm.
      return `self.state = ${stmt.state};`;
    case "genDone": {
      // The generator's terminal transition (052/075): stash any `return <value>`
      // payload into `__ret`, park in the exhausted state, and return
      // `GenStep::Return(<payload>)`. A bare `return` / fall-off returns
      // `GenStep::Return(())`. `step()` is the driver; `next()` delegates.
      const park = `self.state = ${stmt.terminal};`;
      if (stmt.retValue) {
        return [
          `self.__ret = Some(${emitExpr(stmt.retValue)});`,
          park,
          `return GenStep::Return(self.__ret.take().unwrap());`,
        ].join("\n");
      }
      // With a non-`()` `R` but no value on *this* path, the terminal still needs a
      // payload — `__ret.take()` (seeded by another `return`). A pure `R = ()` unit
      // generator returns `()` directly (no `__ret` field exists).
      return stmt.hasRet
        ? [park, `return GenStep::Return(self.__ret.take().unwrap());`].join("\n")
        : [park, `return GenStep::Return(());`].join("\n");
    }
    case "genResumeBind":
      // The head of a bidirectional generator's resumed arm (076): bind the sent
      // value (stashed by `resume(sent)` in `__sent`) to the `const x = yield e`
      // target. `resume` always seeds `__sent` before entering the loop.
      return `self.${rid(stmt.target)} = self.__sent.take().unwrap();`;
    case "yieldStarStep": {
      // `yield* <iter>` delegation (065/075): seed the boxed delegate on first
      // entry, then pump it. The unread-completion path keeps 065's `dyn Iterator`
      // box + `.next()` (re-yield each `Some(v)`); the read path (`readResult`)
      // uses a `dyn Steppable` box + `.step()`, binding the `Return` payload.
      const f = rid(stmt.field);
      if (stmt.readResult) {
        // Bind the delegate's completion value into `self.<resultTarget>` (a carried
        // field) so it survives to the resume arm that reads it.
        const assign = stmt.resultTarget
          ? `${INDENT}${INDENT}self.${rid(stmt.resultTarget)} = __rv;\n`
          : "";
        return [
          `if self.${f}.is_none() {`,
          `${INDENT}self.${f} = Some(Box::new(${emitExpr(stmt.iter)}));`,
          `}`,
          `match self.${f}.as_mut().unwrap().step() {`,
          `${INDENT}GenStep::Yield(__v) => return GenStep::Yield(__v),`,
          `${INDENT}GenStep::Return(__rv) => {`,
          `${assign}${INDENT}${INDENT}self.${f} = None;`,
          `${INDENT}${INDENT}self.state = ${stmt.resumeState};`,
          `${INDENT}}`,
          `}`,
        ].join("\n");
      }
      return [
        `if self.${f}.is_none() {`,
        `${INDENT}self.${f} = Some(Box::new(${emitExpr(stmt.iter)}));`,
        `}`,
        `match self.${f}.as_mut().unwrap().next() {`,
        `${INDENT}Some(__v) => return GenStep::Yield(__v),`,
        `${INDENT}None => {`,
        `${INDENT}${INDENT}self.${f} = None;`,
        `${INDENT}${INDENT}self.state = ${stmt.resumeState};`,
        `${INDENT}}`,
        `}`,
      ].join("\n");
    }
    case "throw":
      // Default: a propagated error `return Err(msg);`. Under `"use panic"`
      // (028a) it aborts with the message instead — no `Result`.
      return stmt.panic
        ? `panic!("{}", ${emitExpr(stmt.value)});`
        : `return Err(${emitExpr(stmt.value)});`;
    case "tryCatch": {
      // The `try` block is a `Result`-returning IIFE so its `?`/`throw`s
      // short-circuit to the closure; `catch` matches on the result; `finally`
      // runs after (divergence past it is rejected in lowering, so this is exact).
      const closure = `(|| -> Result<(), ${emitType(stmt.errTy)}> ${block(stmt.tryBody)})()`;
      // A discriminating catch (series 049c) renders `if let Err(<binder>) = … {
      // match <binder> { …arms } }` — a native exhaustive match with owned field
      // bindings, no `downcast_ref`. Otherwise the opaque bind is unchanged.
      let head: string;
      if (stmt.discriminant) {
        const binder = stmt.catchParam ? rid(stmt.catchParam) : "e";
        const arms = stmt.discriminant
          .map((arm) => indent(emitCatchArm(arm, binder)))
          .join("\n");
        const matchBlock = `{\n${indent(`match ${binder} {\n${arms}\n}`)}\n}`;
        head = `if let Err(${binder}) = ${closure} ${matchBlock}`;
      } else {
        const binder = stmt.catchParam ? rid(stmt.catchParam) : "_";
        head = `if let Err(${binder}) = ${closure} ${block(stmt.catchBody)}`;
      }
      if (!stmt.finallyBody) return head;
      const fin = stmt.finallyBody.map(emitStmt).join("\n");
      return `${head}\n${fin}`;
    }
    case "tryBlock": {
      // Labeled-block try (063): the `try` body is a value-producing block, not a
      // function boundary, so native `return`/`break`/`continue` in the arms
      // escape the enclosing fn/loop. `?`/`throw` inside became `break '<label>
      // Err(…)` in lowering, so the block yields `Ok(())` on normal completion.
      const errTy = emitType(stmt.errTy);
      const resVar = `__${stmt.label}`;
      const lbl = `'${stmt.label}`;
      const tryBodyLines = stmt.tryBody.map(emitStmt).join("\n");
      const blockExpr = `${lbl}: {\n${indent(`${tryBodyLines}\nOk(())`)}\n}`;
      const bind = `let ${resVar}: Result<(), ${errTy}> = ${blockExpr};`;
      // No handler (try/finally): run `finally` on both paths, then propagate an
      // error. (`finally` + an escaping jump is fail-loud in lowering.)
      if (stmt.catchBody === null) {
        const fin = (stmt.finallyBody ?? []).map(emitStmt).join("\n");
        const propagate = `if let Err(__e) = ${resVar} { return Err(__e); }`;
        return [bind, fin, propagate].filter((s) => s.length > 0).join("\n");
      }
      // A handler: `match __<label> { Ok(_) => {}, Err(<binder>) => { catch } }`,
      // both arms `()`-yielding (the value-yield happens via native `return` in the
      // arms). A discriminating ladder renders the inner `match` (049c).
      // The success arm is `unreachable!()` when the try body always diverges
      // (value-yield: it `return`s on success), so the `match` unifies to `!` and
      // a value-yielding fn's tail type-checks; otherwise it falls through (`{}`).
      const okArm = stmt.okUnreachable
        ? "Ok(_) => unreachable!(),"
        : "Ok(_) => {}";
      let matchStmt: string;
      if (stmt.discriminant) {
        const binder = stmt.catchParam ? rid(stmt.catchParam) : "e";
        const arms = stmt.discriminant
          .map((arm) => indent(indent(emitCatchArm(arm, binder))))
          .join("\n");
        matchStmt = [
          `match ${resVar} {`,
          `${INDENT}${okArm}`,
          `${INDENT}Err(${binder}) => {`,
          `${INDENT}${INDENT}match ${binder} {`,
          arms,
          `${INDENT}${INDENT}}`,
          `${INDENT}}`,
          `}`,
        ].join("\n");
      } else {
        const binder = stmt.catchParam ? rid(stmt.catchParam) : "_";
        matchStmt = [
          `match ${resVar} {`,
          `${INDENT}${okArm}`,
          `${INDENT}Err(${binder}) => ${block(stmt.catchBody)}`,
          `}`,
        ].join("\n");
      }
      const parts = [bind, matchStmt];
      if (stmt.finallyBody) parts.push(stmt.finallyBody.map(emitStmt).join("\n"));
      return parts.join("\n");
    }
    case "breakTry":
      return `break '${stmt.label} Err(${emitExpr(stmt.value)});`;
    case "carrierTry":
      return emitCarrierTry(stmt);
    case "carrierBreak": {
      // `break '<label> Ctrl_<label>::<Kind>(payload);`. Return carries the value
      // (or `()` for `return;`); Break/Continue carry the `BreakTarget` variant.
      const ctrl = ctrlName(stmt.label);
      if (stmt.ctrl === "Return") {
        const v = stmt.value ? emitExpr(stmt.value) : "()";
        return `break '${stmt.label} ${ctrl}::Return(${v});`;
      }
      const target = breakTargetVariant(stmt.target ?? null);
      return `break '${stmt.label} ${ctrl}::${stmt.ctrl}(${btName(stmt.label)}::${target});`;
    }
    case "carrierErr":
      return `break '${stmt.label} ${ctrlName(stmt.label)}::Err(${emitExpr(stmt.value)});`;
  }
}

/**
 * Series 077 — emit the index-based re-borrow loop for mutate-during-iteration over
 * an aliased container. Holds **no** borrow across the (already rc-rewritten) body,
 * so `RefCell` never panics; reproduces JS's live-cursor semantics.
 *
 * The private names are `__`-prefixed with a series tag to avoid colliding with any
 * user binding (post-`rid` hygiene keeps user names collision-free too).
 */
function emitReborrowLoop(
  stmt: Extract<HirStmt, { kind: "forInReborrow" }>,
): string {
  const owner = emitExpr(stmt.owner); // an `Rc<RefCell<T>>` ident.
  const field = rid(stmt.field);
  const label = loopLabel(stmt.label);
  // The loop body, inlined into the loop scope (not a nested `{}` block).
  const bodyLines = stmt.body.map((s) => indent(emitStmt(s))).join("\n");

  // The user binders (`x` / `k` / `v`) are materialized as real HIR `let`s over the
  // owned per-step clones (`__x077` / `__k077` / `__v077`) at the head of `body` by
  // `refineRc` — so `refineOwnership` sees them and the body's comparisons type-check
  // against owned values. The emitter only provides those owned locals.

  if (stmt.shape === "array") {
    // A live positional walk: re-borrow to read element `i` (cloned out to release
    // the borrow), advance, then run the body. `len()` is re-read each step, so
    // appends are visited and splice-shifts reindex exactly as JS's for-of does.
    return [
      "{",
      `${INDENT}let mut __i077: usize = 0;`,
      `${INDENT}${label}loop {`,
      `${INDENT}${INDENT}let __x077 = {`,
      `${INDENT}${INDENT}${INDENT}let __g077 = ${owner}.borrow();`,
      `${INDENT}${INDENT}${INDENT}if __i077 >= __g077.${field}.len() { break; }`,
      `${INDENT}${INDENT}${INDENT}__g077.${field}[__i077].clone()`,
      `${INDENT}${INDENT}};`,
      `${INDENT}${INDENT}__i077 += 1;`,
      indent(indent(bodyLines)),
      `${INDENT}}`,
      "}",
    ].join("\n");
  }

  // Map/Set — a stable key-snapshot `Vec` + a growing `__added077` append-buffer +
  // a `__seen077` once-guard, drained in two phases with a per-step `contains`/`get`
  // recheck. `refineRc` instrumented the body's visible inserts (an `__added077.push`)
  // and rejected opaque cell mutations. Deletes ride the live recheck (skipped).
  const isMap = stmt.shape === "map";
  // Snapshot the keys (map) / elements (set) into a stable ordered `Vec`, typed by
  // the key so a delete-only loop (no `__added` push) still type-checks.
  const keyTy = stmt.keyType ? emitType(stmt.keyType) : "_";
  const snapshot = isMap
    ? `${owner}.borrow().${field}.keys().cloned().collect::<Vec<${keyTy}>>()`
    : `${owner}.borrow().${field}.iter().cloned().collect::<Vec<${keyTy}>>()`;

  const lines = [
    "{",
    `${INDENT}let __keys077: Vec<${keyTy}> = ${snapshot};`,
    `${INDENT}let mut __added077: Vec<${keyTy}> = Vec::new();`,
    `${INDENT}let mut __seen077 = std::collections::HashSet::new();`,
    `${INDENT}let mut __src077: usize = 0;`,
    `${INDENT}${label}loop {`,
    `${INDENT}${INDENT}let __k077 = if __src077 < __keys077.len() {`,
    `${INDENT}${INDENT}${INDENT}let __kk = __keys077[__src077].clone(); __src077 += 1; __kk`,
    `${INDENT}${INDENT}} else if __src077 - __keys077.len() < __added077.len() {`,
    `${INDENT}${INDENT}${INDENT}let __kk = __added077[__src077 - __keys077.len()].clone(); __src077 += 1; __kk`,
    `${INDENT}${INDENT}} else { break; };`,
    `${INDENT}${INDENT}if !__seen077.insert(__k077.clone()) { continue; }`,
  ];
  if (isMap) {
    // Live value read; skip on a mid-iteration delete. The `k`/`v` HIR binder-`let`s
    // (owned) sit at the head of `body`.
    lines.push(
      `${INDENT}${INDENT}let __v077 = match ${owner}.borrow().${field}.get(&__k077) { Some(v) => v.clone(), None => continue };`,
    );
  } else {
    // A set element *is* the key; the recheck is the read (skip on delete).
    lines.push(
      `${INDENT}${INDENT}if !${owner}.borrow().${field}.contains(&__k077) { continue; }`,
    );
  }
  lines.push(indent(indent(bodyLines)));
  lines.push(`${INDENT}}`, "}");
  return lines.join("\n");
}

/** The 073 carrier `try`/`catch`/`finally` HIR node (narrowed for the emit). */
type HirCarrierTry = Extract<HirStmt, { kind: "carrierTry" }>;

/** The per-carrier control enum name (`Ctrl_<label>`) — distinct across nesting. */
function ctrlName(label: string): string {
  return `Ctrl_${label}`;
}

/** The per-carrier break/continue-target enum name (`BreakTarget_<label>`). */
function btName(label: string): string {
  return `BreakTarget_${label}`;
}

/** The `BreakTarget` enum variant for a break/continue target label. */
function breakTargetVariant(target: string | null): string {
  // A named loop label → its PascalCased identifier variant; the unlabeled
  // nearest-loop target → `Nearest`.
  return target === null ? "Nearest" : `L_${target}`;
}

/**
 * Emit a 073 `carrierTry` — a `finally` combined with an escaping jump. Renders a
 * local `enum Ctrl` (plus `BreakTarget` when break/continue escapes exist), a
 * wrapper `'<label>` block that yields the recorded control carrier, the `finally`
 * body natively, then a dispatch `match` that replays the escape. A self-escaping
 * `finally` pre-empts the carrier (the `finally` runs first), so its dispatch is
 * suppressed (`dispatchDead`).
 */
function emitCarrierTry(stmt: HirCarrierTry): string {
  const errTy = emitType(stmt.errTy);
  const retTy = emitType(stmt.retTy);
  const lbl = `'${stmt.label}`;
  const resVar = `__${stmt.label}`;
  const ctrl = ctrlName(stmt.label);
  const bt = btName(stmt.label);

  // The `Ctrl` variants actually used: `Return`/`Err` when an escape returns or
  // throws; `Break`/`Continue` per target set; `Normal` when the `try` can fall
  // through. `#[allow(dead_code)]` guards the `Normal`-only / unused-payload cases.
  const variants: string[] = [];
  if (stmt.hasReturn) variants.push(`Return(${retTy})`);
  if (stmt.hasErr) variants.push(`Err(${errTy})`);
  if (stmt.breakTargets.length > 0) variants.push(`Break(${bt})`);
  if (stmt.continueTargets.length > 0) variants.push(`Continue(${bt})`);
  if (stmt.tryFallsThrough) variants.push("Normal");
  const enumItem = `#[allow(dead_code)] enum ${ctrl} { ${variants.join(", ")} }`;

  // `BreakTarget` — one variant per distinct break/continue target.
  const targets = new Set<string | null>([
    ...stmt.breakTargets,
    ...stmt.continueTargets,
  ]);
  const breakTargetItem =
    targets.size > 0
      ? `enum ${bt} { ${[...targets]
          .map((t) => breakTargetVariant(t))
          .join(", ")} }`
      : null;

  // The wrapper block yields `Ctrl`. With a handler, an inner `'try` block yields
  // `Result` (the `try` arm's `?`/`throw`), then a `match` runs the `catch`.
  let inner: string;
  if (stmt.catchBody === null && !stmt.discriminant) {
    const body = stmt.tryBody.map(emitStmt).join("\n");
    const tail = stmt.tryFallsThrough ? `\n${ctrl}::Normal` : "";
    inner = `${lbl}: {\n${indent(`${body}${tail}`)}\n}`;
  } else {
    const innerLbl = `'${stmt.innerTryLabel}`;
    const innerRes = `__${stmt.innerTryLabel}`;
    const tryLines = stmt.tryBody.map(emitStmt).join("\n");
    const innerBlock = `let ${innerRes}: Result<(), ${errTy}> = ${innerLbl}: {\n${indent(`${tryLines}\nOk(())`)}\n};`;
    let matchStmt: string;
    if (stmt.discriminant) {
      const binder = stmt.catchParam ? rid(stmt.catchParam) : "e";
      const arms = stmt.discriminant
        .map((arm) => indent(indent(emitCatchArm(arm, binder))))
        .join("\n");
      matchStmt = [
        `match ${innerRes} {`,
        `${INDENT}Ok(_) => {}`,
        `${INDENT}Err(${binder}) => {`,
        `${INDENT}${INDENT}match ${binder} {`,
        arms,
        `${INDENT}${INDENT}}`,
        `${INDENT}}`,
        `}`,
      ].join("\n");
    } else {
      const binder = stmt.catchParam ? rid(stmt.catchParam) : "_";
      matchStmt = [
        `match ${innerRes} {`,
        `${INDENT}Ok(_) => {}`,
        `${INDENT}Err(${binder}) => ${block(stmt.catchBody ?? [])}`,
        `}`,
      ].join("\n");
    }
    // Fall-through yields `Ctrl::Normal`; when neither arm can complete normally
    // the tail is unreachable (both paths `break` the carrier) — `unreachable!()`
    // so the block unifies to `Ctrl` rather than the match's `()`.
    const tail = stmt.tryFallsThrough ? `\n${ctrl}::Normal` : "\nunreachable!()";
    inner = `${lbl}: {\n${indent(`${innerBlock}\n${matchStmt}${tail}`)}\n}`;
  }
  const bind = `let ${resVar}: ${ctrl} = ${inner};`;

  // The `finally` body runs natively, once, before the dispatch.
  const fin = stmt.finallyBody.map(emitStmt).join("\n");

  const parts: string[] = [enumItem];
  if (breakTargetItem) parts.push(breakTargetItem);
  parts.push(bind);
  if (fin.length > 0) parts.push(fin);

  // The dispatch replays the recorded escape (suppressed when a self-escaping
  // `finally` already pre-empted it).
  if (!stmt.dispatchDead) parts.push(emitCarrierDispatch(stmt, resVar));
  return parts.join("\n");
}

/**
 * The dispatch `match __ctrl { … }` that replays a recorded carrier escape. When
 * `outerLabel` is set (a nested carrier), each escape is re-recorded into the outer
 * carrier (`break '<outer> Ctrl::…`) so the outer `finally` still runs, rather than
 * escaping natively.
 */
function emitCarrierDispatch(stmt: HirCarrierTry, resVar: string): string {
  const outer = stmt.outerLabel ?? null;
  const self = ctrlName(stmt.label);
  const oc = outer ? ctrlName(outer) : "";
  const obt = outer ? btName(outer) : "";
  const arms: string[] = [];
  if (stmt.hasReturn) {
    // Outermost: `return` (Ok-wrapped iff fallible). Nested: re-record into the
    // outer carrier so the outer finally runs before the eventual return.
    const ret = outer
      ? `break '${outer} ${oc}::Return(v)`
      : stmt.fallible
        ? "return Ok(v)"
        : "return v";
    arms.push(`${INDENT}${self}::Return(v) => ${ret},`);
  }
  if (stmt.hasErr) {
    const err = outer ? `break '${outer} ${oc}::Err(e)` : "return Err(e)";
    arms.push(`${INDENT}${self}::Err(e) => ${err},`);
  }
  const selfBt = btName(stmt.label);
  if (stmt.breakTargets.length > 0) {
    arms.push(
      `${INDENT}${self}::Break(t) => ${replayTargets(stmt.breakTargets, "break", selfBt, outer, oc, obt)},`,
    );
  }
  if (stmt.continueTargets.length > 0) {
    arms.push(
      `${INDENT}${self}::Continue(t) => ${replayTargets(stmt.continueTargets, "continue", selfBt, outer, oc, obt)},`,
    );
  }
  if (stmt.tryFallsThrough) arms.push(`${INDENT}${self}::Normal => {}`);
  return `match ${resVar} {\n${arms.join("\n")}\n}`;
}

/**
 * `match t { BreakTarget::X => <jump>, … }` replaying a break/continue target.
 * Outermost: a native `break 'x` / `break`. Nested (`outer` set): re-record into
 * the outer carrier — `break '<outer> Ctrl::Break(BreakTarget::X)`.
 */
function replayTargets(
  targets: (string | null)[],
  kw: "break" | "continue",
  selfBt: string,
  outer: string | null,
  outerCtrl: string,
  outerBt: string,
): string {
  const ctrlKind = kw === "break" ? "Break" : "Continue";
  const arms = targets
    .map((t) => {
      const variant = breakTargetVariant(t);
      const jump = outer
        ? `break '${outer} ${outerCtrl}::${ctrlKind}(${outerBt}::${variant})`
        : t === null
          ? `${kw}`
          : `${kw} '${t}`;
      return `${selfBt}::${variant} => ${jump},`;
    })
    .join(" ");
  return `match t { ${arms} }`;
}

/**
 * A `match` arm. A promoted integer arm is a **literal pattern** (`<pat> => …`);
 * otherwise a guarded wildcard `_ if <guard> => …`, or the bare wildcard `_`.
 */
function emitArm(arm: HirMatchArm): string {
  const head = arm.rangePat
    ? `${emitPat(arm.rangePat.lo)}..=${emitPat(arm.rangePat.hi)}`
    : arm.pats
      ? arm.pats.map(emitPat).join(" | ")
      : arm.pat
        ? emitPat(arm.pat)
        : arm.guard
          ? `_ if ${emitExpr(arm.guard)}`
          : "_";
  return `${head} => ${block(arm.body)}`;
}

/**
 * A `match`-arm literal pattern. A string is a raw `&str` literal (`"a"`), not the
 * owned `"a".to_string()` an expression emits (series 064's `s.as_str()` match);
 * numbers/others render as their expression form (an integer literal pattern).
 */
function emitPat(pat: HirExpr): string {
  if (pat.kind === "string") return JSON.stringify(pat.value);
  return emitExpr(pat);
}

/** A loop's lifetime-label prefix (`'outer: `) — series 064; empty when unlabeled. */
function loopLabel(label: string | undefined): string {
  return label ? `'${label}: ` : "";
}

/**
 * One arm of a discriminating `catch` → `match` (series 049c). A `variant` arm is
 * `AppError::<variant> { <binds>, .. }` (each read field bound owned, `..` for the
 * rest); a `wildcard` arm binds the whole error (`other => …`) or ignores it
 * (`_ => …`). The scrutinee is already the caught error binder.
 */
function emitCatchArm(arm: HirCatchArm, _binder: string): string {
  if (arm.kind === "variant") {
    const binds = arm.binds.map(rid);
    const pat =
      binds.length > 0
        ? `AppError::${rid(arm.variant)} { ${binds.join(", ")}, .. }`
        : `AppError::${rid(arm.variant)} { .. }`;
    return `${pat} => ${block(arm.body)}`;
  }
  const pat = arm.binder ? rid(arm.binder) : "_";
  return `${pat} => ${block(arm.body)}`;
}

// ── Expressions ──────────────────────────────────────────────────────────────

const BINARY_OPS: Record<string, string> = {
  "===": "==",
  "!==": "!=",
  "==": "==",
  "!=": "!=",
};

/**
 * Rust binary-operator precedence (higher binds tighter) — the table that drives
 * automatic parenthesization (series 026). Only relative ordering matters. The
 * `===`/`!==` source ops share their `==`/`!=` level. A non-binary operand is
 * atomic (effectively infinite precedence), so it never needs wrapping.
 */
const BINARY_PREC: Record<string, number> = {
  "*": 7,
  "/": 7,
  "%": 7,
  "+": 6,
  "-": 6,
  // Bitwise (series 056), placed per Rust's binding order — shifts tighter than
  // `&`, then `^`, then `|`; all below `+`/`-` and above comparisons.
  "<<": 5,
  ">>": 5,
  "&": 4.3,
  "^": 4.2,
  "|": 4.1,
  "<": 3,
  ">": 3,
  "<=": 3,
  ">=": 3,
  "==": 2,
  "!=": 2,
  "===": 2,
  "!==": 2,
  // Logical operators bind looser than comparison/equality (Rust: `&&` above
  // `||`, both below `==`). `||` at 0 coincides with the atomic fallback, which
  // is harmless — every emitted binary op is in this table.
  "&&": 1,
  "||": 0,
};

/**
 * Emit a binary operand, parenthesizing it when precedence/associativity demand
 * it. Rust binary operators are left-associative, so a same-precedence operand on
 * the **right** must be wrapped (`a - (b - c)`), while the left may stay bare
 * (`(a - b) - c` = `a - b - c`). A non-binary operand is atomic → never wrapped.
 */
function emitOperand(
  child: HirExpr,
  parentPrec: number,
  side: "l" | "r",
): string {
  const s = emitExpr(child);
  if (child.kind !== "binary") return s;
  const childPrec = BINARY_PREC[child.op] ?? 0;
  const needsParen =
    side === "l" ? childPrec < parentPrec : childPrec <= parentPrec;
  return needsParen ? `(${s})` : s;
}

/**
 * Emit the receiver of a postfix operation (`.method()`, `.field`, `[i]`, `.len()`)
 * (#66). Rust's postfix operators bind tighter than any binary/unary operator, so
 * a non-atomic receiver must be parenthesized: `Math.sqrt(x*x + y*y)` must emit
 * `(x * x + y * y).sqrt()`, not `x * x + y * y.sqrt()` (which parses as
 * `x*x + (y*y).sqrt()` and silently changes the value). A `cast`/`cond`/`ushr`
 * receiver already self-parenthesizes, and every atomic receiver passes through
 * unchanged, so wrapping never adds spurious parens.
 */
function emitReceiver(recv: HirExpr): string {
  const s = emitExpr(recv);
  const wrap =
    recv.kind === "binary" || recv.kind === "unary" || recv.kind === "assign";
  return wrap ? `(${s})` : s;
}

/**
 * An operand of a series-103a integer-domain modulo, rendered as `i64`. An integer
 * literal emits bare (`3`, not `3.0`); any other operand routes through a `cast`
 * node so the emitter's own `as`-precedence parenthesization applies (`(i as i64)`,
 * `((a + b) as i64)`).
 */
function emitI64Operand(e: HirExpr): string {
  if (e.kind === "number" && Number.isInteger(e.value)) return `${e.value}`;
  return emitExpr({ kind: "cast", expr: e, ty: { kind: "i64" } });
}

function emitExpr(expr: HirExpr): string {
  switch (expr.kind) {
    case "number":
      // A node the numeric-inference pass tagged with an integer type (`usize`
      // index/counter, or `i64` counter/discriminant) renders as a bare integer.
      // Otherwise `number` maps to `f64`: integer literals need an explicit `.0`
      // so the type is unambiguous.
      if (expr.ty === "usize" || expr.ty === "i64" || expr.ty === "i128")
        return `${expr.value}`;
      return Number.isInteger(expr.value) ? `${expr.value}.0` : `${expr.value}`;
    case "string":
      return `${JSON.stringify(expr.value)}.to_string()`;
    case "bool":
      return expr.value ? "true" : "false";
    case "ident":
      return rid(expr.name);
    case "path":
      return expr.segments.map(rid).join("::");
    case "raw":
      // A verbatim Rust snippet (series 076) — the `TNext` default in a bare
      // `gen.next()` → `resume(Default::default())`. No TS source to lower.
      return expr.text;
    case "binary": {
      // Local integer-domain modulo (series 103a): `i % 3.0` → `((i as i64) % 3) as
      // f64`. An `f64` `%` lowers to a libm `fmod` call; integer `%` (a const divisor
      // becomes a multiply-shift) is far cheaper. An integer literal operand emits
      // bare (`3`); any other operand casts through the `cast` node's parenthesization.
      if (expr.op === "%" && expr.intDomain) {
        return `(${emitI64Operand(expr.left)} % ${emitI64Operand(expr.right)}) as f64`;
      }
      const prec = BINARY_PREC[expr.op] ?? 0;
      const op = BINARY_OPS[expr.op] ?? expr.op;
      const left = emitOperand(expr.left, prec, "l");
      // Shift-count masking (series 056): JS masks the count (`& 31`); Rust panics
      // (debug) when a count ≥ bit width. Mask to the `i128` width so ordinary code
      // never panics and `1 << 130` is well-defined (matching JS's `1 << 2`).
      if (expr.bitwise && (expr.op === "<<" || expr.op === ">>")) {
        return `${left} ${op} (${emitExpr(expr.right)} & 127)`;
      }
      return `${left} ${op} ${emitOperand(expr.right, prec, "r")}`;
    }
    case "cond":
      // Ternary (series 094) → a parenthesized `if`/`else` expression. The parens
      // are unconditional: Rust rejects a bare `if`-expr as a binary-operator
      // operand (`1 + if c {…} else {…}` is a parse error). Each arm sits in the
      // block tail position, so the block's value is the arm.
      return `(if ${emitExpr(expr.test)} { ${emitExpr(expr.conseq)} } else { ${emitExpr(expr.alt)} })`;
    case "strConcat": {
      // String concatenation (series 080) → `format!("{}{}…", parts…)`. A string
      // literal part renders as a bare `&str` (`"x"`, not `"x".to_string()`); every
      // other part via `emitExpr`. `format!` borrows its args and coerces each via
      // `Display`, so there is no `Add`/borrow/ownership reasoning and a number part
      // coerces to its string form, matching JS.
      const fmt = expr.parts.map(() => "{}").join("");
      const args = expr.parts.map((p) =>
        p.kind === "string" ? JSON.stringify(p.value) : emitExpr(p),
      );
      return `format!(${JSON.stringify(fmt)}, ${args.join(", ")})`;
    }
    case "jsObjectStr":
      // A plain struct interpolated into a template (series 095) → JS
      // `String(object)` === `"[object Object]"`. The `let _ = &(…)` evaluates an
      // effectful `${…}` while borrowing (never moving) the value.
      return `{ let _ = &(${emitExpr(expr.value)}); String::from("[object Object]") }`;
    case "jsMinMax":
      // Variadic `Math.min`/`Math.max` (series 083) → the `tslib` `min!`/`max!`
      // macro (the sanctioned Tm variadic route; NaN-propagating like JS).
      return `tslib::${expr.op}!(${expr.args.map(emitExpr).join(", ")})`;
    case "ushr":
      // JS `>>>` — logical (zero-fill) shift via an unsigned round-trip, count
      // masked to the `i128` width (series 056).
      return `((${emitExpr(expr.value)} as u128) >> (${emitExpr(expr.shift)} & 127)) as i128`;
    case "cast": {
      // Rust's `as` binds tighter than any binary operator, so a non-atomic
      // operand must be parenthesized (`((a & b) as f64)`, not `a & b as f64`).
      const inner = emitExpr(expr.expr);
      const wrap =
        expr.expr.kind === "binary" ||
        expr.expr.kind === "unary" ||
        expr.expr.kind === "ushr" ||
        expr.expr.kind === "assign";
      return `(${wrap ? `(${inner})` : inner} as ${emitType(expr.ty)})`;
    }
    case "unary": {
      // A prefix unary binds tighter than any binary, so a binary/unary operand
      // needs parens (`-(a + b)`); an atomic operand does not.
      const inner = emitExpr(expr.operand);
      const wrap =
        expr.operand.kind === "binary" || expr.operand.kind === "unary";
      return `${expr.op}${wrap ? `(${inner})` : inner}`;
    }
    case "deref":
      // `(*expr)` (#70) — deref a `LazyLock` value default to its payload; always
      // parenthesized so a following `.method()` / operator binds correctly.
      return `(*${emitExpr(expr.expr)})`;
    case "assign":
      return `${emitExpr(expr.target)} ${expr.op} ${emitExpr(expr.value)}`;
    case "update": {
      // `++`/`--` in a value position (series 096) → a block-temp. Postfix yields
      // the old value (`{ let __upd = x; x += 1; __upd }`); prefix yields the new
      // (`{ x += 1; x }`). `target` is an identifier (Copy), so emitting it twice
      // has no side effect. Statement position never reaches here (it lowers to a
      // bare `assign`).
      const step = emitExpr(expr.step);
      const target = emitExpr(expr.target);
      return expr.prefix
        ? `{ ${step}; ${target} }`
        : `{ let __upd = ${target}; ${step}; __upd }`;
    }
    case "array":
      return `vec![${expr.elements.map(emitExpr).join(", ")}]`;
    case "hashmap": {
      if (expr.entries.length === 0) return "IndexMap::new()";
      const entries = expr.entries
        .map((e) => `(${emitExpr(e.key)}, ${emitExpr(e.value)})`)
        .join(", ");
      return `IndexMap::from([${entries}])`;
    }
    case "mapNew": {
      const kv = `${emitType(expr.key)}, ${emitType(expr.value)}`;
      if (!expr.init) return `IndexMap::<${kv}>::new()`;
      // Non-empty literal (series 072): keys are already `wrapKey`-wrapped.
      if (expr.init.kind === "literal") {
        const entries = expr.init.entries
          .map((e) => `(${emitExpr(e.key)}, ${emitExpr(e.value)})`)
          .join(", ");
        return `IndexMap::<${kv}>::from([${entries}])`;
      }
      // Variable/array-expression: collect its `into_iter()`, wrapping keys in a
      // `.map` closure only when the key type needs an `OrderedFloat`/newtype wrap.
      const iter = `${emitExpr(expr.init.source)}.into_iter()`;
      const mapped = expr.init.wrapKey
        ? `${iter}.map(|(k, v)| (${wrapCtor(expr.key)}(k), v))`
        : iter;
      return `${mapped}.collect::<IndexMap<${kv}>>()`;
    }
    case "setNew": {
      const t = emitType(expr.elem);
      if (!expr.init) return `IndexSet::<${t}>::new()`;
      if (expr.init.kind === "literal") {
        const elems = expr.init.elems.map(emitExpr).join(", ");
        return `IndexSet::<${t}>::from([${elems}])`;
      }
      const iter = `${emitExpr(expr.init.source)}.into_iter()`;
      const mapped = expr.init.wrapElem
        ? `${iter}.map(|x| ${wrapCtor(expr.elem)}(x))`
        : iter;
      return `${mapped}.collect::<IndexSet<${t}>>()`;
    }
    case "collectVec":
      return `${emitExpr(expr.iter)}.collect::<Vec<_>>()`;
    case "genStepTuple": {
      // `it.next()` / `it.next(v)` read as `{ value, done }` (075/076): drive the
      // generator into a `(value, done)` tuple. `Y === R` is enforced in lowering, so
      // `value` is one type. A pull-only generator (075) uses `Steppable::step`
      // (UFCS); a bidirectional one (076) uses `resume(<sent>)` — the `.next(v)` send
      // value, or `Default::default()` for a bare `.next()`.
      const driver =
        expr.sent === undefined
          ? `tslib::gen::Steppable::step(&mut ${emitExpr(expr.recv)})`
          : `(&mut ${emitExpr(expr.recv)}).resume(${
              expr.sent ? emitExpr(expr.sent) : "Default::default()"
            })`;
      return `match ${driver} { GenStep::Yield(__v) => (__v, false), GenStep::Return(__v) => (__v, true) }`;
    }
    case "genPrefixPull": {
      // `const [a, b] = g()` (075): pull a fixed-arity prefix off the generator's
      // `impl Iterator` into a tuple, bound by a tuple-destructure `let`.
      const pulls = Array.from(
        { length: expr.arity },
        () => "__it.next().unwrap()",
      ).join(", ");
      return `{ let mut __it = ${emitExpr(expr.source)}; (${pulls}) }`;
    }
    case "ref": {
      // A ref of an atomic expr needs no parens; a binary/unary/cast operand does.
      const inner = emitExpr(expr.expr);
      const wrap =
        expr.expr.kind === "binary" ||
        expr.expr.kind === "unary" ||
        expr.expr.kind === "cast";
      return `&${expr.mut ? "mut " : ""}${wrap ? `(${inner})` : inner}`;
    }
    case "structLit": {
      if (expr.fields.length === 0) return `${rid(expr.name)} {}`;
      const fields = expr.fields
        .map((f) => `${rid(f.name)}: ${emitExpr(f.value)}`)
        .join(", ");
      return `${rid(expr.name)} { ${fields} }`;
    }
    case "enumVariant": {
      // `AppError::Foo { f: v, … }` — a struct-variant construction (series 049).
      const path = `${rid(expr.enumName)}::${rid(expr.variant)}`;
      // A newtype variant (series 093, 1d): `Shape::Circle(<inner>)`.
      if (expr.newtype) return `${path}(${emitExpr(expr.newtype)})`;
      const fields = expr.fields
        .map((f) => `${rid(f.name)}: ${emitExpr(f.value)}`)
        .join(", ");
      return fields.length > 0 ? `${path} { ${fields} }` : path;
    }
    case "varPat": {
      // A union struct-variant binding pattern (series 093): `Shape::Circle { r, .. }`
      // binds the read fields (`..` for the rest); a unit variant is a bare path.
      const path = `${rid(expr.enumName)}::${rid(expr.variant)}`;
      // A newtype variant (1d): `Shape::Circle(sh)` binds the inner payload (`_` ignores).
      if (expr.newtypeBind !== undefined) {
        return `${path}(${expr.newtypeBind === "_" ? "_" : rid(expr.newtypeBind)})`;
      }
      if (!expr.struct) return path;
      const inner = [...expr.binds.map(rid), ".."].join(", ");
      return `${path} { ${inner} }`;
    }
    case "call":
      return `${ridPath(expr.callee)}(${expr.args.map(emitArg).join(", ")})`;
    case "println": {
      const args = expr.args.map(emitExpr);
      const fmt = args.map(() => "{}").join(" ");
      return args.length > 0
        ? `println!("${fmt}", ${args.join(", ")})`
        : "println!()";
    }
    case "method":
      return `${emitReceiver(expr.receiver)}.${rid(expr.name)}(${expr.args.map(emitExpr).join(", ")})`;
    // A JS-operator trait-method call over a generic `T` (series 088):
    // `left.js_add(&right)`. The arg is by-reference (`&Self`), ownership-safe.
    case "jsOp":
      return `${emitReceiver(expr.receiver)}.${expr.method}(&${emitExpr(expr.arg)})`;
    case "len":
      return `${emitReceiver(expr.object)}.${expr.chars ? "chars().count()" : "len()"}`;
    case "field":
      return `${emitReceiver(expr.object)}.${rid(expr.name)}`;
    case "index":
      return `${emitReceiver(expr.object)}[${emitIndex(expr.index)}]`;
    case "optMember":
      return `${emitReceiver(expr.receiver)}.map(|v| v.${rid(expr.field)})`;
    case "jsonStringify":
      return `tslib::json::stringify(&${emitExpr(expr.value)})`;
    case "parseJson":
      return `tslib::json::ParseResult::<${emitType(expr.target)}>::parse(&${emitExpr(expr.source)})`;
    case "rngNew":
      return `tslib::rng::Rng::new(${emitExpr(expr.seed)})`;
    case "fromJsonValue":
      // `<JsonValue expr>.0` unwraps the transparent newtype to a `serde_json::Value`.
      return `tslib::json::ParseResult::<${emitType(expr.target)}>::from_value(${emitExpr(expr.value)}.0)`;
    case "toJsonValue":
      return `tslib::json::JsonValue(serde_json::to_value(&${emitExpr(expr.value)}).expect("toJsonValue"))`;
    case "jsonParse": {
      const ty = expr.target ? emitType(expr.target) : "serde_json::Value";
      return `serde_json::from_str::<${ty}>(&${emitExpr(expr.source)}).expect("JSON.parse")`;
    }
    case "some":
      return `Some(${emitExpr(expr.value)})`;
    case "none":
      return "None";
    case "optDisplay":
      // `console.log` of an `Option<T>` (series 066): `Some(v)` → `v`'s render,
      // `None` → the literal `undefined`.
      return `tslib::truthy::fmt_opt(&${emitExpr(expr.value)})`;
    case "unwrapOpt":
      // `x!` (series 066) — explicit non-null assertion; panics on `None`.
      return `${emitExpr(expr.value)}.unwrap()`;
    case "isTruthy":
      // JS-truthiness predicate at a `bool` position (`if (x)` / `!x`, series 066).
      return `tslib::truthy::is_truthy(&${emitExpr(expr.value)})`;
    case "truthyLogical": {
      // JS `a || b` / `a && b` returning the operand *value* under falsy semantics
      // (series 066). Bind the left once, then keep/replace by its truthiness.
      const t = emitExpr(expr.left);
      const r = emitExpr(expr.right);
      return expr.op === "||"
        ? `{ let __t = ${t}; if tslib::truthy::is_truthy(&__t) { __t } else { ${r} } }`
        : `{ let __t = ${t}; if tslib::truthy::is_truthy(&__t) { ${r} } else { __t } }`;
    }
    case "ok":
      return expr.value ? `Ok(${emitExpr(expr.value)})` : "Ok(())";
    case "try":
      return `${emitExpr(expr.expr)}?`;
    case "tryBreak":
      // The `?` equivalent inside a `tryBlock` labeled block (063): unwrap `Ok`, or
      // `break` the block with the error. Under a 073 carrier the error breaks with
      // `Ctrl::Err(__e)` instead of a bare `Err(__e)`.
      return expr.carrier
        ? `match ${emitExpr(expr.expr)} { Ok(__v) => __v, Err(__e) => break '${expr.label} ${ctrlName(expr.label)}::Err(__e) }`
        : `match ${emitExpr(expr.expr)} { Ok(__v) => __v, Err(__e) => break '${expr.label} Err(__e) }`;
    case "boxNew":
      return `Box::new(${emitExpr(expr.value)})`;
    case "await":
      return `${emitExpr(expr.expr)}.await`;
    case "tuple":
      return `(${expr.elems.map(emitExpr).join(", ")})`;
    case "join":
      return `tokio::join!(${expr.futures.map(emitExpr).join(", ")})`;
    case "tryJoin":
      return `tokio::try_join!(${expr.futures.map(emitExpr).join(", ")})`;
    case "select": {
      const arms = expr.futures
        .map((f) => `        res = ${emitExpr(f)} => res,`)
        .join("\n");
      return `tokio::select! {\n${arms}\n    }`;
    }
    case "closure":
      return `|${expr.params.map(rid).join(", ")}| ${emitExpr(expr.body)}`;
    case "joinAll":
      return `futures::future::join_all(${emitExpr(expr.iter)}).await`;
    case "tryJoinAll":
      return `futures::future::try_join_all(${emitExpr(expr.iter)}).await`;
    case "sleep":
      return `tokio::time::sleep(std::time::Duration::from_millis(${emitExpr(expr.ms)} as u64))`;
    case "spawn":
      return `tokio::spawn(${emitExpr(expr.expr)})`;
    case "joinHandleAwait":
      return `${emitExpr(expr.expr)}.await.unwrap()`;
    case "arcClone":
      return `std::sync::Arc::clone(&${rid(expr.name)})`;
    case "lockAccess":
      return `${emitExpr(expr.expr)}.lock().unwrap()`;
    case "asyncMove": {
      const body = expr.stmts.map((s) => indent(emitStmt(s))).join("\n");
      return `async move {\n${body}\n    }`;
    }
    case "iterMap": {
      const recv = emitExpr(expr.receiver);
      const p = rid(expr.elemParam);
      const elem = elemSingle(expr.elemMode, expr.elemParam);
      if (expr.indexParam) {
        // `(el, i)` → `.iter().enumerate().map(|(i, p)| cb(<elem>, i as f64, free…))`.
        // The `enumerate` index is `usize`; it forwards as `f64` (series 057).
        const i = rid(expr.indexParam);
        return `${recv}.iter().enumerate().map(|(${i}, ${p})| ${expr.cbName}(${elem}, ${i} as f64${emitForwarded(expr.forwarded)})).collect::<Vec<_>>()`;
      }
      return `${recv}.iter().map(|${p}| ${expr.cbName}(${elem}${emitForwarded(expr.forwarded)})).collect::<Vec<_>>()`;
    }
    case "arrayFromMap": {
      // `Array.from(src, fn)` (075). A generator source is already an iterator by
      // value (`g().map(|x| cb(x))`, no `.iter()` / no deref); an array source
      // borrows via `.iter()` and derefs the element (057's `elemSingle`).
      const src = emitExpr(expr.source);
      const p = rid(expr.elemParam);
      if (expr.fromIterator) {
        if (expr.indexParam) {
          const i = rid(expr.indexParam);
          return `${src}.enumerate().map(|(${i}, ${p})| ${expr.cbName}(${p}, ${i} as f64${emitForwarded(expr.forwarded)})).collect::<Vec<_>>()`;
        }
        return `${src}.map(|${p}| ${expr.cbName}(${p}${emitForwarded(expr.forwarded)})).collect::<Vec<_>>()`;
      }
      const elem = elemSingle(expr.elemMode, expr.elemParam);
      if (expr.indexParam) {
        const i = rid(expr.indexParam);
        return `${src}.iter().enumerate().map(|(${i}, ${p})| ${expr.cbName}(${elem}, ${i} as f64${emitForwarded(expr.forwarded)})).collect::<Vec<_>>()`;
      }
      return `${src}.iter().map(|${p}| ${expr.cbName}(${elem}${emitForwarded(expr.forwarded)})).collect::<Vec<_>>()`;
    }
    case "iterFilter": {
      // A filter predicate receives `&&T`; a Copy element derefs `**p` and the
      // terminal is `.copied()`, a non-Copy element derefs one level and clones.
      const elem = elemDouble(expr.elemMode, expr.elemParam);
      const term = expr.elemMode === "copy" ? "copied" : "cloned";
      return `${emitExpr(expr.receiver)}.iter().filter(|${rid(expr.elemParam)}| ${expr.cbName}(${elem}${emitForwarded(expr.forwarded)})).${term}().collect::<Vec<_>>()`;
    }
    case "iterFlatMap": {
      // `.flat_map(cb)` — the lifted `cb` returns a `Vec<U>`; `flat_map` flattens
      // one level, so the collected result is `Vec<U>` (series 085). Same element
      // shim as `iterMap` (`.iter()` borrow, `elemSingle` deref).
      const recv = emitExpr(expr.receiver);
      const p = rid(expr.elemParam);
      const elem = elemSingle(expr.elemMode, expr.elemParam);
      return `${recv}.iter().flat_map(|${p}| ${expr.cbName}(${elem}${emitForwarded(expr.forwarded)})).collect::<Vec<_>>()`;
    }
    case "objectKeys":
      return `${emitExpr(expr.map)}.keys().cloned().collect::<Vec<_>>()`;
    case "objectValues":
      return `${emitExpr(expr.map)}.values().cloned().collect::<Vec<_>>()`;
    case "objectEntries":
      return `${emitExpr(expr.map)}.iter().map(|(k, v)| (k.clone(), v.clone())).collect::<Vec<_>>()`;
    case "tupleField":
      return `${emitExpr(expr.tuple)}.${expr.index}`;
    case "mapBuild": {
      const seed = expr.base ? emitExpr(expr.base) : "IndexMap::new()";
      const steps = expr.parts.map((p) =>
        p.kind === "spread"
          ? `__o.extend(${emitExpr(p.expr)}.clone());`
          : `__o.insert(${emitExpr(p.key)}, ${emitExpr(p.value)});`,
      );
      return `{ let mut __o = ${seed}; ${steps.join(" ")} __o }`;
    }
    case "iterFind": {
      const elem = elemDouble(expr.elemMode, expr.elemParam);
      const term = expr.elemMode === "copy" ? "copied" : "cloned";
      return `${emitExpr(expr.receiver)}.iter().find(|${rid(expr.elemParam)}| ${expr.cbName}(${elem}${emitForwarded(expr.forwarded)})).${term}()`;
    }
    case "iterAny":
      return `${emitExpr(expr.receiver)}.iter().any(|${rid(expr.elemParam)}| ${expr.cbName}(${elemSingle(expr.elemMode, expr.elemParam)}${emitForwarded(expr.forwarded)}))`;
    case "iterAll":
      return `${emitExpr(expr.receiver)}.iter().all(|${rid(expr.elemParam)}| ${expr.cbName}(${elemSingle(expr.elemMode, expr.elemParam)}${emitForwarded(expr.forwarded)}))`;
    case "iterReduce":
      return `${emitExpr(expr.receiver)}.iter().fold(${emitExpr(expr.init)}, |${rid(expr.acc)}, ${rid(expr.elem)}| ${expr.cbName}(${rid(expr.acc)}, *${rid(expr.elem)}${emitForwarded(expr.forwarded)}))`;
    case "iterSortDefault":
      return `tslib::array::sort_default(&mut ${emitExpr(expr.receiver)})`;
    case "iterSortBy":
      return `tslib::array::sort_by(&mut ${emitExpr(expr.receiver)}, |${rid(expr.a)}, ${rid(expr.b)}| ${expr.cbName}(${rid(expr.a)}, ${rid(expr.b)}${emitForwarded(expr.forwarded)}))`;
    case "rcNew":
      return `Rc::new(RefCell::new(${emitExpr(expr.inner)}))`;
    case "rcClone":
      return `Rc::clone(&${emitExpr(expr.expr)})`;
    case "bumpNew":
      return "bumpalo::Bump::new()";
    case "bumpVec":
      return `bumpalo::vec![in &${rid(expr.arena)}; ${expr.elements.map(emitExpr).join(", ")}]`;
    case "bumpString":
      return `bumpalo::collections::String::from_str_in(${JSON.stringify(expr.value)}, &${rid(expr.arena)})`;
  }
}

/**
 * Render the forwarded read-only free-variable arguments of a lifted callback
 * shim (series 048): each prefixed with `, ` so it appends cleanly after the
 * element argument. An empty list renders nothing — `cbName(*x)`, not `cbName(*x, )`.
 */
function emitForwarded(forwarded: HirExpr[]): string {
  return forwarded.map((e) => `, ${emitExpr(e)}`).join("");
}

/**
 * The element argument for a `map`/`some`/`every` shim (series 057), whose closure
 * param `p` is `&T`: a Copy element derefs (`*p`, series 048), a read-only non-Copy
 * forwards the borrow (`p`), a consumed non-Copy clones (`p.clone()`).
 */
function elemSingle(mode: ElemMode, name: string): string {
  const p = rid(name);
  return mode === "copy" ? `*${p}` : mode === "clone" ? `${p}.clone()` : p;
}

/**
 * The element argument for a `filter`/`find` shim (series 057), whose closure param
 * `p` is `&&T`: Copy derefs both levels (`**p`), a read-only non-Copy derefs one
 * (`*p` → `&T`), a consumed non-Copy clones through the deref (`(*p).clone()`).
 */
function elemDouble(mode: ElemMode, name: string): string {
  const p = rid(name);
  return mode === "copy"
    ? `**${p}`
    : mode === "clone"
      ? `(*${p}).clone()`
      : `*${p}`;
}

function emitArg(arg: HirArg): string {
  const inner = emitExpr(arg.expr);
  if (arg.borrow === "ref") return `&${inner}`;
  if (arg.borrow === "refMut") return `&mut ${inner}`;
  return inner;
}

/**
 * The index inside `obj[...]`. A `Vec` index is `usize`: a literal integer is
 * unambiguously so and skips the `f64` `.0` suffix (variable indices need the
 * numeric-inference pass). An `IndexMap<String, _>` lookup wants `&str`, so a
 * string-literal key renders bare (`map["a"]`), never `"a".to_string()`
 * (`String` is not a valid index — `Index<&Q>` takes a borrow).
 */
function emitIndex(index: HirExpr): string {
  if (index.kind === "number" && Number.isInteger(index.value)) {
    return `${index.value}`;
  }
  if (index.kind === "string") return JSON.stringify(index.value);
  return emitExpr(index);
}

// ── Types ────────────────────────────────────────────────────────────────────

function emitType(ty: RustType): string {
  switch (ty.kind) {
    case "f64":
      return "f64";
    case "usize":
      return "usize";
    case "i64":
      return "i64";
    case "i128":
      return "i128";
    case "String":
      return "String";
    case "str":
      return "str";
    case "bool":
      return "bool";
    case "unit":
      return "()";
    case "vec":
      return `Vec<${emitType(ty.elem)}>`;
    case "option":
      return `Option<${emitType(ty.inner)}>`;
    case "hashmap":
      return `IndexMap<${emitType(ty.key)}, ${emitType(ty.value)}>`;
    case "set":
      return `IndexSet<${emitType(ty.elem)}>`;
    case "orderedFloat":
      return "OrderedFloat<f64>";
    case "struct":
      return ty.args && ty.args.length > 0
        ? `${rid(ty.name)}<${ty.args.map(emitType).join(", ")}>`
        : rid(ty.name);
    case "structKey":
      return structKeyRustName(ty.name);
    case "result":
      return `Result<${emitType(ty.ok)}, ${emitType(ty.err)}>`;
    case "appError":
      return "AppError";
    case "rc":
      return `Rc<RefCell<${emitType(ty.inner)}>>`;
    case "implIterator":
      return `impl Iterator<Item = ${emitType(ty.item)}>`;
    case "fnPtr": {
      const params = ty.params.map(emitType).join(", ");
      const ret = ty.ret.kind === "unit" ? "" : ` -> ${emitType(ty.ret)}`;
      return `fn(${params})${ret}`;
    }
    case "ref":
      return `&${ty.mut ? "mut " : ""}${emitType(ty.inner)}`;
    case "dyn":
      return `dyn ${rid(ty.trait)}`;
    case "implTrait":
      return `impl ${rid(ty.trait)}`;
    case "box":
      return `Box<${emitType(ty.inner)}>`;
    case "arc":
      return ty.mutex
        ? `std::sync::Arc<std::sync::Mutex<${emitType(ty.inner)}>>`
        : `std::sync::Arc<${emitType(ty.inner)}>`;
    case "param":
      return rid(ty.name);
    case "jsonValue":
      return "tslib::json::JsonValue";
  }
}
