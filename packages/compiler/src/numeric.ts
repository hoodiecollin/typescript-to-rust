/**
 * Numeric inference: refine `number` (default `f64`) into `usize` where array
 * indexing demands it, so variable/expression indices compile.
 *
 * Rust's `Index` for `Vec<T>` requires `usize`; `f64` cannot index. This pass
 * seeds every array-index position as a *usize context*, then runs a per-scope
 * fixpoint that propagates usize-ness through `let` initializers, assignment
 * right-hand sides, and the operands of integer arithmetic (`+ - * / %`). Every
 * binding and integer literal that lands in usize context is retyped/tagged
 * `usize`; a value forced to be both `usize` and float — a fractional literal in
 * usize context, or a usize binding used in float arithmetic — is a conflict and
 * throws `UnsupportedError` (fail loud, per the dialect gate).
 *
 * Scope is name-based and per-body, matching `analysis.ts`: each function body
 * and the generated `main` refine independently. `i64` for integer-only counters
 * is a documented future addition (see docs/work). The pass is idempotent and
 * mutates the (freshly lowered) module in place.
 */

import type { HirExpr, HirModule, HirParam, HirStmt } from "./hir";
import { UnsupportedError } from "./lower";

/** Arithmetic operators that keep both operands in the same numeric type. */
const ARITHMETIC = new Set(["+", "-", "*", "/", "%"]);

export function refineNumerics(module: HirModule): HirModule {
  for (const item of module.items) {
    if (item.kind === "fn") {
      refineBody(item.params, item.body);
    } else if (item.kind === "class") {
      if (item.ctor) refineBody(item.ctor.params, item.ctor.body);
      for (const m of item.methods) refineBody(m.params, m.body);
    }
  }
  refineBody([], module.main);
  return module;
}

function refineBody(params: HirParam[], stmts: HirStmt[]): void {
  // Flatten control-flow bodies into one list of statement references so the
  // name-based fixpoint reaches indices inside `if`/`while` blocks (the shared
  // statement objects are mutated in place, so retyping still lands).
  const all = flattenStmts(stmts);
  const usize = computeUsizeNames(all);
  detectConflicts(all, usize);
  applyTypes(params, all, usize);
}

/** All statements, descending into `if`/`while` bodies (references preserved). */
function flattenStmts(stmts: HirStmt[]): HirStmt[] {
  const out: HirStmt[] = [];
  for (const stmt of stmts) {
    out.push(stmt);
    if (stmt.kind === "if") {
      out.push(...flattenStmts(stmt.conseq));
      if (stmt.alt) out.push(...flattenStmts(stmt.alt));
    } else if (
      stmt.kind === "while" ||
      stmt.kind === "block" ||
      stmt.kind === "forIn"
    ) {
      out.push(...flattenStmts(stmt.body));
    } else if (stmt.kind === "match") {
      for (const arm of stmt.arms) out.push(...flattenStmts(arm.body));
    }
  }
  return out;
}

// ── Fixpoint: which binding names must be `usize` ─────────────────────────────

function computeUsizeNames(stmts: HirStmt[]): Set<string> {
  const usize = new Set<string>();
  for (;;) {
    let changed = false;
    for (const root of usizeContextRoots(stmts, usize)) {
      markContext(root, (node) => {
        if (node.kind === "ident" && !usize.has(node.name)) {
          usize.add(node.name);
          changed = true;
        }
      });
    }
    if (!changed) return usize;
  }
}

/**
 * The expressions that sit in usize context: every array index, plus the
 * initializer / assignment RHS feeding a binding already known to be `usize`.
 */
function usizeContextRoots(stmts: HirStmt[], usize: Set<string>): HirExpr[] {
  const roots: HirExpr[] = [];
  for (const stmt of stmts) {
    eachStmtExpr(stmt, (e) => {
      if (e.kind === "index") roots.push(e.index);
      if (
        e.kind === "assign" &&
        e.target.kind === "ident" &&
        usize.has(e.target.name)
      ) {
        roots.push(e.value);
      }
    });
    if (stmt.kind === "let" && usize.has(stmt.name)) roots.push(stmt.init);
  }
  return roots;
}

/** Visit a usize-context expression and, through arithmetic, its operands. */
function markContext(expr: HirExpr, visit: (e: HirExpr) => void): void {
  visit(expr);
  if (expr.kind === "binary" && ARITHMETIC.has(expr.op)) {
    markContext(expr.left, visit);
    markContext(expr.right, visit);
  }
}

// ── Conflict detection ───────────────────────────────────────────────────────

/** A usize binding used in arithmetic with a fractional literal can't be both. */
function detectConflicts(stmts: HirStmt[], usize: Set<string>): void {
  for (const stmt of stmts) {
    eachStmtExpr(stmt, (e) => {
      if (e.kind !== "binary") return;
      const usesUsize =
        isUsizeIdent(e.left, usize) || isUsizeIdent(e.right, usize);
      const hasFraction =
        isFractionalLiteral(e.left) || isFractionalLiteral(e.right);
      if (usesUsize && hasFraction) {
        throw new UnsupportedError({
          type: "numeric conflict: a usize index value used in float arithmetic",
        });
      }
    });
  }
}

function isUsizeIdent(e: HirExpr, usize: Set<string>): boolean {
  return e.kind === "ident" && usize.has(e.name);
}

function isFractionalLiteral(e: HirExpr): boolean {
  return e.kind === "number" && !Number.isInteger(e.value);
}

// ── Apply: retype bindings and tag literals ──────────────────────────────────

function applyTypes(
  params: HirParam[],
  stmts: HirStmt[],
  usize: Set<string>,
): void {
  for (const root of usizeContextRoots(stmts, usize)) {
    markContext(root, (node) => {
      if (node.kind !== "number") return;
      if (!Number.isInteger(node.value) || node.value < 0) {
        throw new UnsupportedError({
          type: `value ${node.value} cannot be a usize index`,
        });
      }
      node.ty = "usize";
    });
  }

  for (const stmt of stmts) {
    if (stmt.kind === "let" && usize.has(stmt.name)) {
      stmt.ty = { kind: "usize" };
    }
  }
  for (const param of params) {
    if (usize.has(param.name) && param.ty.kind === "f64") {
      param.ty = { kind: "usize" };
    }
  }
}

// ── Generic HIR expression walk ──────────────────────────────────────────────

function eachStmtExpr(stmt: HirStmt, fn: (e: HirExpr) => void): void {
  switch (stmt.kind) {
    case "let":
      eachExpr(stmt.init, fn);
      break;
    case "return":
      if (stmt.value) eachExpr(stmt.value, fn);
      break;
    case "expr":
      eachExpr(stmt.expr, fn);
      break;
    // `if`/`while`/`forIn`/`block` bodies are visited via `flattenStmts`; here we
    // only surface the direct condition/iterable expression (an index may sit in
    // it, e.g. `while (arr[i])` or `for x of arr[i]`).
    case "if":
    case "while":
      eachExpr(stmt.cond, fn);
      break;
    case "forIn":
      eachExpr(stmt.iter, fn);
      break;
    case "match":
      eachExpr(stmt.disc, fn);
      for (const arm of stmt.arms) if (arm.guard) eachExpr(arm.guard, fn);
      break;
    case "throw":
      eachExpr(stmt.value, fn);
      break;
    case "block":
    case "break":
    case "continue":
      break;
  }
}

/** Call `fn` on `e` and every expression nested within it. */
function eachExpr(e: HirExpr, fn: (e: HirExpr) => void): void {
  fn(e);
  switch (e.kind) {
    case "binary":
      eachExpr(e.left, fn);
      eachExpr(e.right, fn);
      break;
    case "assign":
      eachExpr(e.target, fn);
      eachExpr(e.value, fn);
      break;
    case "call":
      for (const a of e.args) eachExpr(a.expr, fn);
      break;
    case "println":
      for (const a of e.args) eachExpr(a, fn);
      break;
    case "method":
      eachExpr(e.receiver, fn);
      for (const a of e.args) eachExpr(a, fn);
      break;
    case "index":
      eachExpr(e.object, fn);
      eachExpr(e.index, fn);
      break;
    case "field":
    case "len":
      eachExpr(e.object, fn);
      break;
    case "array":
      for (const el of e.elements) eachExpr(el, fn);
      break;
    case "hashmap":
      for (const entry of e.entries) {
        eachExpr(entry.key, fn);
        eachExpr(entry.value, fn);
      }
      break;
    case "structLit":
      for (const field of e.fields) eachExpr(field.value, fn);
      break;
    case "ok":
      if (e.value) eachExpr(e.value, fn);
      break;
    case "try":
      eachExpr(e.expr, fn);
      break;
    case "await":
      eachExpr(e.expr, fn);
      break;
    // Leaves carry no nested expressions:
    case "number":
    case "string":
    case "bool":
    case "ident":
      break;
  }
}
