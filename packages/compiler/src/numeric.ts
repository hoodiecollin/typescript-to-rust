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
 * and the generated `main` refine independently.
 *
 * On top of the forcing `usize` pass sit two *preferring* integer promotions —
 * both idiomatic rewrites with a valid f64 fallback, so neither fails loud:
 *   - `promoteMatches` (series 019): a `switch` over integer literals whose
 *     discriminant is integer-safe becomes a literal-pattern `match`, retyping the
 *     discriminant to `i64` (or reusing `usize` when it is already index-forced).
 *   - `promoteRanges` (series 020): a canonical `usize` counting `for` (already a
 *     `block { let; while }`) is rewritten to a `forRange` (`for i in a..b`).
 *
 * The pass is idempotent and mutates the (freshly lowered) module in place, except
 * range promotion, which rewrites structure and threads the new body back.
 */

import type { HirExpr, HirModule, HirParam, HirStmt } from "./hir";
import { UnsupportedError } from "./lower";

/** Arithmetic operators that keep both operands in the same numeric type. */
const ARITHMETIC = new Set(["+", "-", "*", "/", "%"]);

export function refineNumerics(module: HirModule): HirModule {
  for (const item of module.items) {
    if (item.kind === "fn") {
      item.body = refineBody(item.params, item.body);
    } else if (item.kind === "class") {
      if (item.ctor)
        item.ctor.body = refineBody(item.ctor.params, item.ctor.body);
      for (const m of item.methods) m.body = refineBody(m.params, m.body);
    }
  }
  module.main = refineBody([], module.main);
  promoteIntegerMatches(module);
  return module;
}

/**
 * Refine one function body: run the forcing `usize` inference (retype/tag in
 * place), then the two *preferring* integer promotions — literal-pattern
 * `match`es (series 019) and `for i in a..b` ranges (series 020). The promotions
 * never fail loud: each has a valid f64 fallback (guarded `match` / while-desugar),
 * so a non-eligible construct is left untouched. Range promotion rewrites
 * structure, so the (possibly rewritten) statement list is returned.
 */
function refineBody(params: HirParam[], stmts: HirStmt[]): HirStmt[] {
  // Flatten control-flow bodies into one list of statement references so the
  // name-based fixpoint reaches indices inside `if`/`while` blocks (the shared
  // statement objects are mutated in place, so retyping still lands).
  const all = flattenStmts(stmts);
  const usize = computeUsizeNames(all);
  detectConflicts(all, usize);
  applyTypes(params, all, usize);
  return promoteRanges(stmts, usize);
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
      stmt.kind === "forIn" ||
      stmt.kind === "forRange"
    ) {
      out.push(...flattenStmts(stmt.body));
    } else if (stmt.kind === "match") {
      for (const arm of stmt.arms) out.push(...flattenStmts(arm.body));
    } else if (stmt.kind === "tryCatch") {
      out.push(...flattenStmts(stmt.tryBody));
      out.push(...flattenStmts(stmt.catchBody));
      if (stmt.finallyBody) out.push(...flattenStmts(stmt.finallyBody));
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
    case "forRange":
      eachExpr(stmt.start, fn);
      eachExpr(stmt.end, fn);
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

// ── Integer `match` promotion (series 019) ───────────────────────────────────

/** One function body with the metadata the match promotion needs. */
interface Body {
  /** The free-function name (for finding call sites); undefined for main/methods. */
  fnName?: string;
  params: HirParam[];
  stmts: HirStmt[];
}

/**
 * Promote every lowered integer `switch` — a `match` whose non-wildcard arms are
 * all `disc == <integer literal>` guards — to idiomatic literal-pattern arms,
 * retyping an integer-safe discriminant to `i64`. *Preferring*, not forcing: the
 * guarded-wildcard f64 `match` is a valid fallback, so anything not provably
 * integer-safe is left untouched (never fails loud).
 *
 * A **parameter** discriminant crosses the call boundary — the param retypes to
 * `i64`, so every call argument at that position must also become an integer.
 * This is a whole-program (closed-world) transform: it fires only when *every*
 * call site passes an integer literal there (then those literals are retyped
 * too); a single non-integer-literal argument keeps the guarded f64 fallback. A
 * discriminant already forced to `usize` by indexing promotes in place (literal
 * patterns work on `usize`); a plain local-`let` discriminant is deferred.
 */
function promoteIntegerMatches(module: HirModule): void {
  const bodies: Body[] = [];
  for (const item of module.items) {
    if (item.kind === "fn") {
      bodies.push({ fnName: item.name, params: item.params, stmts: item.body });
    } else if (item.kind === "class") {
      if (item.ctor)
        bodies.push({ params: item.ctor.params, stmts: item.ctor.body });
      for (const m of item.methods)
        bodies.push({ params: m.params, stmts: m.body });
    }
  }
  bodies.push({ params: [], stmts: module.main });

  for (const body of bodies) {
    const all = flattenStmts(body.stmts);
    const usize = computeUsizeNames(all);
    for (const stmt of all) {
      if (stmt.kind !== "match" || stmt.disc.kind !== "ident") continue;
      const name = stmt.disc.name;

      const guarded = stmt.arms.filter((a) => a.guard !== null);
      if (guarded.length === 0) continue;
      const cases = guarded.map((a) => integerCaseLiteral(a.guard, name));
      if (cases.some((c) => c === null)) continue;

      const paramIdx = body.params.findIndex((p) => p.name === name);
      const already = usize.has(name);

      let tag: "usize" | "i64";
      if (already) {
        // Index-forced `usize` — literal patterns work as-is, no boundary.
        tag = "usize";
      } else if (paramIdx >= 0 && body.fnName) {
        // A free-function param: retype it and every integer-literal call arg.
        if (!isIntegerSafe(name, all)) continue;
        const argLiterals = collectIntegerCallArgs(
          module,
          body.fnName,
          paramIdx,
        );
        if (argLiterals === null) continue; // a caller passes a non-integer arg
        const param = body.params[paramIdx];
        if (param) param.ty = { kind: "i64" };
        for (const lit of argLiterals) lit.ty = "i64";
        tag = "i64";
      } else {
        continue; // local-`let` / method / main discriminant — deferred
      }

      guarded.forEach((arm, i) => {
        const value = cases[i];
        if (value === null || value === undefined) return;
        arm.pat = { kind: "number", value, ty: tag };
        arm.guard = null;
      });
    }
  }
}

/**
 * Collect the argument node at position `idx` of every `call` to `fnName` across
 * the module. Returns the integer-literal argument nodes (to retype `i64`), or
 * `null` if any such call passes a non-integer-literal / missing argument there.
 */
function collectIntegerCallArgs(
  module: HirModule,
  fnName: string,
  idx: number,
): Extract<HirExpr, { kind: "number" }>[] | null {
  const literals: Extract<HirExpr, { kind: "number" }>[] = [];
  let bail = false;
  eachModuleExpr(module, (e) => {
    if (e.kind !== "call" || e.callee !== fnName) return;
    const arg = e.args[idx]?.expr;
    if (arg && arg.kind === "number" && Number.isInteger(arg.value)) {
      literals.push(arg);
    } else {
      bail = true;
    }
  });
  return bail ? null : literals;
}

/** Visit every expression in every function body and the main script. */
function eachModuleExpr(module: HirModule, fn: (e: HirExpr) => void): void {
  const visit = (stmts: HirStmt[]) => {
    for (const stmt of flattenStmts(stmts)) eachStmtExpr(stmt, fn);
  };
  for (const item of module.items) {
    if (item.kind === "fn") visit(item.body);
    else if (item.kind === "class") {
      if (item.ctor) visit(item.ctor.body);
      for (const m of item.methods) visit(m.body);
    }
  }
  visit(module.main);
}

/** If `guard` is `<name> == <integer literal>`, return the literal value, else null. */
function integerCaseLiteral(
  guard: HirExpr | null,
  name: string,
): number | null {
  if (!guard || guard.kind !== "binary" || guard.op !== "==") return null;
  if (!isNamedIdent(guard.left, name)) return null;
  const r = guard.right;
  if (r.kind !== "number" || !Number.isInteger(r.value)) return null;
  return r.value;
}

/**
 * Is `name` integer-safe in this scope — never mixed with a fractional literal,
 * never an operand of `/` (i64 division truncates, changing behaviour), never
 * assigned a fractional value, never passed as a call/method argument (which would
 * cross a boundary into an `f64` parameter)? If so, retyping `f64` → `i64` is
 * behaviour-preserving.
 */
function isIntegerSafe(name: string, stmts: HirStmt[]): boolean {
  let safe = true;
  for (const stmt of stmts) {
    eachStmtExpr(stmt, (e) => {
      if (e.kind === "binary") {
        const hasName =
          isNamedIdent(e.left, name) || isNamedIdent(e.right, name);
        if (!hasName) return;
        if (e.op === "/") safe = false;
        else if (isFractionalLiteral(e.left) || isFractionalLiteral(e.right))
          safe = false;
      } else if (e.kind === "assign") {
        if (isNamedIdent(e.target, name) && isFractionalLiteral(e.value))
          safe = false;
      } else if (e.kind === "call") {
        if (e.args.some((a) => isNamedIdent(a.expr, name))) safe = false;
      } else if (e.kind === "method") {
        if (e.args.some((a) => isNamedIdent(a, name))) safe = false;
      }
    });
  }
  return safe;
}

// ── `for i in a..b` range promotion (series 020) ─────────────────────────────

/**
 * Recursively rewrite each canonical `usize` counting `for` — already a
 * `block { let mut i = start; while (i </<= end) { …; i = i + 1; } }` — into a
 * `forRange` (`for i in start..end`). Purely structural: the counter is `usize`
 * before and after, so no type can conflict. Every non-eligible loop keeps its
 * correct while-desugar. Returns the (possibly rewritten) statement list.
 */
function promoteRanges(stmts: HirStmt[], usize: Set<string>): HirStmt[] {
  return stmts.map((stmt) => {
    const recursed = mapStmtBodies(stmt, (b) => promoteRanges(b, usize));
    if (recursed.kind === "block") {
      const range = tryRange(recursed, usize);
      if (range) return range;
    }
    return recursed;
  });
}

/** Rebuild `stmt` with each of its nested statement lists passed through `f`. */
function mapStmtBodies(
  stmt: HirStmt,
  f: (body: HirStmt[]) => HirStmt[],
): HirStmt {
  switch (stmt.kind) {
    case "if":
      return {
        ...stmt,
        conseq: f(stmt.conseq),
        alt: stmt.alt ? f(stmt.alt) : null,
      };
    case "while":
    case "block":
    case "forIn":
    case "forRange":
      return { ...stmt, body: f(stmt.body) };
    case "match":
      return {
        ...stmt,
        arms: stmt.arms.map((a) => ({ ...a, body: f(a.body) })),
      };
    default:
      return stmt;
  }
}

/**
 * If `block` is the canonical counting-loop shape with a `usize` counter and an
 * integer-compatible bound, return the equivalent `forRange`; else `null`.
 */
function tryRange(
  block: Extract<HirStmt, { kind: "block" }>,
  usize: Set<string>,
): HirStmt | null {
  if (block.body.length !== 2) return null;
  const [letStmt, whileStmt] = block.body;
  if (!letStmt || letStmt.kind !== "let") return null;
  if (!whileStmt || whileStmt.kind !== "while") return null;

  const counter = letStmt.name;
  if (!usize.has(counter)) return null; // index-driven counters only

  const cond = whileStmt.cond;
  if (cond.kind !== "binary" || (cond.op !== "<" && cond.op !== "<="))
    return null;
  if (!isNamedIdent(cond.left, counter)) return null;
  if (!isIntegerBound(cond.right, usize)) return null;

  const body = whileStmt.body;
  const last = body[body.length - 1];
  if (!last || !isUnitIncrement(last, counter)) return null;
  const inner = body.slice(0, -1);
  if (assignsName(inner, counter)) return null; // counter mutated elsewhere
  if (hasOwnContinueHir(inner)) return null; // 018 while-desugar keeps its inlining

  return {
    kind: "forRange",
    counter,
    start: tagUsizeIfInt(letStmt.init),
    end: tagUsizeIfInt(cond.right),
    inclusive: cond.op === "<=",
    body: inner,
  };
}

/** A bound is integer-compatible: a `.len()`, an integer literal, or a `usize`. */
function isIntegerBound(e: HirExpr, usize: Set<string>): boolean {
  if (e.kind === "len") return true;
  if (e.kind === "number") return Number.isInteger(e.value) && e.value >= 0;
  if (e.kind === "ident") return usize.has(e.name);
  return false;
}

/** Is `stmt` the appended counter update `i = i + 1` (or `i += 1`)? */
function isUnitIncrement(stmt: HirStmt, counter: string): boolean {
  if (stmt.kind !== "expr" || stmt.expr.kind !== "assign") return false;
  const a = stmt.expr;
  if (!isNamedIdent(a.target, counter)) return false;
  if (a.op === "+=") return isOne(a.value);
  if (a.op === "=") {
    const v = a.value;
    return (
      v.kind === "binary" &&
      v.op === "+" &&
      ((isNamedIdent(v.left, counter) && isOne(v.right)) ||
        (isNamedIdent(v.right, counter) && isOne(v.left)))
    );
  }
  return false;
}

function isOne(e: HirExpr): boolean {
  return e.kind === "number" && e.value === 1;
}

/** Does any statement (nested) assign to `name`? */
function assignsName(stmts: HirStmt[], name: string): boolean {
  for (const stmt of flattenStmts(stmts)) {
    let found = false;
    eachStmtExpr(stmt, (e) => {
      if (e.kind === "assign" && isNamedIdent(e.target, name)) found = true;
    });
    if (found) return true;
  }
  return false;
}

/** A `continue` targeting *this* loop (not one nested inside another loop). */
function hasOwnContinueHir(stmts: HirStmt[]): boolean {
  for (const s of stmts) {
    if (s.kind === "continue") return true;
    if (s.kind === "if") {
      if (hasOwnContinueHir(s.conseq)) return true;
      if (s.alt && hasOwnContinueHir(s.alt)) return true;
    } else if (s.kind === "block") {
      if (hasOwnContinueHir(s.body)) return true;
    } else if (s.kind === "match") {
      for (const arm of s.arms) if (hasOwnContinueHir(arm.body)) return true;
    }
    // while/forIn/forRange own their own `continue` (a barrier).
  }
  return false;
}

/** Tag a non-negative integer literal `usize` (so a range bound emits bare). */
function tagUsizeIfInt(e: HirExpr): HirExpr {
  if (e.kind === "number" && Number.isInteger(e.value) && e.value >= 0) {
    return { ...e, ty: "usize" };
  }
  return e;
}

function isNamedIdent(e: HirExpr, name: string): boolean {
  return e.kind === "ident" && e.name === name;
}
