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
} from "./derives";
import type {
  ElemMode,
  HirArg,
  HirCatchArm,
  HirClass,
  HirEnum,
  HirErrorEnum,
  HirExpr,
  HirFn,
  HirGenerator,
  HirItem,
  HirMatchArm,
  HirModule,
  HirStmt,
  HirStruct,
  HirTrait,
  RustType,
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
export function emit(program: Program): string {
  return emitModule(lower(program));
}

/** Emit a complete Rust module from already-lowered HIR. */
export function emitModule(mod: HirModule): string {
  // A struct table (interface + class field shapes) drives on-demand trait
  // derivation (`derives.ts`); threaded through item emission.
  const structs = buildStructTable(mod.items);
  // Generated structs derive serde traits only when the module uses JSON (045).
  const usesJson = usesKind(mod, "jsonStringify") || usesKind(mod, "jsonParse");
  const parts = mod.items.map((item) => emitItem(item, structs, usesJson));
  if (mod.main.length > 0) {
    const body = mod.main.map((s) => indent(emitStmt(s))).join("\n");
    // A fallible script makes `main` return `Result<(), String>` (its trailing
    // `Ok(())` is already in `mod.main`, added by lowering); else a bare `main`.
    const ret = mod.mainRet ? ` -> ${emitType(mod.mainRet)}` : "";
    // A script that `await`s needs an async runtime: `#[tokio::main] async fn main`.
    const attr = mod.mainAsync ? "#[tokio::main]\n" : "";
    const asyncKw = mod.mainAsync ? "async " : "";
    parts.push(`${attr}${asyncKw}fn main()${ret} {\n${body}\n}`);
  }
  // Std imports, deep-scanned from the HIR (the emitter is the sole producer of
  // each, so each scan is exact). `Rc`/`RefCell` travel together (`"use rc"`).
  const imports: string[] = [];
  // `Record`/object types are backed by `IndexMap` (series 041) so key/value
  // iteration matches JS's insertion order (`HashMap` does not preserve it).
  if (usesKind(mod, "hashmap") || usesKind(mod, "mapBuild"))
    imports.push("use indexmap::IndexMap;");
  if (
    usesKind(mod, "rc") ||
    usesKind(mod, "rcNew") ||
    usesKind(mod, "rcClone")
  ) {
    imports.push("use std::rc::Rc;", "use std::cell::RefCell;");
  }
  const prelude = imports.length > 0 ? `${imports.join("\n")}\n\n` : "";
  return `${prelude}${parts.join("\n\n")}\n`;
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
    case "class":
      return emitClass(item, structs, usesJson);
    case "errorEnum":
      return emitErrorEnum(item);
    case "enum":
      return emitEnum(item);
    case "trait":
      return emitTrait(item);
    case "generator":
      return emitGenerator(item);
  }
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

  // 1. struct — `state: u32` first, then owned params, then across-yield locals.
  const fieldLines = [
    `${INDENT}state: u32,`,
    ...g.params.map((p) => `${INDENT}${rid(p.name)}: ${emitType(p.ty)},`),
    ...g.localFields.map((f) => `${INDENT}${rid(f.name)}: ${emitType(f.ty)},`),
  ].join("\n");
  const struct = `struct ${sname} {\n${fieldLines}\n}`;

  // 2. impl New — params move in (field-init shorthand); locals default-seeded.
  const ctorParams = g.params
    .map((p) => `${rid(p.name)}: ${emitType(p.ty)}`)
    .join(", ");
  const ctorInits = [
    "state: 0",
    ...g.params.map((p) => rid(p.name)),
    ...g.localFields.map((f) => `${rid(f.name)}: Default::default()`),
  ].join(", ");
  const newFn = [
    `impl ${sname} {`,
    `${INDENT}fn new(${ctorParams}) -> Self {`,
    `${INDENT}${INDENT}${sname} { ${ctorInits} }`,
    `${INDENT}}`,
    `}`,
  ].join("\n");

  // 3. impl Iterator — the `loop { match self.state { … } }` driver.
  const arms = g.states
    .map((s) => {
      const body = s.body.map((st) => indent(indent(emitStmt(st)))).join("\n");
      return `${INDENT}${INDENT}${INDENT}${s.id} => {\n${body}\n${INDENT}${INDENT}${INDENT}}`;
    })
    .join("\n");
  const iter = [
    `impl Iterator for ${sname} {`,
    `${INDENT}type Item = ${itemTy};`,
    `${INDENT}fn next(&mut self) -> Option<${itemTy}> {`,
    `${INDENT}${INDENT}loop {`,
    `${INDENT}${INDENT}${INDENT}match self.state {`,
    arms,
    `${INDENT}${INDENT}${INDENT}${INDENT}_ => return None,`,
    `${INDENT}${INDENT}${INDENT}}`,
    `${INDENT}${INDENT}}`,
    `${INDENT}}`,
    `}`,
  ].join("\n");

  // 4. wrapper fn — the unchanged public `impl Iterator` surface.
  const wrapArgs = g.params.map((p) => rid(p.name)).join(", ");
  const wrapper = `fn ${rid(g.name)}(${ctorParams}) -> impl Iterator<Item = ${itemTy}> { ${sname}::new(${wrapArgs}) }`;

  return [struct, newFn, iter, wrapper].join("\n\n");
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

/** A function signature (no body) — `[async ]fn name(&self, …)[ -> R]`. */
function emitFnSig(fn: HirFn): string {
  const asyncKw = fn.isAsync ? "async " : "";
  const self =
    fn.recv === "refMut" ? ["&mut self"] : fn.recv === "ref" ? ["&self"] : [];
  const rest = fn.params.map(
    (p) => `${p.pat ?? rid(p.name)}: ${emitType(p.ty)}`,
  );
  const params = [...self, ...rest].join(", ");
  const ret = fn.ret.kind === "unit" ? "" : ` -> ${emitType(fn.ret)}`;
  return `${asyncKw}fn ${rid(fn.name)}(${params})${ret}`;
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
  return `#[derive(Clone, Copy, PartialEq)]\nenum ${rid(e.name)} {\n${variants}\n}`;
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

/** A `class` → its `struct` definition, an `impl` block, and (if any) `Drop`. */
function emitClass(
  c: HirClass,
  structs: StructTable,
  usesJson: boolean,
): string {
  const struct = emitStruct(
    { kind: "struct", name: c.name, fields: c.fields },
    structs,
    usesJson,
  );
  // Class inheritance (series 053): trait methods (an override or a forwarder,
  // named in `overrides`) go in the `impl IA for Name` block, *not* the inherent
  // `impl` — else a duplicate definition. The inherent impl keeps `new` + any
  // non-trait method.
  const inherent = c.methods.filter((m) => !c.overrides?.has(m.name));
  const fns = [c.ctor, ...inherent].filter((f): f is HirFn => f !== null);
  const body = fns.map((f) => indent(emitFn(f))).join("\n");
  const parts = [`${struct}\n\nimpl ${rid(c.name)} {\n${body}\n}`];
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
  const decl =
    s.fields.length === 0
      ? `${derive}struct ${rid(s.name)} {}`
      : `${derive}struct ${rid(s.name)} {\n${s.fields
          .map((f) => indent(`${rid(f.name)}: ${emitType(f.ty)},`))
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
  return [decl, ...impls].join("\n\n");
}

function emitFn(fn: HirFn): string {
  const asyncKw = fn.isAsync ? "async " : "";
  // A method's `self` receiver leads the parameter list; free/associated fns omit it.
  const self =
    fn.recv === "refMut" ? ["&mut self"] : fn.recv === "ref" ? ["&self"] : [];
  const rest = fn.params.map(
    (p) => `${p.pat ?? rid(p.name)}: ${emitType(p.ty)}`,
  );
  const params = [...self, ...rest].join(", ");
  const ret = fn.ret.kind === "unit" ? "" : ` -> ${emitType(fn.ret)}`;
  return `${asyncKw}fn ${rid(fn.name)}(${params})${ret} ${block(fn.body)}`;
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
    case "forRange": {
      const dots = stmt.inclusive ? "..=" : "..";
      let range = `${emitExpr(stmt.start)}${dots}${emitExpr(stmt.end)}`;
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
      // yielded value back to the caller.
      return `self.state = ${stmt.resumeState};\nreturn Some(${emitExpr(stmt.value)});`;
    case "gotoState":
      // A straight-through generator transition (052) — the enclosing
      // `loop { match self.state { … } }` re-enters the target arm.
      return `self.state = ${stmt.state};`;
    case "genDone":
      // The generator's terminal transition (052): park in the exhausted state
      // and return `None` (every later `next()` also returns `None`).
      return `self.state = ${stmt.terminal};\nreturn None;`;
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
  }
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
    case "binary": {
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
    case "assign":
      return `${emitExpr(expr.target)} ${expr.op} ${emitExpr(expr.value)}`;
    case "array":
      return `vec![${expr.elements.map(emitExpr).join(", ")}]`;
    case "hashmap": {
      if (expr.entries.length === 0) return "IndexMap::new()";
      const entries = expr.entries
        .map((e) => `(${emitExpr(e.key)}, ${emitExpr(e.value)})`)
        .join(", ");
      return `IndexMap::from([${entries}])`;
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
      const fields = expr.fields
        .map((f) => `${rid(f.name)}: ${emitExpr(f.value)}`)
        .join(", ");
      const path = `${rid(expr.enumName)}::${rid(expr.variant)}`;
      return fields.length > 0 ? `${path} { ${fields} }` : path;
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
      return `${emitExpr(expr.receiver)}.${rid(expr.name)}(${expr.args.map(emitExpr).join(", ")})`;
    case "len":
      return `${emitExpr(expr.object)}.len()`;
    case "field":
      return `${emitExpr(expr.object)}.${rid(expr.name)}`;
    case "index":
      return `${emitExpr(expr.object)}[${emitIndex(expr.index)}]`;
    case "optMember":
      return `${emitExpr(expr.receiver)}.map(|v| v.${rid(expr.field)})`;
    case "jsonStringify":
      return `tslib::json::stringify(&${emitExpr(expr.value)})`;
    case "jsonParse": {
      const ty = expr.target ? emitType(expr.target) : "serde_json::Value";
      return `serde_json::from_str::<${ty}>(&${emitExpr(expr.source)}).expect("JSON.parse")`;
    }
    case "some":
      return `Some(${emitExpr(expr.value)})`;
    case "none":
      return "None";
    case "ok":
      return expr.value ? `Ok(${emitExpr(expr.value)})` : "Ok(())";
    case "try":
      return `${emitExpr(expr.expr)}?`;
    case "boxNew":
      return `Box::new(${emitExpr(expr.value)})`;
    case "await":
      return `${emitExpr(expr.expr)}.await`;
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
    case "iterFilter": {
      // A filter predicate receives `&&T`; a Copy element derefs `**p` and the
      // terminal is `.copied()`, a non-Copy element derefs one level and clones.
      const elem = elemDouble(expr.elemMode, expr.elemParam);
      const term = expr.elemMode === "copy" ? "copied" : "cloned";
      return `${emitExpr(expr.receiver)}.iter().filter(|${rid(expr.elemParam)}| ${expr.cbName}(${elem}${emitForwarded(expr.forwarded)})).${term}().collect::<Vec<_>>()`;
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
    case "struct":
      return rid(ty.name);
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
  }
}
