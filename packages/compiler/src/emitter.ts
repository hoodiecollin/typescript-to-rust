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
import type {
  HirArg,
  HirClass,
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

/**
 * Emit a complete Rust module for `program`.
 * @throws {UnsupportedError} on any construct outside the implemented dialect.
 */
export function emit(program: Program): string {
  return emitModule(lower(program));
}

/** Emit a complete Rust module from already-lowered HIR. */
export function emitModule(mod: HirModule): string {
  const parts = mod.items.map(emitItem);
  if (mod.main.length > 0) {
    const body = mod.main.map((s) => indent(emitStmt(s))).join("\n");
    // A fallible script makes `main` return `Result<(), String>` (its trailing
    // `Ok(())` is already in `mod.main`, added by lowering); else a bare `main`.
    const ret = mod.mainRet ? ` -> ${emitType(mod.mainRet)}` : "";
    parts.push(`fn main()${ret} {\n${body}\n}`);
  }
  const prelude = usesHashMap(mod) ? "use std::collections::HashMap;\n\n" : "";
  return `${prelude}${parts.join("\n\n")}\n`;
}

/**
 * Does the module use a `HashMap` anywhere (a `hashmap` `RustType` or `HirExpr`)?
 * A generic deep-scan — every HIR node is a plain object tagged with `kind`, so
 * finding any `kind: "hashmap"` tells us to prepend the std import. The emitter is
 * the sole producer of `HashMap`, so this is exact.
 */
function usesHashMap(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(usesHashMap);
  if (node !== null && typeof node === "object") {
    if ((node as { kind?: string }).kind === "hashmap") return true;
    return Object.values(node).some(usesHashMap);
  }
  return false;
}

// ── Items ────────────────────────────────────────────────────────────────────

function emitItem(item: HirItem): string {
  switch (item.kind) {
    case "fn":
      return emitFn(item);
    case "struct":
      return emitStruct(item);
    case "class":
      return emitClass(item);
  }
}

/** A `class` → its `struct` definition followed by an `impl` block. */
function emitClass(c: HirClass): string {
  const struct = emitStruct({ kind: "struct", name: c.name, fields: c.fields });
  const fns = [c.ctor, ...c.methods].filter((f): f is HirFn => f !== null);
  const body = fns.map((f) => indent(emitFn(f))).join("\n");
  return `${struct}\n\nimpl ${c.name} {\n${body}\n}`;
}

/** `struct Name {\n    field: Ty,\n …\n}` (or `Name {}` when field-less). */
function emitStruct(s: HirStruct): string {
  if (s.fields.length === 0) return `struct ${s.name} {}`;
  const fields = s.fields
    .map((f) => indent(`${f.name}: ${emitType(f.ty)},`))
    .join("\n");
  return `struct ${s.name} {\n${fields}\n}`;
}

function emitFn(fn: HirFn): string {
  const asyncKw = fn.isAsync ? "async " : "";
  // A method's `self` receiver leads the parameter list; free/associated fns omit it.
  const self = fn.recv === "refMut" ? ["&mut self"] : fn.recv === "ref" ? ["&self"] : [];
  const rest = fn.params.map((p) => `${p.name}: ${emitType(p.ty)}`);
  const params = [...self, ...rest].join(", ");
  const ret = fn.ret.kind === "unit" ? "" : ` -> ${emitType(fn.ret)}`;
  return `${asyncKw}fn ${fn.name}(${params})${ret} ${block(fn.body)}`;
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
      return `let ${mut}${stmt.name}${ty} = ${emitExpr(stmt.init)};`;
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
      return `for ${stmt.pat} in ${emitExpr(stmt.iter)} ${block(stmt.body)}`;
    case "match": {
      const arms = stmt.arms.map((arm) => indent(emitArm(arm))).join("\n");
      return `match ${emitExpr(stmt.disc)} {\n${arms}\n}`;
    }
    case "break":
      return "break;";
    case "continue":
      return "continue;";
    case "throw":
      // A `throw` in the dialect is a propagated error: `return Err(msg);`.
      return `return Err(${emitExpr(stmt.value)});`;
  }
}

/** A `match` arm: `_ if <guard> => { … }`, or `_ => { … }` for the wildcard. */
function emitArm(arm: HirMatchArm): string {
  const head = arm.guard ? `_ if ${emitExpr(arm.guard)}` : "_";
  return `${head} => ${block(arm.body)}`;
}

// ── Expressions ──────────────────────────────────────────────────────────────

const BINARY_OPS: Record<string, string> = {
  "===": "==",
  "!==": "!=",
  "==": "==",
  "!=": "!=",
};

function emitExpr(expr: HirExpr): string {
  switch (expr.kind) {
    case "number":
      // A node the numeric-inference pass tagged `usize` (an index/counter)
      // renders as a bare integer. Otherwise `number` maps to `f64`: integer
      // literals need an explicit `.0` so the type is unambiguous.
      if (expr.ty === "usize") return `${expr.value}`;
      return Number.isInteger(expr.value) ? `${expr.value}.0` : `${expr.value}`;
    case "string":
      return `${JSON.stringify(expr.value)}.to_string()`;
    case "bool":
      return expr.value ? "true" : "false";
    case "ident":
      return expr.name;
    case "binary":
      return `${emitExpr(expr.left)} ${BINARY_OPS[expr.op] ?? expr.op} ${emitExpr(expr.right)}`;
    case "assign":
      return `${emitExpr(expr.target)} ${expr.op} ${emitExpr(expr.value)}`;
    case "array":
      return `vec![${expr.elements.map(emitExpr).join(", ")}]`;
    case "hashmap": {
      if (expr.entries.length === 0) return "HashMap::new()";
      const entries = expr.entries
        .map((e) => `(${emitExpr(e.key)}, ${emitExpr(e.value)})`)
        .join(", ");
      return `HashMap::from([${entries}])`;
    }
    case "structLit": {
      if (expr.fields.length === 0) return `${expr.name} {}`;
      const fields = expr.fields
        .map((f) => `${f.name}: ${emitExpr(f.value)}`)
        .join(", ");
      return `${expr.name} { ${fields} }`;
    }
    case "call":
      return `${expr.callee}(${expr.args.map(emitArg).join(", ")})`;
    case "println": {
      const args = expr.args.map(emitExpr);
      const fmt = args.map(() => "{}").join(" ");
      return args.length > 0
        ? `println!("${fmt}", ${args.join(", ")})`
        : "println!()";
    }
    case "method":
      return `${emitExpr(expr.receiver)}.${expr.name}(${expr.args.map(emitExpr).join(", ")})`;
    case "len":
      return `${emitExpr(expr.object)}.len()`;
    case "field":
      return `${emitExpr(expr.object)}.${expr.name}`;
    case "index":
      return `${emitExpr(expr.object)}[${emitIndex(expr.index)}]`;
    case "ok":
      return expr.value ? `Ok(${emitExpr(expr.value)})` : "Ok(())";
    case "try":
      return `${emitExpr(expr.expr)}?`;
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
 * numeric-inference pass). A `HashMap<String, _>` lookup wants `&str`, so a
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
      return `HashMap<${emitType(ty.key)}, ${emitType(ty.value)}>`;
    case "struct":
      return ty.name;
    case "result":
      return `Result<${emitType(ty.ok)}, ${emitType(ty.err)}>`;
    case "ref":
      return `&${ty.mut ? "mut " : ""}${emitType(ty.inner)}`;
  }
}
