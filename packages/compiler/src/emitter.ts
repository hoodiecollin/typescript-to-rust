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
  HirArg,
  HirClass,
  HirEnum,
  HirErrorClass,
  HirExpr,
  HirFn,
  HirItem,
  HirMatchArm,
  HirModule,
  HirStmt,
  HirStruct,
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
  const parts = mod.items.map((item) => emitItem(item, structs));
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
  if (usesKind(mod, "hashmap")) imports.push("use indexmap::IndexMap;");
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

function emitItem(item: HirItem, structs: StructTable): string {
  switch (item.kind) {
    case "fn":
      return emitFn(item);
    case "struct":
      return emitStruct(item, structs);
    case "class":
      return emitClass(item, structs);
    case "errorClass":
      return emitErrorClass(item);
    case "enum":
      return emitEnum(item);
  }
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
 * A custom error class → `struct <Name> { message: String }`, an associated
 * `new`, and the `Display`/`Debug`/`Error` impls that make it usable as a
 * `Box<dyn std::error::Error>`. All paths are fully-qualified, so no `use`
 * prelude is needed.
 */
function emitErrorClass(e: HirErrorClass): string {
  const n = rid(e.name);
  return [
    `struct ${n} {`,
    `${INDENT}message: String,`,
    `}`,
    ``,
    `impl ${n} {`,
    `${INDENT}fn new(message: String) -> ${n} {`,
    `${INDENT}${INDENT}${n} { message }`,
    `${INDENT}}`,
    `}`,
    ``,
    `impl std::fmt::Display for ${n} {`,
    `${INDENT}fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {`,
    `${INDENT}${INDENT}write!(f, "{}", self.message)`,
    `${INDENT}}`,
    `}`,
    ``,
    `impl std::fmt::Debug for ${n} {`,
    `${INDENT}fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {`,
    `${INDENT}${INDENT}write!(f, "{}", self.message)`,
    `${INDENT}}`,
    `}`,
    ``,
    `impl std::error::Error for ${n} {}`,
  ].join("\n");
}

/** A `class` → its `struct` definition, an `impl` block, and (if any) `Drop`. */
function emitClass(c: HirClass, structs: StructTable): string {
  const struct = emitStruct(
    { kind: "struct", name: c.name, fields: c.fields },
    structs,
  );
  const fns = [c.ctor, ...c.methods].filter((f): f is HirFn => f !== null);
  const body = fns.map((f) => indent(emitFn(f))).join("\n");
  const parts = [`${struct}\n\nimpl ${rid(c.name)} {\n${body}\n}`];
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
function emitStruct(s: HirStruct, structs: StructTable): string {
  const derive = structDeriveClause(s, structs);
  if (s.fields.length === 0) return `${derive}struct ${rid(s.name)} {}`;
  const fields = s.fields
    .map((f) => indent(`${rid(f.name)}: ${emitType(f.ty)},`))
    .join("\n");
  return `${derive}struct ${rid(s.name)} {\n${fields}\n}`;
}

function emitFn(fn: HirFn): string {
  const asyncKw = fn.isAsync ? "async " : "";
  // A method's `self` receiver leads the parameter list; free/associated fns omit it.
  const self =
    fn.recv === "refMut" ? ["&mut self"] : fn.recv === "ref" ? ["&self"] : [];
  const rest = fn.params.map((p) => `${rid(p.name)}: ${emitType(p.ty)}`);
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

function emitStmt(stmt: HirStmt): string {
  switch (stmt.kind) {
    case "let": {
      const mut = stmt.mut ? "mut " : "";
      const ty = stmt.ty ? `: ${emitType(stmt.ty)}` : "";
      return `let ${mut}${rid(stmt.name)}${ty} = ${emitExpr(stmt.init)};`;
    }
    case "return":
      return stmt.value ? `return ${emitExpr(stmt.value)};` : "return;";
    case "expr":
      return `${emitExpr(stmt.expr)};`;
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
    case "while":
      return `while ${emitExpr(stmt.cond)} ${block(stmt.body)}`;
    case "block":
      // A bare scope-containing block; no trailing `;` as a statement.
      return block(stmt.body);
    case "forIn":
      return `for ${rid(stmt.pat)} in ${emitExpr(stmt.iter)} ${block(stmt.body)}`;
    case "forRange": {
      const dots = stmt.inclusive ? "..=" : "..";
      const range = `${emitExpr(stmt.start)}${dots}${emitExpr(stmt.end)}`;
      return `for ${rid(stmt.counter)} in ${range} ${block(stmt.body)}`;
    }
    case "match": {
      const arms = stmt.arms.map((arm) => indent(emitArm(arm))).join("\n");
      return `match ${emitExpr(stmt.disc)} {\n${arms}\n}`;
    }
    case "break":
      return "break;";
    case "continue":
      return "continue;";
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
      const binder = stmt.catchParam ? rid(stmt.catchParam) : "_";
      const closure = `(|| -> Result<(), ${emitType(stmt.errTy)}> ${block(stmt.tryBody)})()`;
      const head = `if let Err(${binder}) = ${closure} ${block(stmt.catchBody)}`;
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
  const head = arm.pat
    ? emitExpr(arm.pat)
    : arm.guard
      ? `_ if ${emitExpr(arm.guard)}`
      : "_";
  return `${head} => ${block(arm.body)}`;
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
      if (expr.ty === "usize" || expr.ty === "i64") return `${expr.value}`;
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
      return `${emitOperand(expr.left, prec, "l")} ${op} ${emitOperand(expr.right, prec, "r")}`;
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
    case "ok":
      return expr.value ? `Ok(${emitExpr(expr.value)})` : "Ok(())";
    case "try":
      return `${emitExpr(expr.expr)}?`;
    case "await":
      return `${emitExpr(expr.expr)}.await`;
    case "iterMap":
      return `${emitExpr(expr.receiver)}.iter().map(|&${rid(expr.param)}| ${emitExpr(expr.body)}).collect::<Vec<_>>()`;
    case "iterFilter":
      return `${emitExpr(expr.receiver)}.iter().filter(|&&${rid(expr.param)}| ${emitExpr(expr.body)}).copied().collect::<Vec<_>>()`;
    case "objectKeys":
      return `${emitExpr(expr.map)}.keys().cloned().collect::<Vec<_>>()`;
    case "objectValues":
      return `${emitExpr(expr.map)}.values().cloned().collect::<Vec<_>>()`;
    case "iterAny":
      return `${emitExpr(expr.receiver)}.iter().any(|&${rid(expr.param)}| ${emitExpr(expr.body)})`;
    case "iterAll":
      return `${emitExpr(expr.receiver)}.iter().all(|&${rid(expr.param)}| ${emitExpr(expr.body)})`;
    case "iterReduce":
      return `${emitExpr(expr.receiver)}.iter().fold(${emitExpr(expr.init)}, |${rid(expr.acc)}, &${rid(expr.elem)}| ${emitExpr(expr.body)})`;
    case "iterSortDefault":
      return `tslib::array::sort_default(&mut ${emitExpr(expr.receiver)})`;
    case "iterSortBy":
      return `tslib::array::sort_by(&mut ${emitExpr(expr.receiver)}, |${rid(expr.a)}, ${rid(expr.b)}| ${emitExpr(expr.body)})`;
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
    case "hashmap":
      return `IndexMap<${emitType(ty.key)}, ${emitType(ty.value)}>`;
    case "struct":
      return rid(ty.name);
    case "result":
      return `Result<${emitType(ty.ok)}, ${emitType(ty.err)}>`;
    case "boxError":
      return "Box<dyn std::error::Error>";
    case "rc":
      return `Rc<RefCell<${emitType(ty.inner)}>>`;
    case "implIterator":
      return `impl Iterator<Item = ${emitType(ty.item)}>`;
    case "ref":
      return `&${ty.mut ? "mut " : ""}${emitType(ty.inner)}`;
  }
}
