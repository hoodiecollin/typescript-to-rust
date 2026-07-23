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

import { UnsupportedError } from "./errors";
import type { HirExpr, HirModule, HirParam, HirStmt, RustType } from "./hir";

/** Arithmetic operators that keep both operands in the same numeric type. */
const ARITHMETIC = new Set(["+", "-", "*", "/", "%"]);

export function refineNumerics(module: HirModule): HirModule {
  // Module-wide integrality seeds (series 105 / #90): compute *before* any body is
  // refined (it reads the pre-refine `number`/`f64` shape) which param names are
  // provably integer inter-procedurally — a lifted `__cb_*` element/acc param from
  // its adapter's receiver element, or a free-fn param integer at every call site.
  // Threaded into each body's `tagIntegerModulo` so an integer-domain `%` inside a
  // callback (`v % 5`) specializes exactly as 103a does for intra-body counters.
  const seeds = computeIntegralitySeeds(module);
  for (const item of module.items) {
    if (item.kind === "fn") {
      item.body = refineBody(item.params, item.body, item.ret, seeds.get(item.body));
    } else if (item.kind === "class") {
      if (item.ctor)
        item.ctor.body = refineBody(
          item.ctor.params,
          item.ctor.body,
          item.ctor.ret,
          seeds.get(item.ctor.body),
        );
      for (const m of item.methods)
        m.body = refineBody(m.params, m.body, m.ret, seeds.get(m.body));
    }
  }
  module.main = refineBody([], module.main, undefined, seeds.get(module.main));
  promoteIntegerMatches(module);
  propagateIntegerParams(module);
  specializeReturnTypes(module);
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
function refineBody(
  params: HirParam[],
  stmts: HirStmt[],
  retTy?: RustType,
  seedInts?: Set<string>,
): HirStmt[] {
  // Flatten control-flow bodies into one list of statement references so the
  // name-based fixpoint reaches indices inside `if`/`while` blocks (the shared
  // statement objects are mutated in place, so retyping still lands).
  const all = flattenStmts(stmts);
  const usize = computeUsizeNames(all);
  detectConflicts(all, usize);
  applyTypes(params, all, usize);
  // 103b-1 (retype integer counters/accumulators to `i64`) runs before 103a
  // (`tagIntegerModulo`), which falls back to a local integer-domain cast only for
  // an integer `%` whose operands did *not* retype. The module-wide integrality
  // seed (series 105) is threaded into 103a only — v1 tags the modulo, it does not
  // retype params/elements to `i64` (deferred), so 103b-1's local pass is unaffected.
  const i64 = specializeIntegerBindings(all, usize, retTy);
  tagIntegerModulo(all, usize, i64, seedInts);
  const promoted = promoteRanges(stmts, usize, i64);
  // Series 109 (#88): last, on the settled structure, cast every `.length` in an
  // `f64` context. Must run after range promotion (so `forRange` bounds exist) and
  // after usize retyping (so the usize slots are known).
  coerceLenToF64(flattenStmts(promoted), usize);
  return promoted;
}

/** Comparison operators (both JS and lowered spellings) — an operand next to a
 * `usize` identifier in one is itself a `usize` slot (an un-promoted loop bound). */
const COMPARISON_OPS = new Set(["<", ">", "<=", ">=", "==", "!=", "===", "!=="]);

/**
 * `.length` → `f64` coercion (series 111, #88). Tag every `len` node that sits in an
 * **f64** context with `f64: true`, so `.len()`/`.chars().count()` (a `usize`) is cast
 * `(… as f64)` and composes with `number` arithmetic, bindings, returns, and arguments.
 * Today `.length` in an `f64` context does not compile (counts must go through a `for…of`
 * counter); this graduates that away (Collin, 2026-07-23). Lossless in practice — a length
 * past 2⁵³ is unrepresentable — under the same accepted-`i64` posture as series 103.
 *
 * A `len` stays a **bare `usize`** wherever the numeric pass proved a `usize` slot, so no
 * working index/bound loop regresses: an array index, a `usize`-counter `forRange` bound,
 * a `usize`-binding initializer/RHS, or a comparison against a `usize` identifier (an
 * un-promoted `while (i < arr.length)`). Everything else is an `f64` consumer. A missed
 * f64 context only leaves a program that already did not compile (never a regression);
 * only an over-broad `usize` claim could regress, so the `usize` set is the authority.
 */
function coerceLenToF64(stmts: HirStmt[], usize: Set<string>): void {
  const bare = new Set<HirExpr>(); // `len` nodes that must stay `usize`
  const collectLens = (root: HirExpr): void =>
    markContext(root, (n) => {
      if (n.kind === "len") bare.add(n);
    });

  // usize slots: (a) array index args + (b) usize-binding inits/assigns.
  for (const root of usizeContextRoots(stmts, usize)) collectLens(root);
  for (const stmt of stmts) {
    // (c) usize-counter range bounds (an `i64` counter's bounds hold no `len`).
    if (stmt.kind === "forRange" && stmt.counterTy !== "i64") {
      collectLens(stmt.start);
      collectLens(stmt.end);
    }
    // (d) a comparison against a usize identifier (an un-promoted loop condition).
    eachStmtExpr(stmt, (e) => {
      if (e.kind !== "binary" || !COMPARISON_OPS.has(e.op)) return;
      if (isUsizeIdent(e.left, usize) || isUsizeIdent(e.right, usize)) {
        collectLens(e.left);
        collectLens(e.right);
      }
    });
  }

  // Every `len` the usize analysis did not claim is an f64 consumer.
  for (const stmt of stmts) {
    eachStmtExpr(stmt, (e) => {
      if (e.kind === "len" && !bare.has(e)) e.f64 = true;
    });
  }
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
function tagIntegerModulo(
  stmts: HirStmt[],
  usize: Set<string>,
  i64: Set<string>,
  seed?: Set<string>,
): void {
  const ints = computeIntegerNames(stmts, usize, seed);
  for (const stmt of stmts) {
    eachStmtExpr(stmt, (e) => {
      if (
        e.kind === "binary" &&
        e.op === "%" &&
        !e.bitwise &&
        !touchesUsize(e.left, usize) &&
        !touchesUsize(e.right, usize) &&
        isIntegerValued(e.left, ints, usize) &&
        isIntegerValued(e.right, ints, usize) &&
        // Already native `i64 % i64` after a 103b-1 retype — no cast needed.
        !(isI64Typed(e.left, i64) && isI64Typed(e.right, i64))
      ) {
        e.intDomain = true;
      }
    });
  }
}

/** Is `e` already `i64`-typed (a retyped binding or an `i64`-tagged integer tree)? */
function isI64Typed(e: HirExpr, i64: Set<string>): boolean {
  switch (e.kind) {
    case "ident":
      return i64.has(e.name);
    case "number":
      return e.ty === "i64";
    case "binary":
      return (
        INTEGER_ARITH.has(e.op) &&
        isI64Typed(e.left, i64) &&
        isI64Typed(e.right, i64)
      );
    default:
      return false;
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
  seed?: Set<string>,
): Set<string> {
  const names = new Set<string>();
  for (const stmt of stmts) {
    if (stmt.kind === "let" && !usize.has(stmt.name)) names.add(stmt.name);
  }
  // Module-wide integrality seed (series 105 / #90): param names proven integer
  // inter-procedurally — a lifted `__cb_*` element/acc param, or a free-fn param
  // integer at every call site. The greatest-fixpoint drop loop below still applies
  // (a seeded param reassigned to a fractional value is disqualified), so the seed
  // only *admits* candidates; it never overrides a local disqualification.
  if (seed) for (const n of seed) if (!usize.has(n)) names.add(n);
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

// ── Integer counter/accumulator specialization (series 103b-1) ────────────────

/** Binary ops that require operands to share a type (a member forces its sibling).
 * Comparisons keep their JS spelling in the HIR (`===`/`!==`, mapped to `==`/`!=`
 * only at emit), so both spellings are listed. */
const BALANCE_OPS = new Set([
  "+", "-", "*", "%",
  "<", ">", "<=", ">=", "==", "!=", "===", "!==",
]);

/**
 * Retype `let`-bound integer counters/accumulators from `f64` to `i64`, so a loop
 * like `for(i){ acc += i }` runs in native integer arithmetic (design 103b-1). The
 * retype is **all-or-nothing per pure-integer connected component**: a member is
 * kept only if its whole component never meets an `f64` quantity — an unbalanced
 * binary (`i < arr.length`, `i * 0.5`), a `/` (i64 division truncates), a
 * call/method argument (an `f64` parameter), or a flow into a non-member binding.
 * A surviving component touches `f64` only at a *sink* we bridge: a `return` of a
 * member from an `f64`-returning function is wrapped `… as f64` (103b-2 removes the
 * cast by specializing the return type). Values beyond `i64` range take accepted
 * `i64` semantics (ruling 1). Returns the retyped name set (for 103a's skip check).
 */
function specializeIntegerBindings(
  stmts: HirStmt[],
  usize: Set<string>,
  retTy: RustType | undefined,
): Set<string> {
  const members = computeIntegerNames(stmts, usize);
  if (members.size === 0) return members;

  for (;;) {
    let changed = false;
    const drop = (name: string): void => {
      if (members.delete(name)) changed = true;
    };
    for (const stmt of stmts) {
      if (stmt.kind === "let") {
        if (members.has(stmt.name)) {
          // A member's own initializer must be pure `i64` (not e.g. a `usize`
          // `.length`, which `computeIntegerNames` admits as integer-valued).
          if (!i64Compat(stmt.init, members)) drop(stmt.name);
        } else {
          // A member flowing into a `let` of a non-member binding crosses to `f64`.
          for (const n of memberRefs(stmt.init, members)) drop(n);
        }
      }
      // A member returned from a non-`f64` function can't be bridged with a cast.
      if (
        stmt.kind === "return" &&
        stmt.value &&
        referencesMember(stmt.value, members) &&
        !(retTy?.kind === "f64" && i64Compat(stmt.value, members))
      ) {
        for (const n of memberRefs(stmt.value, members)) drop(n);
      }
      // A `switch` discriminant that is a member: its lowered guards compare
      // against `f64` literals (`_ if x == 0.0`), which the local-`let` deferral in
      // `promoteIntegerMatches` leaves untouched — an `i64` disc would mismatch.
      if (stmt.kind === "match") {
        for (const n of memberRefs(stmt.disc, members)) drop(n);
      }
      eachStmtExpr(stmt, (e) => {
        if (e.kind === "binary") {
          if (e.op === "/") {
            // i64 division truncates (JS `/` is float) — a member can't be i64.
            for (const n of memberRefs(e, members)) drop(n);
          } else if (BALANCE_OPS.has(e.op)) {
            const refs =
              referencesMember(e.left, members) ||
              referencesMember(e.right, members);
            const balanced =
              i64Compat(e.left, members) && i64Compat(e.right, members);
            if (refs && !balanced) {
              for (const n of memberRefs(e, members)) drop(n);
            }
          }
        } else if (e.kind === "assign") {
          if (e.target.kind === "ident" && members.has(e.target.name)) {
            // A member's assignment value must be pure `i64` (a `usize`/`f64` RHS,
            // e.g. `x = arr.length`, can't land in an `i64` binding).
            if (!i64Compat(e.value, members)) drop(e.target.name);
          } else {
            for (const n of memberRefs(e.value, members)) drop(n);
          }
        } else if (e.kind === "cond") {
          // Ternary arms must share a type — a member arm with a non-i64 sibling.
          if (
            (referencesMember(e.conseq, members) ||
              referencesMember(e.alt, members)) &&
            !(i64Compat(e.conseq, members) && i64Compat(e.alt, members))
          ) {
            for (const n of memberRefs(e.conseq, members)) drop(n);
            for (const n of memberRefs(e.alt, members)) drop(n);
          }
        } else if (e.kind === "call") {
          for (const a of e.args)
            for (const n of memberRefs(a.expr, members)) drop(n);
        } else if (e.kind === "method") {
          // A member arg *or* receiver crosses into an `f64`-typed slot.
          for (const n of memberRefs(e.receiver, members)) drop(n);
          for (const a of e.args)
            for (const n of memberRefs(a, members)) drop(n);
        } else if (
          e.kind === "array" ||
          e.kind === "hashmap" ||
          e.kind === "structLit"
        ) {
          // A member placed into an `f64`-typed container element/field/entry.
          for (const n of memberRefs(e, members)) drop(n);
        }
      });
    }
    if (!changed) break;
  }
  if (members.size === 0) return members;

  // Only bother when a surviving component actually does loop-like work (a
  // reassigned counter/accumulator); a lone integer `const` gains nothing from a
  // retype and would only churn the emit.
  if (!hasReassignedMember(stmts, members)) return new Set();

  applyI64Bindings(stmts, members, retTy);
  return members;
}

/** Member names that appear anywhere in `e`. */
function memberRefs(e: HirExpr, members: Set<string>): string[] {
  const out: string[] = [];
  eachExpr(e, (n) => {
    if (n.kind === "ident" && members.has(n.name)) out.push(n.name);
  });
  return out;
}

function referencesMember(e: HirExpr, members: Set<string>): boolean {
  let found = false;
  eachExpr(e, (n) => {
    if (n.kind === "ident" && members.has(n.name)) found = true;
  });
  return found;
}

/** Is `e` a pure-`i64` expression given the member set (integer literals, member
 * idents, and integer arithmetic over them — never `len`/`/`/non-member idents)? */
function i64Compat(e: HirExpr, members: Set<string>): boolean {
  switch (e.kind) {
    case "number":
      return Number.isInteger(e.value);
    case "ident":
      return members.has(e.name);
    case "binary":
      return (
        INTEGER_ARITH.has(e.op) &&
        i64Compat(e.left, members) &&
        i64Compat(e.right, members)
      );
    default:
      return false;
  }
}

/** Does any surviving member get reassigned (i.e. is a real counter/accumulator)? */
function hasReassignedMember(
  stmts: HirStmt[],
  members: Set<string>,
): boolean {
  let found = false;
  for (const stmt of stmts) {
    eachStmtExpr(stmt, (e) => {
      if (
        e.kind === "assign" &&
        e.target.kind === "ident" &&
        members.has(e.target.name)
      ) {
        found = true;
      }
    });
  }
  return found;
}

/**
 * Retype member `let` bindings to `i64`, tag the integer literals that sit in an
 * `i64` context so they emit bare (`3`, not `3.0`), and bridge a member `return`
 * into an `f64`-returning function with an `as f64` cast.
 */
function applyI64Bindings(
  stmts: HirStmt[],
  members: Set<string>,
  retTy: RustType | undefined,
): void {
  for (const stmt of stmts) {
    if (stmt.kind === "let" && members.has(stmt.name)) {
      stmt.ty = { kind: "i64" };
      tagI64Tree(stmt.init); // the initializer of an `i64` binding is `i64`
    }
  }

  // An assignment to an `i64` member is `i64` on both sides — tag its literals
  // (covers a bare compound-assign RHS like `x += 5`, which the binary-operand
  // fixpoint below never reaches).
  for (const stmt of stmts) {
    eachStmtExpr(stmt, (e) => {
      if (
        e.kind === "assign" &&
        e.target.kind === "ident" &&
        members.has(e.target.name)
      ) {
        tagI64Tree(e.value);
      }
    });
  }

  // Propagate `i64`-ness to integer-literal operands sitting beside an `i64`
  // operand, to a fixpoint (tagging one literal can make its parent `i64`).
  for (;;) {
    let changed = false;
    for (const stmt of stmts) {
      eachStmtExpr(stmt, (e) => {
        if (e.kind !== "binary" || !BALANCE_OPS.has(e.op)) return;
        if (!isI64Expr(e.left, members) && !isI64Expr(e.right, members)) return;
        if (tagIfIntLiteral(e.left)) changed = true;
        if (tagIfIntLiteral(e.right)) changed = true;
      });
    }
    if (!changed) break;
  }

  if (retTy && retTy.kind === "f64") {
    for (const stmt of stmts) {
      if (
        stmt.kind === "return" &&
        stmt.value &&
        referencesMember(stmt.value, members) &&
        i64Compat(stmt.value, members)
      ) {
        stmt.value = { kind: "cast", expr: stmt.value, ty: { kind: "f64" } };
      }
    }
  }
}

/** Tag every integer-literal leaf of a known-`i64` expression tree. */
function tagI64Tree(e: HirExpr): void {
  if (e.kind === "number" && Number.isInteger(e.value)) {
    e.ty = "i64";
  } else if (e.kind === "binary" && INTEGER_ARITH.has(e.op)) {
    tagI64Tree(e.left);
    tagI64Tree(e.right);
  }
}

/** Tag a non-`i64` integer literal `i64`; returns whether it changed. */
function tagIfIntLiteral(e: HirExpr): boolean {
  if (e.kind === "number" && Number.isInteger(e.value) && e.ty !== "i64") {
    e.ty = "i64";
    return true;
  }
  return false;
}

/** Is `e` `i64`-typed: a member ident, an `i64`-tagged literal, or integer
 * arithmetic with at least one `i64` operand? */
function isI64Expr(e: HirExpr, members: Set<string>): boolean {
  switch (e.kind) {
    case "ident":
      return members.has(e.name);
    case "number":
      return e.ty === "i64";
    case "binary":
      return (
        INTEGER_ARITH.has(e.op) &&
        (isI64Expr(e.left, members) || isI64Expr(e.right, members))
      );
    default:
      return false;
  }
}

// ── Return-type specialization (series 103b-2) ────────────────────────────────

/**
 * Specialize a free function's `f64` return type to `i64` when 103b-1 bridged
 * *every* `return` with an `as f64` cast over an integer expression **and** every
 * call site uses the result in an `i64`-safe position — printed via `Display`
 * (`console.log(run())`) or discarded (`run();`). The bridge casts are then removed
 * (`return acc`, not `return (acc as f64)`) and the signature becomes
 * `fn f() -> i64`.
 *
 * *Preferring*, like the other integer promotions: if any call site flows the
 * result into an `f64` context we can't prove is integer-safe (a binding, further
 * arithmetic, an argument), the function keeps its `f64` return and the bridge cast
 * — no change, no fail-loud. Scoped to free functions; methods/constructors keep
 * the bridge (their call sites need receiver resolution).
 */
function specializeReturnTypes(module: HirModule): void {
  for (const item of module.items) {
    if (item.kind !== "fn" || item.ret.kind !== "f64") continue;

    const i64names = i64BindingNames(item.params, item.body);
    const returns = flattenStmts(item.body).filter(
      (s): s is Extract<HirStmt, { kind: "return" }> =>
        s.kind === "return" && s.value !== undefined,
    );
    if (returns.length === 0) continue;
    // Every return must be an `as f64` bridge over a pure-`i64` expression.
    if (!returns.every((r) => r.value && isI64Bridge(r.value, i64names)))
      continue;

    if (!allCallSitesI64Safe(module, item.name)) continue;

    for (const r of returns) {
      r.value = (r.value as Extract<HirExpr, { kind: "cast" }>).expr;
    }
    item.ret = { kind: "i64" };
  }
}

/** Names bound to `i64` in a body: `i64`-retyped `let`s (series 103b-1) and params. */
function i64BindingNames(params: HirParam[], stmts: HirStmt[]): Set<string> {
  const names = new Set<string>();
  for (const p of params) if (p.ty.kind === "i64") names.add(p.name);
  for (const s of flattenStmts(stmts)) {
    if (s.kind === "let" && s.ty?.kind === "i64") names.add(s.name);
  }
  return names;
}

/** Is `e` an `(E as f64)` bridge whose inner `E` is a pure-`i64` expression? */
function isI64Bridge(e: HirExpr, i64names: Set<string>): boolean {
  return (
    e.kind === "cast" && e.ty.kind === "f64" && i64Compat(e.expr, i64names)
  );
}

/**
 * Is every call to `fnName` across the module in an `i64`-safe result position —
 * a discarded `expr` statement (`run();`) or a `println` argument (`Display` on an
 * integer prints identically to the `f64`)? A call anywhere else (bound, in
 * arithmetic, an argument, a nested receiver) is not proven safe, so we bail.
 */
function allCallSitesI64Safe(module: HirModule, fnName: string): boolean {
  const isCall = (e: HirExpr): boolean =>
    e.kind === "call" && e.callee === fnName;
  const safe = new Set<HirExpr>();
  for (const stmts of moduleBodies(module)) {
    for (const stmt of flattenStmts(stmts)) {
      if (stmt.kind !== "expr") continue;
      if (isCall(stmt.expr)) safe.add(stmt.expr); // `run();` — discarded
      else if (stmt.expr.kind === "println") {
        for (const a of stmt.expr.args) if (isCall(a)) safe.add(a); // printed
      }
    }
  }
  let ok = true;
  eachModuleExpr(module, (e) => {
    if (isCall(e) && !safe.has(e)) ok = false;
  });
  return ok;
}

/** Every statement list in the module — function/method/ctor bodies and `main`. */
function moduleBodies(module: HirModule): HirStmt[][] {
  const bodies: HirStmt[][] = [];
  for (const item of module.items) {
    if (item.kind === "fn") bodies.push(item.body);
    else if (item.kind === "class") {
      if (item.ctor) bodies.push(item.ctor.body);
      for (const m of item.methods) bodies.push(m.body);
    }
  }
  bodies.push(module.main);
  return bodies;
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
    case "strConcat":
      // A `+`/template concatenation (`s + "x" + (i % 10)`): numeric inference must
      // reach interpolated numeric sub-expressions so an index/counter inside one is
      // typed like anywhere else (series 103b-1 — an untyped `i % 10` under an `i64`
      // `i` would be `i64 % f64`).
      for (const p of e.parts) eachExpr(p, fn);
      break;
    case "jsObjectStr":
      eachExpr(e.value, fn);
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
 * `forRange` (`for i in start..end`). Purely structural: the counter keeps its
 * type (`usize`, or an `i64` counter retyped by series 103b-1) before and after,
 * so no type can conflict. Every non-eligible loop keeps its correct while-desugar.
 * Returns the (possibly rewritten) statement list.
 */
function promoteRanges(
  stmts: HirStmt[],
  usize: Set<string>,
  i64: Set<string>,
): HirStmt[] {
  return stmts.map((stmt) => {
    const recursed = mapStmtBodies(stmt, (b) => promoteRanges(b, usize, i64));
    if (recursed.kind === "block") {
      const range = tryRange(recursed, usize, i64);
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
 * If `block` is the canonical counting-loop shape with a `usize` (index-driven,
 * series 020) or `i64` (pure-integer, series 103b-2) counter and a matching
 * integer-compatible bound, return the equivalent `forRange`; else `null`.
 */
function tryRange(
  block: Extract<HirStmt, { kind: "block" }>,
  usize: Set<string>,
  i64: Set<string>,
): HirStmt | null {
  if (block.body.length !== 2) return null;
  const [letStmt, whileStmt] = block.body;
  if (!letStmt || letStmt.kind !== "let") return null;
  if (!whileStmt || whileStmt.kind !== "while") return null;

  const counter = letStmt.name;
  const isI64 = !usize.has(counter) && i64.has(counter);
  if (!usize.has(counter) && !isI64) return null; // usize or i64 counters only
  const counterTy: "usize" | "i64" = isI64 ? "i64" : "usize";

  const cond = whileStmt.cond;
  if (cond.kind !== "binary") return null;
  if (!isNamedIdent(cond.left, counter)) return null;
  if (!isIntegerBound(cond.right, usize, i64, counterTy)) return null;

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
      start: tagIntIfInt(letStmt.init, counterTy),
      end: tagIntIfInt(cond.right, counterTy),
      inclusive: cond.op === "<=",
      step: step.by,
      body: inner,
      label,
      counterTy,
    };
  }
  // Descending unit step (series 064): `(lo..=hi).rev()` counts `hi…lo`. `i > E`
  // stops at `E+1` (lo = E+1); `i >= E` includes `E` (lo = E). `hi` is the init.
  // Non-unit descending step ranges stay `while`.
  if (descending && step.dir === "down" && step.by === 1) {
    const lo =
      cond.op === ">"
        ? addOne(tagIntIfInt(cond.right, counterTy), counterTy)
        : tagIntIfInt(cond.right, counterTy);
    return {
      kind: "forRange",
      counter,
      start: lo,
      end: tagIntIfInt(letStmt.init, counterTy),
      inclusive: true,
      descending: true,
      body: inner,
      label,
      counterTy,
    };
  }
  return null;
}

/** `e + 1`, folded when `e` is an integer literal (keeps the counter's int tag). */
function addOne(e: HirExpr, counterTy: "usize" | "i64"): HirExpr {
  if (e.kind === "number" && Number.isInteger(e.value)) {
    return { ...e, value: e.value + 1 };
  }
  return {
    kind: "binary",
    op: "+",
    left: e,
    right: { kind: "number", value: 1, ty: counterTy },
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

/**
 * Is the loop bound compatible with the counter's type? A `usize` counter accepts
 * a `.len()`, a non-negative integer literal, or another `usize`. An `i64` counter
 * (series 103b-2) accepts an integer literal or another `i64` — never a `.len()`
 * or `usize` (those would type-mismatch the `i64` range element).
 */
function isIntegerBound(
  e: HirExpr,
  usize: Set<string>,
  i64: Set<string>,
  counterTy: "usize" | "i64",
): boolean {
  if (counterTy === "i64") {
    if (e.kind === "number") return Number.isInteger(e.value);
    if (e.kind === "ident") return i64.has(e.name);
    return false;
  }
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

/**
 * Tag an integer-literal range endpoint with the counter's type so it emits bare
 * (`5000000`, not `5000000.0`). A `usize` endpoint must be non-negative; an `i64`
 * endpoint may be negative. A non-literal endpoint is returned unchanged.
 */
function tagIntIfInt(e: HirExpr, counterTy: "usize" | "i64"): HirExpr {
  if (e.kind !== "number" || !Number.isInteger(e.value)) return e;
  if (counterTy === "usize" && e.value < 0) return e;
  return { ...e, ty: counterTy };
}

function isNamedIdent(e: HirExpr, name: string): boolean {
  return e.kind === "ident" && e.name === name;
}

// ── Module-wide integrality seeds (series 105 / #90) ──────────────────────────

/**
 * A body that owns numeric params we may prove integer-valued: a free function,
 * a method, a constructor, or a lifted `__cb_*` callback (series 048). `main` is
 * included (no params) so its bindings and adapter chains act as integrality
 * *sources* for the callbacks they feed.
 */
interface FnUnit {
  body: HirStmt[];
  params: HirParam[];
  usize: Set<string>;
  /** Free-fn / ctor / `__cb_*` name for call-site & adapter matching; else null. */
  callKey: string | null;
  /** True for a lifted `__cb_*` callback (seeded from its adapter, not call sites). */
  isCb: boolean;
}

/**
 * A lifted callback's adapter site (series 105): the one `map`/`filter`/`reduce`/…
 * that references it, plus the param names it seeds and where the input element
 * comes from. A callback is single-use (048), so it has exactly one such site.
 */
interface CbSite {
  unit: FnUnit;
  /** The Vec/iterator whose element feeds the callback element param. */
  source: HirExpr;
  /** Body owning the adapter (for typing a reduce's `init`). */
  ownerBody: HirStmt[];
  /** Callback param name(s) taking the input element (map/filter elem; reduce elem). */
  elemNames: string[];
  /** A reduce accumulator param, seeded from `init` ∧ the fold staying integer. */
  accName?: string;
  init?: HirExpr;
}

/**
 * Compute, per function body, the set of param names provably integer-valued
 * module-wide (series 105 / #90) — the graduation of 103's intra-body integer
 * inference into lifted callbacks and across call sites. A greatest fixpoint over
 * the integrality lattice: start every candidate param `Int`, demote to `Real` on
 * the first contact with a fractional quantity, to a fixpoint. The result seeds
 * `tagIntegerModulo` so an integer-domain `%` inside a callback body (`v % 5`)
 * specializes to a hardware modulo, exactly as 103a does for a `let` counter.
 *
 * v1 seeds the modulo tag only — it does **not** retype params/elements to `i64`
 * (deferred), and it seeds only the element/acc params (a callback's forwarded
 * free-var and index params stay `f64`, the always-safe default). Soundness rests
 * on the seed admitting a param *only when proven* integer: a fractional source
 * element, an upstream `/`, or a single fractional call site each demote it, so the
 * `as i64` cast never truncates real data (specs CI5–CI8).
 */
function computeIntegralitySeeds(module: HirModule): Map<HirStmt[], Set<string>> {
  const units: FnUnit[] = [];
  const byCallKey = new Map<string, FnUnit>();

  const mkUnit = (
    body: HirStmt[],
    params: HirParam[],
    callKey: string | null,
  ): FnUnit => {
    const u: FnUnit = {
      body,
      params,
      usize: computeUsizeNames(flattenStmts(body)),
      callKey,
      isCb: callKey !== null && callKey.startsWith("__cb_"),
    };
    units.push(u);
    if (callKey) byCallKey.set(callKey, u);
    return u;
  };

  for (const item of module.items) {
    if (item.kind === "fn") {
      mkUnit(item.body, item.params, item.name);
    } else if (item.kind === "class") {
      if (item.ctor) mkUnit(item.ctor.body, item.ctor.params, `${item.name}::new`);
      // Methods are not seeded in v1 (receiver-class call-site resolution is a
      // follow-up); their params stay `f64` — conservative, never unsound.
      for (const m of item.methods) mkUnit(m.body, m.params, null);
    }
  }
  const mainUnit = mkUnit(module.main, [], null);

  // Precompute the callback adapter sites and the free-fn call sites once — the
  // call graph is static across the fixpoint; only argument integrality changes.
  const cbSites: CbSite[] = [];
  const callSites: { callee: FnUnit; args: HirExpr[]; ownerBody: HirStmt[] }[] = [];
  for (const u of units) {
    for (const stmt of flattenStmts(u.body)) {
      eachStmtExprDeep(stmt, (e) => {
        const site = adapterCbSite(e, byCallKey, u.body);
        if (site) cbSites.push(site);
        if (e.kind === "call") {
          const callee = byCallKey.get(e.callee);
          if (callee && !callee.isCb) {
            callSites.push({
              callee,
              args: e.args.map((a) => a.expr),
              ownerBody: u.body,
            });
          }
        }
      });
    }
  }
  const calledUnits = new Set(callSites.map((s) => s.callee));

  // Lattice state (start optimistic): a callback's element/acc param and a *called*
  // free-fn's params start `Int`; everything else (methods, uncalled free fns, main)
  // starts empty — unprovable ⇒ `Real`, the safe default.
  const seed = new Map<FnUnit, Set<string>>();
  const retInt = new Map<FnUnit, boolean>();
  for (const u of units) {
    retInt.set(u, true);
    if (u.isCb) {
      seed.set(u, new Set()); // filled by its CbSite in the loop below
    } else if (calledUnits.has(u)) {
      seed.set(u, new Set(u.params.map((p) => p.name)));
    } else {
      seed.set(u, new Set());
    }
  }
  for (const cs of cbSites) {
    const s = seed.get(cs.unit);
    if (s) {
      for (const n of cs.elemNames) s.add(n);
      if (cs.accName) s.add(cs.accName);
    }
  }

  // Greatest fixpoint: every step only *removes* names / demotes `retInt`, so the
  // monotone-decreasing state converges.
  for (;;) {
    let changed = false;
    const drop = (u: FnUnit, name: string): void => {
      if (seed.get(u)?.delete(name)) changed = true;
    };

    const names = new Map<FnUnit, Set<string>>();
    for (const u of units) {
      names.set(
        u,
        computeIntegerNames(flattenStmts(u.body), u.usize, seed.get(u)),
      );
    }

    // Return integrality: every `return` value integer-valued (map callbacks feed
    // the next stage's element; a reduce's fold keeps the accumulator integer).
    for (const u of units) {
      const rets = flattenStmts(u.body).filter(
        (s): s is Extract<HirStmt, { kind: "return" }> =>
          s.kind === "return" && s.value !== undefined,
      );
      const ri =
        rets.length > 0 &&
        rets.every((r) => isIntegerValued(r.value!, names.get(u)!, u.usize));
      if (retInt.get(u) && !ri) {
        retInt.set(u, false);
        changed = true;
      }
    }

    // Element integrality per body, and the callback-element demotion it drives.
    const elemInt = (
      e: HirExpr,
      nm: Set<string>,
      usize: Set<string>,
      vec: Map<string, boolean>,
    ): boolean => elemIntOf(e, nm, usize, vec, byCallKey, retInt, elemInt);

    for (const cs of cbSites) {
      // Recompute the source body's Vec element map, then the input element.
      const owner = units.find((u) => u.body === cs.ownerBody)!;
      const nm = names.get(owner)!;
      const vec = computeVecElem(owner, nm, elemInt);
      const inElem = elemInt(cs.source, nm, owner.usize, vec);
      if (!inElem) for (const n of cs.elemNames) drop(cs.unit, n);
      if (cs.accName) {
        const accOk =
          cs.init !== undefined &&
          isIntegerValued(cs.init, nm, owner.usize) &&
          retInt.get(cs.unit)!;
        if (!accOk) drop(cs.unit, cs.accName);
      }
    }

    // A free-fn param is integer only if integer at *every* call site.
    for (const site of callSites) {
      const owner = units.find((u) => u.body === site.ownerBody)!;
      const nm = names.get(owner)!;
      site.callee.params.forEach((p, i) => {
        const arg = site.args[i];
        if (arg && !isIntegerValued(arg, nm, owner.usize)) drop(site.callee, p.name);
      });
    }

    if (!changed) break;
  }

  const result = new Map<HirStmt[], Set<string>>();
  for (const u of units) {
    const s = seed.get(u)!;
    if (s.size > 0) result.set(u.body, s);
  }
  void mainUnit;
  return result;
}

/** Element integrality of a Vec/iterator-valued expression (series 105). */
function elemIntOf(
  e: HirExpr,
  nm: Set<string>,
  usize: Set<string>,
  vec: Map<string, boolean>,
  byCallKey: Map<string, FnUnit>,
  retInt: Map<FnUnit, boolean>,
  recur: (
    e: HirExpr,
    nm: Set<string>,
    usize: Set<string>,
    vec: Map<string, boolean>,
  ) => boolean,
): boolean {
  switch (e.kind) {
    case "ident":
      return vec.get(e.name) ?? false;
    case "array":
      return e.elements.every((el) => isIntegerValued(el, nm, usize));
    case "iterMap": {
      const cb = byCallKey.get(e.cbName);
      // A `map` output element is integer iff its source element is *and* the
      // callback returns an integer (its `retInt`, computed with the seed above).
      return recur(e.receiver, nm, usize, vec) && !!cb && retInt.get(cb) === true;
    }
    case "arrayFromMap": {
      const cb = byCallKey.get(e.cbName);
      return recur(e.source, nm, usize, vec) && !!cb && retInt.get(cb) === true;
    }
    case "iterFilter":
      // `filter` preserves its input element's integrality.
      return recur(e.receiver, nm, usize, vec);
    case "collectVec":
      return recur(e.iter, nm, usize, vec);
    default:
      // flatMap/find/etc. are not element sources for a downstream modulo in v1.
      return false;
  }
}

/**
 * Per-body element integrality of every `Vec` `let` binding (series 105): an
 * array literal or an adapter chain types directly; an empty `vec![]` grown by
 * `push` is integer iff every pushed value is. Statements are visited in order so a
 * later stage's receiver (`doubled` in `doubled.filter(…)`) is already resolved.
 */
function computeVecElem(
  unit: FnUnit,
  nm: Set<string>,
  elemInt: (
    e: HirExpr,
    nm: Set<string>,
    usize: Set<string>,
    vec: Map<string, boolean>,
  ) => boolean,
): Map<string, boolean> {
  const vec = new Map<string, boolean>();
  for (const stmt of flattenStmts(unit.body)) {
    if (stmt.kind === "let" && isVecType(stmt.ty)) {
      vec.set(stmt.name, elemInt(stmt.init, nm, unit.usize, vec));
    }
    // A `push` narrows its receiver's element (an empty `vec![]` starts vacuously
    // integer and each push either keeps or breaks it).
    if (stmt.kind === "expr" && stmt.expr.kind === "method" && stmt.expr.name === "push") {
      const recv = stmt.expr.receiver;
      const arg = stmt.expr.args[0];
      if (recv.kind === "ident" && vec.has(recv.name) && arg) {
        vec.set(
          recv.name,
          vec.get(recv.name)! && isIntegerValued(arg, nm, unit.usize),
        );
      }
    }
  }
  return vec;
}

/** Is `t` a `Vec<…>` binding type (an element-bearing container)? */
function isVecType(t: RustType | null | undefined): boolean {
  return t?.kind === "vec";
}

/**
 * The callback adapter site for `e` if it lifts one (series 105): the receiver/
 * source whose element feeds the callback, and the element/acc param names.
 */
function adapterCbSite(
  e: HirExpr,
  byCallKey: Map<string, FnUnit>,
  ownerBody: HirStmt[],
): CbSite | null {
  switch (e.kind) {
    case "iterMap":
    case "iterFilter":
    case "iterFlatMap":
    case "iterFind":
    case "iterAny":
    case "iterAll": {
      const unit = byCallKey.get(e.cbName);
      if (!unit) return null;
      return { unit, source: e.receiver, ownerBody, elemNames: [e.elemParam] };
    }
    case "arrayFromMap": {
      const unit = byCallKey.get(e.cbName);
      if (!unit) return null;
      return { unit, source: e.source, ownerBody, elemNames: [e.elemParam] };
    }
    case "iterReduce": {
      const unit = byCallKey.get(e.cbName);
      if (!unit) return null;
      return {
        unit,
        source: e.receiver,
        ownerBody,
        elemNames: [e.elem],
        accName: e.acc,
        init: e.init,
      };
    }
    default:
      return null;
  }
}

/**
 * Visit every expression in a statement, descending into the receivers/init of the
 * borrow-only iterator terminals (`reduce`/`find`/`some`/`every`) that `eachExpr`
 * stops at, so a nested adapter chain (`xs.map(…).reduce(…)`) is fully reached
 * (series 105). Each node is visited exactly once.
 */
function eachStmtExprDeep(stmt: HirStmt, fn: (e: HirExpr) => void): void {
  for (const root of stmtRootExprs(stmt)) eachExprAll(root, fn);
}

/** Fully walk one expression tree, including the iter-terminal edges `eachExpr` skips. */
function eachExprAll(e: HirExpr, fn: (e: HirExpr) => void): void {
  eachExpr(e, (n) => {
    fn(n);
    if (n.kind === "iterReduce") {
      eachExprAll(n.receiver, fn);
      eachExprAll(n.init, fn);
    } else if (n.kind === "iterFind" || n.kind === "iterAny" || n.kind === "iterAll") {
      eachExprAll(n.receiver, fn);
    } else if (n.kind === "arrayFromMap") {
      eachExprAll(n.source, fn);
    }
  });
}

/** The root expression(s) a statement carries directly (mirrors `eachStmtExpr`). */
function stmtRootExprs(stmt: HirStmt): HirExpr[] {
  switch (stmt.kind) {
    case "let":
      return [stmt.init];
    case "return":
      return stmt.value ? [stmt.value] : [];
    case "expr":
      return [stmt.expr];
    case "if":
    case "while":
      return [stmt.cond];
    case "forIn":
      return [stmt.iter];
    case "forRange":
      return [stmt.start, stmt.end];
    case "match":
      return [stmt.disc, ...stmt.arms.flatMap((a) => (a.guard ? [a.guard] : []))];
    case "throw":
    case "breakTry":
    case "carrierErr":
      return [stmt.value];
    case "carrierBreak":
      return stmt.value ? [stmt.value] : [];
    default:
      return [];
  }
}
