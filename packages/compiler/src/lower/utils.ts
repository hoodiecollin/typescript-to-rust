/**
 * Pure, leaf helpers shared across the `lower/` modules (series 109).
 *
 * Everything here is dependency-free within lowering: small functions over `ast`
 * nodes, `hir` nodes, `RustType`s, strings, and sets, calling nothing that lives
 * in a sibling `lower/` module. This is the bottom of the folder-module's internal
 * import graph — siblings import from here, it imports from none of them.
 */

import type {
  BlockStatement,
  Expression,
  Identifier,
  Literal,
  Statement,
} from "../ast";
import type { HirExpr, RustType } from "../hir";

// ── strings ──────────────────────────────────────────────────────────────────

/** A short deterministic FNV-1a hash (base-36). */
export function shortHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Uppercase the first ASCII letter (`range` → `Range`) for a struct name. */
export function capitalizeAscii(s: string): string {
  return s.length === 0 ? s : (s[0] as string).toUpperCase() + s.slice(1);
}

/** Render a JS string as a Rust double-quoted string literal (escaped). */
export function rustStrLit(s: string): string {
  return (
    '"' +
    s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t") +
    '"'
  );
}

// ── sets ─────────────────────────────────────────────────────────────────────

/** Structural equality of two string sets. */
export function setEq(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** A fresh set with a size-tagged marker added (recursion-cycle guard). */
export function addSeen(seen: Set<string>, tag: string): Set<string> {
  return new Set(seen).add(`${tag}#${seen.size}`);
}

// ── ast nodes ────────────────────────────────────────────────────────────────

/** Wrap an expression in an `ExpressionStatement`. */
export function exprStmt(e: Expression): Statement {
  return { type: "ExpressionStatement", expression: e } as unknown as Statement;
}

/** A statement's contained statement list (`{ … }` body, or a single statement). */
export function blockBody(s: Statement): Statement[] {
  return s.type === "BlockStatement" ? (s as BlockStatement).body : [s];
}

/** A runtime AST-node guard (`{ type: string, … }`). */
export function isAstNode(
  x: unknown,
): x is { type: string; [k: string]: unknown } {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as { type?: unknown }).type === "string"
  );
}

/** Peel a trailing `!` (`TSNonNullExpression`) off an expression. */
export function peelNonNull(e: Expression): Expression {
  return e.type === "TSNonNullExpression"
    ? (e as unknown as { expression: Expression }).expression
    : e;
}

/** Whether `expr` is the literal `undefined` or `null`. */
export function isNullishExpr(expr: Expression): boolean {
  if (expr.type === "Identifier")
    return (expr as Identifier).name === "undefined";
  if (expr.type === "Literal") return (expr as Literal).value === null;
  return false;
}

// ── RustType / HIR ───────────────────────────────────────────────────────────

/** Wrap an ok-type in `Result<ok, err>`. */
export function resultType(ok: RustType, err: RustType): RustType {
  return { kind: "result", ok, err };
}

/** A Copy scalar payload (#70) needs no `Rc` wrapper around a value default. */
export function isScalarType(t: RustType): boolean {
  return (
    t.kind === "f64" ||
    t.kind === "i64" ||
    t.kind === "i128" ||
    t.kind === "usize" ||
    t.kind === "bool"
  );
}

/** Shallow-structural `RustType` equality (recurses into `vec` elements). */
export function sameRustType(a: RustType, b: RustType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "vec" && b.kind === "vec") return sameRustType(a.elem, b.elem);
  return true;
}

/** Is a `RustType` a `Copy` scalar (forwardable by value into a lifted fn)? */
export function isCopyRustType(ty: RustType): boolean {
  return (
    ty.kind === "f64" ||
    ty.kind === "usize" ||
    ty.kind === "i64" ||
    ty.kind === "bool" ||
    ty.kind === "fnPtr"
  );
}

/** `&expr` — an explicit shared borrow at a call site (series 061). */
export function refExpr(expr: HirExpr): HirExpr {
  return { kind: "ref", mut: false, expr };
}
