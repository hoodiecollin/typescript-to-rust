/**
 * Bitwise refinement (series 056): lower JS bitwise operators onto a wide signed
 * integer type, `i128`.
 *
 * JS `number` is `f64`, but the bitwise operators coerce to 32-bit ints. Rust
 * `f64` has no bitwise operators, so we pick an integer type to emit them on. The
 * dialect deliberately does **not** reproduce JS's 32-bit `ToInt32` truncation —
 * it defines the operators over `i128` (documented divergence) and surfaces that
 * via a non-fatal warning + an inline emit note.
 *
 * This pass runs first in the refine chain (before `refineNumerics`), so its
 * boundary casts (an `i128` result used as an index / in float arithmetic) are in
 * place before the `usize` fixpoint runs. Two sub-passes per function body:
 *
 *   1. **Transform** every bitwise node: mark it `bitwise`, coerce each operand
 *      into `i128` (integer literal → tagged `i128`; anything else → an `as i128`
 *      cast), rewrite `>>>` to a `ushr` node and `~` to a bitwise `!`, fail loud on
 *      a fractional operand / negative shift count, and record the divergence
 *      warning.
 *   2. **Boundary**: forward-infer which bindings hold an `i128` result, then coerce
 *      those results back out where a non-`i128` context demands it — `as usize` at
 *      an index, `as f64` when mixed into float arithmetic — and tag integer
 *      literals that share a pure-`i128` arithmetic context (so they emit bare).
 */

import { UnsupportedError } from "./errors";
import type { HirExpr, HirModule, HirParam, HirStmt } from "./hir";

/** The bitwise binary operators (`>>>` handled specially → `ushr`). */
const BITWISE_BIN = new Set(["&", "|", "^", "<<", ">>", ">>>"]);
/** Arithmetic operators that keep both operands in one numeric type. */
const ARITHMETIC = new Set(["+", "-", "*", "/", "%"]);

const I128 = { kind: "i128" } as const;
const USIZE = { kind: "usize" } as const;
const F64 = { kind: "f64" } as const;

export function refineBitwise(module: HirModule): HirModule {
  const warnings: string[] = module.warnings ?? [];

  const bodies: { params: HirParam[]; get: () => HirStmt[]; set: (s: HirStmt[]) => void }[] = [];
  const push = (params: HirParam[], get: () => HirStmt[], set: (s: HirStmt[]) => void) =>
    bodies.push({ params, get, set });
  for (const item of module.items) {
    if (item.kind === "fn") {
      push(item.params, () => item.body, (s) => { item.body = s; });
    } else if (item.kind === "class") {
      if (item.ctor) {
        const c = item.ctor;
        push(c.params, () => c.body, (s) => { c.body = s; });
      }
      for (const m of item.methods) push(m.params, () => m.body, (s) => { m.body = s; });
    }
  }
  push([], () => module.main, (s) => { module.main = s; });

  for (const body of bodies) {
    // 1. transform bitwise nodes (mutates statement expr roots in place)
    walkStmtExprs(body.get(), (e) => transform(e, warnings));
    // 2. boundary casts, driven by which bindings now hold i128 results
    const i128names = collectI128Bindings(body.get());
    walkStmtExprs(body.get(), (e) => boundary(e, i128names));
  }

  if (warnings.length > 0) module.warnings = warnings;
  return module;
}

// ── 1. Transform ─────────────────────────────────────────────────────────────

/** Post-order rewrite: recurse into children, then rewrite this node if bitwise. */
function transform(e: HirExpr, warnings: string[]): HirExpr {
  mapChildren(e, (c) => transform(c, warnings));

  if (e.kind === "binary" && BITWISE_BIN.has(e.op)) {
    warnings.push(warnFor(e.op));
    if (e.op === "<<" || e.op === ">>" || e.op === ">>>") checkNonNegShift(e.right);
    if (e.op === ">>>") {
      return { kind: "ushr", value: coerceToI128(e.left), shift: coerceToI128(e.right) };
    }
    return { ...e, bitwise: true, left: coerceToI128(e.left), right: coerceToI128(e.right) };
  }
  if (e.kind === "unary" && e.op === "~") {
    warnings.push(warnFor("~"));
    return { kind: "unary", op: "!", operand: coerceToI128(e.operand), bitwise: true };
  }
  return e;
}

/** Coerce an operand into `i128`: tag an integer literal, else insert an `as i128`. */
function coerceToI128(e: HirExpr): HirExpr {
  if (e.kind === "number") {
    if (!Number.isInteger(e.value)) {
      throw new UnsupportedError({
        type: `fractional literal ${e.value} as a bitwise operand`,
      });
    }
    return { ...e, ty: "i128" };
  }
  return { kind: "cast", expr: e, ty: { ...I128 } };
}

/** A negative literal shift count fails loud (JS coerces it; we refuse to guess). */
function checkNonNegShift(shift: HirExpr): void {
  const neg =
    (shift.kind === "unary" && shift.op === "-" && shift.operand.kind === "number") ||
    (shift.kind === "number" && shift.value < 0);
  if (neg) {
    throw new UnsupportedError({ type: "negative shift count" });
  }
}

function warnFor(op: string): string {
  return `bitwise operator '${op}' uses wide-int (i128) semantics, not JS 32-bit truncation`;
}

// ── 2. Boundary ──────────────────────────────────────────────────────────────

/** Bindings whose initializer holds an `i128` result (forward fixpoint). */
function collectI128Bindings(stmts: HirStmt[]): Set<string> {
  const set = new Set<string>();
  const all = flatten(stmts);
  for (;;) {
    let changed = false;
    for (const s of all) {
      if (s.kind === "let" && !s.names && !set.has(s.name) && isI128Result(s.init, set)) {
        set.add(s.name);
        changed = true;
      }
    }
    if (!changed) return set;
  }
}

/** Does this expression evaluate to an `i128` (a bitwise result, or arithmetic over one)? */
function isI128Result(e: HirExpr, set: Set<string>): boolean {
  switch (e.kind) {
    case "binary":
      if (e.bitwise) return true;
      if (ARITHMETIC.has(e.op)) {
        const anyI128 = isI128Result(e.left, set) || isI128Result(e.right, set);
        const anyFrac = isFloatish(e.left) || isFloatish(e.right);
        return anyI128 && !anyFrac;
      }
      return false;
    case "ushr":
      return true;
    case "cast":
      return e.ty.kind === "i128";
    case "unary":
      return e.op === "-" && isI128Result(e.operand, set);
    case "ident":
      return set.has(e.name);
    case "number":
      return e.ty === "i128";
    default:
      return false;
  }
}

/** Does this expression sit in a float context (a fractional literal or float arithmetic)? */
function isFloatish(e: HirExpr): boolean {
  if (e.kind === "number") return !Number.isInteger(e.value);
  if (e.kind === "cast") return e.ty.kind === "f64";
  if (e.kind === "binary" && ARITHMETIC.has(e.op) && !e.bitwise) {
    return isFloatish(e.left) || isFloatish(e.right);
  }
  if (e.kind === "unary" && e.op === "-") return isFloatish(e.operand);
  return false;
}

/** Insert the outward casts an `i128` result needs to live in a non-`i128` context. */
function boundary(e: HirExpr, set: Set<string>): HirExpr {
  mapChildren(e, (c) => boundary(c, set));

  if (e.kind === "index" && isI128Result(e.index, set) && !isCastTo(e.index, "usize")) {
    return { ...e, index: { kind: "cast", expr: e.index, ty: { ...USIZE } } };
  }
  if (e.kind === "binary" && ARITHMETIC.has(e.op) && !e.bitwise) {
    const li = isI128Result(e.left, set);
    const ri = isI128Result(e.right, set);
    const lf = isFloatish(e.left);
    const rf = isFloatish(e.right);
    if ((li || ri) && (lf || rf)) {
      // Mixed with a float → coerce the i128 side(s) to f64.
      const left = li && !lf ? { kind: "cast" as const, expr: e.left, ty: { ...F64 } } : e.left;
      const right = ri && !rf ? { kind: "cast" as const, expr: e.right, ty: { ...F64 } } : e.right;
      return { ...e, left, right };
    }
    if (li || ri) {
      // Pure i128 arithmetic → tag integer-literal operands so they emit bare.
      tagI128IfIntLit(e.left);
      tagI128IfIntLit(e.right);
    }
  }
  return e;
}

function isCastTo(e: HirExpr, kind: string): boolean {
  return e.kind === "cast" && e.ty.kind === kind;
}

function tagI128IfIntLit(e: HirExpr): void {
  if (e.kind === "number" && Number.isInteger(e.value)) e.ty = "i128";
}

// ── HIR traversal ────────────────────────────────────────────────────────────

/** Rewrite each direct child expression of `e` in place via `f`. */
function mapChildren(e: HirExpr, f: (c: HirExpr) => HirExpr): void {
  switch (e.kind) {
    case "binary":
      e.left = f(e.left);
      e.right = f(e.right);
      break;
    case "unary":
      e.operand = f(e.operand);
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
    case "index":
      e.object = f(e.object);
      e.index = f(e.index);
      break;
    case "field":
    case "len":
      e.object = f(e.object);
      break;
    case "optMember":
      e.receiver = f(e.receiver);
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
    case "structLit":
    case "enumVariant":
      for (const fld of e.fields) fld.value = f(fld.value);
      break;
    case "some":
    case "boxNew":
      e.value = f(e.value);
      break;
    case "ok":
      if (e.value) e.value = f(e.value);
      break;
    case "try":
    case "await":
      e.expr = f(e.expr);
      break;
    case "jsonStringify":
      e.value = f(e.value);
      break;
    case "jsonParse":
    case "parseJson":
      e.source = f(e.source);
      break;
    case "tupleField":
      e.tuple = f(e.tuple);
      break;
    case "objectKeys":
    case "objectValues":
    case "objectEntries":
      e.map = f(e.map);
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
    case "iterReduce":
      e.receiver = f(e.receiver);
      e.forwarded = e.forwarded.map(f);
      e.init = f(e.init);
      break;
    case "iterSortDefault":
      e.receiver = f(e.receiver);
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
    case "ref":
      e.expr = f(e.expr);
      break;
    case "collectVec":
      e.iter = f(e.iter);
      break;
    case "tryBreak":
      e.expr = f(e.expr);
      break;
    // Leaves / exotic async & rc nodes carry no bitwise-eligible operands.
    default:
      break;
  }
}

/** All statements, descending into control-flow bodies (references preserved). */
function flatten(stmts: HirStmt[]): HirStmt[] {
  const out: HirStmt[] = [];
  for (const s of stmts) {
    out.push(s);
    for (const body of childBodies(s)) out.push(...flatten(body));
  }
  return out;
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
      return [s.tryBody, s.catchBody, ...(s.finallyBody ? [s.finallyBody] : [])];
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

/** Apply `f` to every direct expression across `stmts`, recursing into nested bodies. */
function walkStmtExprs(stmts: HirStmt[], f: (e: HirExpr) => HirExpr): void {
  for (const s of stmts) {
    reassignStmtExprs(s, f);
    for (const body of childBodies(s)) walkStmtExprs(body, f);
  }
}

function reassignStmtExprs(s: HirStmt, f: (e: HirExpr) => HirExpr): void {
  switch (s.kind) {
    case "let":
      s.init = f(s.init);
      break;
    case "return":
      if (s.value) s.value = f(s.value);
      break;
    case "expr":
      s.expr = f(s.expr);
      break;
    case "if":
    case "while":
      s.cond = f(s.cond);
      break;
    case "ifLet":
      s.scrutinee = f(s.scrutinee);
      break;
    case "forIn":
      s.iter = f(s.iter);
      break;
    case "forRange":
      s.start = f(s.start);
      s.end = f(s.end);
      break;
    case "match":
      s.disc = f(s.disc);
      for (const arm of s.arms) if (arm.guard) arm.guard = f(arm.guard);
      break;
    case "throw":
      s.value = f(s.value);
      break;
    case "breakTry":
      s.value = f(s.value);
      break;
    case "yieldReturn":
      s.value = f(s.value);
      break;
    default:
      break;
  }
}
