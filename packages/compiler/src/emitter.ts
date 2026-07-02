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
  HirExpr,
  HirFn,
  HirModule,
  HirStmt,
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
  const parts = mod.items.map(emitFn);
  if (mod.main.length > 0) {
    const body = mod.main.map((s) => indent(emitStmt(s))).join("\n");
    parts.push(`fn main() {\n${body}\n}`);
  }
  return `${parts.join("\n\n")}\n`;
}

// ── Items ────────────────────────────────────────────────────────────────────

function emitFn(fn: HirFn): string {
  const asyncKw = fn.isAsync ? "async " : "";
  const params = fn.params
    .map((p) => `${p.name}: ${emitType(p.ty)}`)
    .join(", ");
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
      const head = `if ${emitExpr(stmt.cond)} ${block(stmt.then)}`;
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
  }
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
  }
}

function emitArg(arg: HirArg): string {
  const inner = emitExpr(arg.expr);
  if (arg.borrow === "ref") return `&${inner}`;
  if (arg.borrow === "refMut") return `&mut ${inner}`;
  return inner;
}

/**
 * A Rust index is always `usize`. A literal integer index is unambiguously so
 * and must skip the `f64` `.0` suffix. (Variable indices need the numeric-
 * inference pass; `arr[i]` with `i: f64` will not compile — the correct RED.)
 */
function emitIndex(index: HirExpr): string {
  if (index.kind === "number" && Number.isInteger(index.value)) {
    return `${index.value}`;
  }
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
    case "ref":
      return `&${ty.mut ? "mut " : ""}${emitType(ty.inner)}`;
  }
}
