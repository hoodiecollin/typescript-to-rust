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

import type { HirExpr, HirModule, HirParam, HirStmt, RustType } from "./hir";
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
  propagateIntegerParams(module);
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
  tagIntegerModulo(all, usize);
  return promoteRanges(stmts, usize);
}

// ── Local integer-domain modulo (series 103a) ─────────────────────────────────

/** Arithmetic that keeps an integer result when both operands are integers. */
const INTEGER_ARITH = new Set(["+", "-", "*", "%"]);

/**
 * Tag every `f64` `%` whose operands are provably integer-valued with `intDomain`,
 * so the emitter renders it as a hardware integer modulo (`((i as i64) % 3) as f64`)
 * instead of a libm `fmod` call (design 103a). Purely *preferring*: it never
 * retypes a binding and never fails loud — a non-integer `%` is left as an `f64`
 * remainder. `usize`-touching modulos are left to the existing index pass.
 */
function tagIntegerModulo(stmts: HirStmt[], usize: Set<string>): void {
  const ints = computeIntegerNames(stmts, usize);
  for (const stmt of stmts) {
    eachStmtExpr(stmt, (e) => {
      if (
        e.kind === "binary" &&
        e.op === "%" &&
        !e.bitwise &&
        !touchesUsize(e.left, usize) &&
        !touchesUsize(e.right, usize) &&
        isIntegerValued(e.left, ints, usize) &&
        isIntegerValued(e.right, ints, usize)
      ) {
        e.intDomain = true;
      }
    });
  }
}

/**
 * The set of `let`-bound names whose value is provably an integer: seeded by an
 * integer-valued expression and only ever assigned integer-valued expressions.
 * Computed as a *greatest* fixpoint (start with every candidate, drop any that is
 * disqualified) so mutually-referential integer bindings (`a = b + 1; b = a - 1`)
 * are still admitted. `usize` bindings are excluded — they are already integer and
 * handled by the index pass. Unlike `isIntegerSafe`, boundary-crossing/printing do
 * not disqualify: 103a re-expresses a value locally without retyping the binding.
 */
function computeIntegerNames(
  stmts: HirStmt[],
  usize: Set<string>,
): Set<string> {
  const names = new Set<string>();
  for (const stmt of stmts) {
    if (stmt.kind === "let" && !usize.has(stmt.name)) names.add(stmt.name);
  }
  for (;;) {
    let changed = false;
    for (const stmt of stmts) {
      if (
        stmt.kind === "let" &&
        names.has(stmt.name) &&
        !isIntegerValued(stmt.init, names, usize)
      ) {
        names.delete(stmt.name);
        changed = true;
      }
      eachStmtExpr(stmt, (e) => {
        if (
          e.kind === "assign" &&
          e.target.kind === "ident" &&
          names.has(e.target.name) &&
          !assignKeepsInteger(e.op, e.value, names, usize)
        ) {
          names.delete(e.target.name);
          changed = true;
        }
      });
    }
    if (!changed) return names;
  }
}

/**
 * Does the assignment keep its target integer-valued? `=`/`+=`/`-=`/`*=`/`%=` do
 * when the RHS is integer-valued (target is already integer); `/=` never does
 * (division truncates / goes fractional), and any other operator is treated
 * conservatively as non-integer.
 */
function assignKeepsInteger(
  op: string,
  value: HirExpr,
  names: Set<string>,
  usize: Set<string>,
): boolean {
  if (op === "=" || op === "+=" || op === "-=" || op === "*=" || op === "%=") {
    return isIntegerValued(value, names, usize);
  }
  return false;
}

/** Is `e` provably integer-valued given the current integer/usize name sets? */
function isIntegerValued(
  e: HirExpr,
  names: Set<string>,
  usize: Set<string>,
): boolean {
  switch (e.kind) {
    case "number":
      return Number.isInteger(e.value);
    case "ident":
      return names.has(e.name) || usize.has(e.name);
    case "len":
      return true;
    case "cast":
      return (
        e.ty.kind === "usize" || e.ty.kind === "i64" || e.ty.kind === "i128"
      );
    case "binary":
      if (e.op === "/") return false; // float division — result is fractional
      if (!INTEGER_ARITH.has(e.op)) return false;
      return (
        isIntegerValued(e.left, names, usize) &&
        isIntegerValued(e.right, names, usize)
      );
    default:
      return false;
  }
}

/** Does any identifier within `e` belong to the `usize` set? */
function touchesUsize(e: HirExpr, usize: Set<string>): boolean {
  let found = false;
  eachExpr(e, (n) => {
    if (n.kind === "ident" && usize.has(n.name)) found = true;
  });
  return found;
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
    } else if (stmt.kind === "tryBlock" || stmt.kind === "carrierTry") {
      out.push(...flattenStmts(stmt.tryBody));
      if (stmt.catchBody) out.push(...flattenStmts(stmt.catchBody));
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
  // A value-position `++`/`--` (series 096) in usize context (`arr[i++]`, the
  // `update` node *is* the index) — descend to the target identifier so it joins
  // the usize set, exactly as a bare `arr[i]` index identifier would.
  if (expr.kind === "update") markContext(expr.target, visit);
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
    case "breakTry":
      eachExpr(stmt.value, fn);
      break;
    case "carrierErr":
      eachExpr(stmt.value, fn);
      break;
    case "carrierBreak":
      if (stmt.value) eachExpr(stmt.value, fn);
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
    case "unary":
      eachExpr(e.operand, fn);
      break;
    case "iterMap":
    case "iterFilter":
    case "iterFlatMap":
      eachExpr(e.receiver, fn);
      for (const f of e.forwarded) eachExpr(f, fn);
      break;
    case "assign":
      eachExpr(e.target, fn);
      eachExpr(e.value, fn);
      break;
    case "update":
      // A value-position `++`/`--` (series 096): the embedded `step` is an `assign`
      // whose `1` must type as usize/f64 like any `i += 1`, so recurse into both.
      eachExpr(e.target, fn);
      eachExpr(e.step, fn);
      break;
    case "cond":
      eachExpr(e.test, fn);
      eachExpr(e.conseq, fn);
      eachExpr(e.alt, fn);
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
    case "tryBreak":
      eachExpr(e.expr, fn);
      break;
    case "await":
      eachExpr(e.expr, fn);
      break;
    case "ref":
      eachExpr(e.expr, fn);
      break;
    case "collectVec":
      eachExpr(e.iter, fn);
      break;
    // Leaves carry no nested expressions:
    case "number":
    case "string":
    case "bool":
    case "ident":
    case "path":
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
      // Each guarded arm is `disc == v` or an or-chain `disc == a || disc == b`
      // (series 064's folded stacked cases) — collect its integer value(s).
      const cases = guarded.map((a) => integerCaseValues(a.guard, name));
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
        const values = cases[i];
        if (!values) return;
        setLiteralPattern(arm, values, tag);
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
 * Collect the integer value(s) an arm guard matches: a single `disc == v`, or an
 * or-chain `disc == a || disc == b || …` (series 064's folded stacked cases).
 * Returns `null` if any leaf is not an integer `disc == <int>` comparison.
 */
function integerCaseValues(
  guard: HirExpr | null,
  name: string,
): number[] | null {
  if (guard && guard.kind === "binary" && guard.op === "||") {
    const l = integerCaseValues(guard.left, name);
    const r = integerCaseValues(guard.right, name);
    return l && r ? [...l, ...r] : null;
  }
  const v = integerCaseLiteral(guard, name);
  return v === null ? null : [v];
}

/**
 * Set an integer arm's literal pattern (series 064). One value → a literal `pat`;
 * a contiguous run of ≥3 → a `rangePat` (`lo..=hi`); otherwise an or-pattern
 * `pats` (`a | b`). Each number carries the promoted `tag` (`usize`/`i64`).
 */
function setLiteralPattern(
  arm: { pat?: HirExpr; pats?: HirExpr[]; rangePat?: { lo: HirExpr; hi: HirExpr } },
  values: number[],
  tag: "usize" | "i64",
): void {
  const num = (value: number): HirExpr => ({ kind: "number", value, ty: tag });
  if (values.length === 1) {
    arm.pat = num(values[0] as number);
    return;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const contiguous = sorted.every((v, i) => i === 0 || v === sorted[i - 1]! + 1);
  if (contiguous && sorted.length >= 3) {
    arm.rangePat = {
      lo: num(sorted[0] as number),
      hi: num(sorted[sorted.length - 1] as number),
    };
  } else {
    arm.pats = values.map(num);
  }
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

// ── Integer parameter propagation across call boundaries (series 031, gap A) ──

/**
 * After inference retypes an index-forced parameter to `usize` (and a `switch`
 * discriminant to `i64`), the *arguments* at those positions still carry `f64` —
 * so `fn f(i: usize)` called `f(1.0)` is rejected by Rust (E0308). The
 * `promoteIntegerMatches` path already reconciles its own `i64` call args; this
 * pass generalizes that reconciliation to **every** `usize`/`i64` parameter, and
 * to methods and constructors as well as free functions.
 *
 * Per integer parameter position: an integer-literal argument is retyped to
 * match (the fix); a fractional/negative literal, or a non-literal that we cannot
 * prove is already that integer type, fails loud (`UnsupportedError`) — honest,
 * because propagating integer-ness *backward* into a caller's variables is real
 * inter-procedural inference (a separate series), not a literal retag. A
 * `usize`-typed identifier passed to a `usize` parameter is already sound and
 * passes through untouched.
 */
function propagateIntegerParams(module: HirModule): void {
  // Callee signatures: free functions and constructors keyed by callee string
  // (`f`, `Class::new` — matching lowering); methods keyed by class then name.
  const fnSigs = new Map<string, RustType[]>();
  const classMethods = new Map<string, Map<string, RustType[]>>();
  for (const item of module.items) {
    if (item.kind === "fn") {
      fnSigs.set(item.name, item.params.map(paramType));
    } else if (item.kind === "class") {
      if (item.ctor) {
        fnSigs.set(`${item.name}::new`, item.ctor.params.map(paramType));
      }
      const methods = new Map<string, RustType[]>();
      for (const m of item.methods)
        methods.set(m.name, m.params.map(paramType));
      classMethods.set(item.name, methods);
    }
  }

  const bodies: {
    stmts: HirStmt[];
    params: HirParam[];
    selfClass?: string;
  }[] = [];
  for (const item of module.items) {
    if (item.kind === "fn") {
      bodies.push({ stmts: item.body, params: item.params });
    } else if (item.kind === "class") {
      if (item.ctor) {
        bodies.push({
          stmts: item.ctor.body,
          params: item.ctor.params,
          selfClass: item.name,
        });
      }
      for (const m of item.methods) {
        bodies.push({ stmts: m.body, params: m.params, selfClass: item.name });
      }
    }
  }
  bodies.push({ stmts: module.main, params: [] });

  for (const body of bodies) {
    const all = flattenStmts(body.stmts);
    const usize = computeUsizeNames(all);
    // ident → struct class name, so a method receiver resolves to its signature.
    const structOf = new Map<string, string>();
    for (const p of body.params) {
      if (p.ty.kind === "struct") structOf.set(p.name, p.ty.name);
    }
    for (const s of all) {
      if (s.kind === "let" && s.ty?.kind === "struct") {
        structOf.set(s.name, s.ty.name);
      }
    }

    for (const stmt of all) {
      eachStmtExpr(stmt, (e) => {
        if (e.kind === "call") {
          const sig = fnSigs.get(e.callee);
          if (sig) {
            reconcileArgs(
              e.args.map((a) => a.expr),
              sig,
              usize,
            );
          }
        } else if (e.kind === "method") {
          const cls = receiverClass(e.receiver, structOf, body.selfClass);
          const sig = cls ? classMethods.get(cls)?.get(e.name) : undefined;
          if (sig) reconcileArgs(e.args, sig, usize);
        }
      });
    }
  }
}

function paramType(p: HirParam): RustType {
  return p.ty;
}

/** Resolve a method receiver to its class name, or `undefined` if not statically known. */
function receiverClass(
  recv: HirExpr,
  structOf: Map<string, string>,
  selfClass: string | undefined,
): string | undefined {
  if (recv.kind !== "ident") return undefined;
  if (recv.name === "self") return selfClass;
  return structOf.get(recv.name);
}

/**
 * Reconcile positional arguments against a callee's parameter types, acting only
 * on `usize`/`i64` parameters (see `propagateIntegerParams`).
 * @throws {UnsupportedError} on a fractional/negative literal or a non-literal
 * that isn't a matching `usize` identifier.
 */
function reconcileArgs(
  args: HirExpr[],
  sig: RustType[],
  usize: Set<string>,
): void {
  for (let i = 0; i < args.length; i++) {
    const pty = sig[i];
    if (!pty || (pty.kind !== "usize" && pty.kind !== "i64")) continue;
    const arg = args[i];
    if (!arg) continue;
    if (arg.kind === "number") {
      if (
        !Number.isInteger(arg.value) ||
        (pty.kind === "usize" && arg.value < 0)
      ) {
        throw new UnsupportedError({
          type: `non-integer literal ${arg.value} passed to a ${pty.kind} parameter`,
        });
      }
      arg.ty = pty.kind;
    } else if (
      arg.kind === "ident" &&
      pty.kind === "usize" &&
      usize.has(arg.name)
    ) {
      // A caller-side `usize` binding passed to a `usize` parameter is sound.
    } else {
      throw new UnsupportedError({
        type: `inter-procedural integer inference: a non-literal value passed to a ${pty.kind} parameter is not yet supported (pass an integer literal, or index within the callee)`,
      });
    }
  }
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
  if (cond.kind !== "binary") return null;
  if (!isNamedIdent(cond.left, counter)) return null;
  if (!isIntegerBound(cond.right, usize)) return null;

  const body = whileStmt.body;
  const last = body[body.length - 1];
  if (!last) return null;
  const step = analyzeUpdate(last, counter);
  if (!step) return null;

  // `continue` is native in a range (it advances automatically), so strip the
  // desugar's inlined `{ update; continue }` (tagged `fromForContinue`) back to a
  // bare `continue` — series 064, graduating the 018 residual. After stripping,
  // any *remaining* counter assignment is a real mutation and blocks promotion.
  const inner = stripForContinue(body.slice(0, -1), counter);
  if (assignsName(inner, counter)) return null;

  const ascending = cond.op === "<" || cond.op === "<=";
  const descending = cond.op === ">" || cond.op === ">=";
  const label = whileStmt.label;

  if (ascending && step.dir === "up") {
    return {
      kind: "forRange",
      counter,
      start: tagUsizeIfInt(letStmt.init),
      end: tagUsizeIfInt(cond.right),
      inclusive: cond.op === "<=",
      step: step.by,
      body: inner,
      label,
    };
  }
  // Descending unit step (series 064): `(lo..=hi).rev()` counts `hi…lo`. `i > E`
  // stops at `E+1` (lo = E+1); `i >= E` includes `E` (lo = E). `hi` is the init.
  // Non-unit descending step and non-`usize` bound-driven ranges stay `while`.
  if (descending && step.dir === "down" && step.by === 1) {
    const lo =
      cond.op === ">" ? addOne(tagUsizeIfInt(cond.right)) : tagUsizeIfInt(cond.right);
    return {
      kind: "forRange",
      counter,
      start: lo,
      end: tagUsizeIfInt(letStmt.init),
      inclusive: true,
      descending: true,
      body: inner,
      label,
    };
  }
  return null;
}

/** `e + 1`, folded when `e` is an integer literal (keeps the `usize` tag). */
function addOne(e: HirExpr): HirExpr {
  if (e.kind === "number" && Number.isInteger(e.value)) {
    return { ...e, value: e.value + 1 };
  }
  return {
    kind: "binary",
    op: "+",
    left: e,
    right: { kind: "number", value: 1, ty: "usize" },
  };
}

/**
 * Classify a loop's trailing counter update (series 064): an increment (`i++`,
 * `i += k`, `i = i + k`) → `{ dir: "up", by: k }`; a decrement (`i--`, `i -= k`,
 * `i = i - k`) → `{ dir: "down", by: k }`. `k` must be a positive integer literal.
 * Anything else (a non-linear `i *= 2`, a fractional step) → `null` (stays `while`).
 */
function analyzeUpdate(
  stmt: HirStmt,
  counter: string,
): { dir: "up" | "down"; by: number } | null {
  if (stmt.kind !== "expr" || stmt.expr.kind !== "assign") return null;
  const a = stmt.expr;
  if (!isNamedIdent(a.target, counter)) return null;
  const posInt = (e: HirExpr): number | null =>
    e.kind === "number" && Number.isInteger(e.value) && e.value > 0
      ? e.value
      : null;
  if (a.op === "+=") {
    const k = posInt(a.value);
    return k === null ? null : { dir: "up", by: k };
  }
  if (a.op === "-=") {
    const k = posInt(a.value);
    return k === null ? null : { dir: "down", by: k };
  }
  if (a.op === "=") {
    const v = a.value;
    if (v.kind !== "binary" || (v.op !== "+" && v.op !== "-")) return null;
    // `i = i + k` (commutative for `+`) or `i = i - k`.
    if (isNamedIdent(v.left, counter)) {
      const k = posInt(v.right);
      if (k === null) return null;
      return { dir: v.op === "+" ? "up" : "down", by: k };
    }
    if (v.op === "+" && isNamedIdent(v.right, counter)) {
      const k = posInt(v.left);
      return k === null ? null : { dir: "up", by: k };
    }
  }
  return null;
}

/**
 * Strip the C-`for` desugar's inlined `{ update; continue }` blocks (tagged
 * `fromForContinue`) back to a bare `continue` — the range advances natively, so
 * the inlined counter update is redundant (and would need a `mut` binding). The
 * tag makes this unambiguous: a user-written `{ …; continue; }` is never touched.
 * Transparent through `if`/`block`/`match`; a nested loop is left alone.
 */
function stripForContinue(stmts: HirStmt[], counter: string): HirStmt[] {
  return stmts.map((s) => {
    if (
      s.kind === "block" &&
      s.fromForContinue &&
      s.body.length === 2 &&
      (s.body[1] as HirStmt).kind === "continue"
    ) {
      // The tag is authoritative — this block is the desugar's inlined update.
      return s.body[1] as HirStmt;
    }
    switch (s.kind) {
      case "if":
        return {
          ...s,
          conseq: stripForContinue(s.conseq, counter),
          alt: s.alt ? stripForContinue(s.alt, counter) : null,
        };
      case "block":
        return { ...s, body: stripForContinue(s.body, counter) };
      case "match":
        return {
          ...s,
          arms: s.arms.map((arm) => ({
            ...arm,
            body: stripForContinue(arm.body, counter),
          })),
        };
      default:
        return s;
    }
  });
}

/** A bound is integer-compatible: a `.len()`, an integer literal, or a `usize`. */
function isIntegerBound(e: HirExpr, usize: Set<string>): boolean {
  if (e.kind === "len") return true;
  if (e.kind === "number") return Number.isInteger(e.value) && e.value >= 0;
  if (e.kind === "ident") return usize.has(e.name);
  return false;
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
