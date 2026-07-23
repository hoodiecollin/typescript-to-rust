/**
 * Lowering: callback lifting (series 048/057/094). A callback argument to a
 * recognized higher-order adapter (`map`/`filter`/`forEach`/…) is lifted to a
 * free `fn` when its body is a liftable shape: `liftCallback` validates the arrow,
 * `freeVarsOf` finds the captured environment (rejecting mutable captures),
 * `typeCbBody` types the lifted body, and `liftFlatMapTernaryBody` handles the
 * flatMap-ternary special case. Extracted from the lowering monolith (series
 * 109); the core lowerer, the element-use classifier, and `truthyCond` are
 * imported from `./index`.
 */

import type { ModuleAnalysis } from "../analysis";
import type {
  ArrowFunctionExpression,
  BlockStatement,
  Expression,
  ReturnStatement,
} from "../ast";
import { UnsupportedError } from "../errors";
import type { ElemMode, HirExpr, HirParam, HirStmt, RustType } from "../hir";
import { CB_GLOBALS } from "./constants";
import { classifyElementUse, lowerExpr, truthyCond } from "./index";
import { isAstNode, isCopyRustType, sameRustType } from "./utils";

// ── Callback lifting (series 048) ─────────────────────────────────────────────

/**
 * Array adapter methods whose arrow callback is lifted to a `__cb_*` fn (series
 * 048). An `async` callback in one of these is fail-loud until series 051b wires
 * the `join_all` consumer (series 054c guard).
 */
export const LIFT_ADAPTERS = new Set([
  "map",
  "filter",
  "find",
  "some",
  "every",
  "reduce",
  "sort",
]);

/**
 * Extract an `arity`-param, expression-bodied arrow's param names and body
 * expression (series 048; formerly `arrowClosureN`). The body is the arrow's
 * expression, or a block of exactly one `return <expr>`. A wrong param count,
 * `async`, destructured params, and multi-statement bodies are all fail-loud.
 */
function arrowShape(
  arrow: ArrowFunctionExpression,
  arity: number,
  maxArity: number = arity,
): { params: string[]; bodyExpr: Expression } {
  if (arrow.async) {
    throw new UnsupportedError({ type: "async arrow closure" });
  }
  if (arrow.params.length < arity || arrow.params.length > maxArity) {
    throw new UnsupportedError({
      type:
        arity === maxArity
          ? `closure must take exactly ${arity} parameter(s)`
          : `closure must take ${arity}–${maxArity} parameter(s)`,
    });
  }
  const params = arrow.params.map((p) => p.name);
  if (params.some((p) => !p)) {
    throw new UnsupportedError({ type: "closure parameter binding" });
  }
  let bodyExpr: Expression;
  if (arrow.expression) {
    bodyExpr = arrow.body as Expression;
  } else {
    const b = arrow.body as BlockStatement;
    const only = b.body.length === 1 ? b.body[0] : undefined;
    const ret =
      only?.type === "ReturnStatement" ? (only as ReturnStatement) : null;
    if (ret?.argument) {
      bodyExpr = ret.argument;
    } else {
      throw new UnsupportedError({
        type: "closure body must be an expression or a single return",
      });
    }
  }
  return { params: params as string[], bodyExpr };
}

/**
 * Source-level (pre-lowering) collection-mutating method names — a call to one of
 * these on a **captured** receiver is a mutable capture (series 078 / issue #45,
 * the field-collection-capture residual → #46). Mirrors `MUTATING_METHODS` in
 * `analysis.ts`; kept local to the capture check.
 */
const CAPTURE_MUTATORS = new Set<string>([
  "set",
  "add",
  "delete",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "clear",
]);

/**
 * The free variables of a callback body, in first-occurrence order: the
 * `Identifier`s it reads that are not its own params, a top-level fn name, a
 * declared nominal type, a member-access property, or a known global. A free var
 * that is *assigned* (an `=` LHS, or a `++`/`--` target) is a scalar mutable capture
 * — fail-loud (series 048; the user lifts it to a named fn taking the state). A free
 * var mutated through a **collection method** (`xs.push(…)`, `s.add(…)`) is a
 * container capture (series 079, issue #46): reported in `mutated` so `liftCallback`
 * forwards it `&mut` instead of rejecting it. `names` includes both read and mutated
 * captures (a container read-and-mutated appears once, in `mutated`).
 */
function freeVarsOf(
  body: Expression,
  params: Set<string>,
  analysis: ModuleAnalysis,
): { names: string[]; mutated: Set<string> } {
  const excluded = (name: string): boolean =>
    params.has(name) ||
    analysis.fns.has(name) ||
    analysis.structs.has(name) ||
    CB_GLOBALS.has(name);
  // The root identifier of a member chain (`c.entries` / `c.a.b` → `c`), or null.
  const rootOf = (node: unknown): string | null => {
    let cur: unknown = node;
    while (isAstNode(cur) && cur.type === "MemberExpression") cur = cur.object;
    return isAstNode(cur) && cur.type === "Identifier"
      ? (cur.name as string)
      : null;
  };
  const seen = new Set<string>();
  const order: string[] = [];
  const mutated = new Set<string>();
  const mutableCapture = (): never => {
    throw new UnsupportedError({
      type: "mutable capture in a callback (lift to a named fn taking the state as an explicit param)",
    });
  };
  const record = (name: string): void => {
    if (!excluded(name) && !seen.has(name)) {
      seen.add(name);
      order.push(name);
    }
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isAstNode(node)) return;
    switch (node.type) {
      case "Identifier": {
        record(node.name as string);
        return;
      }
      case "MemberExpression": {
        visit(node.object);
        // A non-computed property (`obj.prop`) is a field name, not a free var.
        if (node.computed) visit(node.property);
        return;
      }
      case "AssignmentExpression": {
        const left = node.left;
        if (isAstNode(left) && left.type === "Identifier") {
          if (!params.has(left.name as string)) mutableCapture();
        } else {
          visit(left);
        }
        visit(node.right);
        return;
      }
      case "UpdateExpression": {
        const arg = node.argument;
        if (
          isAstNode(arg) &&
          arg.type === "Identifier" &&
          !params.has(arg.name as string)
        ) {
          mutableCapture();
        }
        visit(arg);
        return;
      }
      case "CallExpression": {
        // A collection-mutating method on a **captured** receiver
        // (`c.entries.set(…)` / `xs.push(…)` where `xs` is a free var) mutates
        // captured state through a method — reachable only through the receiver chain
        // rather than an assignment. Series 079 (issue #46) graduates the **bare**
        // captured-container case: it is recorded in `mutated` so the container is
        // forwarded `&mut` (not rejected). A mutation of a **field** of a captured
        // owner (`c.entries.set(…)`, a nested receiver) still needs promotion — that
        // stays fail-loud (the #45-coupled Rc row). A property mutator on a param
        // receiver is fine.
        const callee = node.callee;
        if (
          isAstNode(callee) &&
          callee.type === "MemberExpression" &&
          isAstNode(callee.property) &&
          callee.property.type === "Identifier" &&
          CAPTURE_MUTATORS.has(callee.property.name as string)
        ) {
          const recv = callee.object;
          const root = rootOf(recv);
          // A bare captured receiver (`xs.push(…)`, `xs` an Identifier) → `&mut`
          // forward. A field-of-captured receiver (`c.entries.set(…)`) is a deeper
          // shape (→ Rc row) → fail-loud.
          if (root && !excluded(root)) {
            if (isAstNode(recv) && recv.type === "Identifier") {
              record(root);
              mutated.add(root);
            } else {
              mutableCapture();
            }
          }
        }
        visit(node.callee);
        node.arguments && visit(node.arguments);
        return;
      }
      default: {
        for (const key in node) {
          if (key === "type") continue;
          visit(node[key]);
        }
      }
    }
  };
  visit(body);
  return { names: order, mutated };
}

/**
 * Is a `RustType` a container a lifted callback can forward by reference (series
 * 079): a `Vec`, `Set`, `Map`, or `String`. These are the shapes `freeVarsOf`
 * classifies read/mut and `liftCallback` threads as `&T` / `&mut T`.
 */
function isCaptureContainerType(ty: RustType): boolean {
  return (
    ty.kind === "vec" ||
    ty.kind === "set" ||
    ty.kind === "hashmap" ||
    ty.kind === "String"
  );
}

/**
 * The bounded expression typer (series 048): types a lifted callback body over
 * the numeric surface — arithmetic → `f64`, comparison/logical → `bool`, `!` →
 * `bool`, `-x` → the operand type, a literal by its kind, an identifier by `ctx`
 * (the param + free-var types). Anything else fails loud (numeric arrays first).
 */
export function typeCbBody(e: HirExpr, ctx: Map<string, RustType>): RustType {
  switch (e.kind) {
    case "number":
      return { kind: "f64" };
    case "bool":
      return { kind: "bool" };
    case "string":
      return { kind: "String" };
    case "ident": {
      const t = ctx.get(e.name);
      if (!t) {
        throw new UnsupportedError({
          type: `cannot lift callback: free variable '${e.name}' has unknown type`,
        });
      }
      return t;
    }
    case "binary": {
      if (["+", "-", "*", "/", "%"].includes(e.op)) return { kind: "f64" };
      if (
        ["<", ">", "<=", ">=", "===", "!==", "==", "!=", "&&", "||"].includes(
          e.op,
        )
      ) {
        return { kind: "bool" };
      }
      throw new UnsupportedError({
        type: "callback body too complex to lift (numeric surface only)",
      });
    }
    case "unary":
      if (e.op === "!") return { kind: "bool" };
      if (e.op === "-") return typeCbBody(e.operand, ctx);
      throw new UnsupportedError({
        type: "callback body too complex to lift (numeric surface only)",
      });
    case "array": {
      // A `flatMap` callback returns a `U[]` (series 085): type every element,
      // require them uniform, and return `Vec<U>` — the one-level element unwrap
      // (the lifted `fn` returns `Vec<U>`, so `flat_map` flattens to `Vec<U>`).
      // An empty or heterogeneous array (the `U | U[]` union case) is fail-loud →
      // the recursive/dynamic value model, epic #59.
      if (e.elements.length === 0) {
        throw new UnsupportedError({
          type: "cannot lift flatMap callback: empty array-literal return (element type unknown)",
        });
      }
      const elemTypes = e.elements.map((el) => typeCbBody(el, ctx));
      const first = elemTypes[0] as RustType;
      for (const t of elemTypes) {
        if (!sameRustType(t, first)) {
          throw new UnsupportedError({
            type: "cannot lift flatMap callback: heterogeneous array-literal return (a `U | U[]` union stays fail-loud → #59)",
          });
        }
      }
      return { kind: "vec", elem: first };
    }
    default:
      throw new UnsupportedError({
        type: "callback body too complex to lift (numeric surface only)",
      });
  }
}

/**
 * Lift a callback arrow's body to a top-level `__cb_<method>_<n>` fn (series
 * 048): its params are the arrow's own params (typed by `elemType`, or `accType`
 * for a reduce's first param) followed by its read-only Copy free vars; its
 * return type is the bounded typer's result. Returns the callback's name, its
 * param names, and the free-var idents to forward at the shim.
 */
export function liftCallback(
  arrow: ArrowFunctionExpression,
  analysis: ModuleAnalysis,
  method: string,
  elemType: RustType,
  arity: number,
  accType?: RustType,
  opts?: { indexAllowed?: boolean },
): {
  cbName: string;
  paramNames: string[];
  forwarded: HirExpr[];
  elemMode: ElemMode;
  indexParam?: string;
} {
  // The index param `(el, i)` (series 057) is a single extra param, on `map` only.
  const indexAllowed = opts?.indexAllowed ?? false;
  // A third `(el, i, arr)` param — the whole array — forces a second borrow of the
  // receiver mid-iteration and muddies the pure-fn shape: fail-loud (057 residual).
  if (indexAllowed && arrow.params.length >= arity + 2) {
    throw new UnsupportedError({
      type: `whole-array ('arr') callback parameter in '.${method}' — a second borrow of the receiver (fail-loud residual, series 057)`,
    });
  }
  const { params, bodyExpr } = arrowShape(
    arrow,
    arity,
    indexAllowed ? arity + 1 : arity,
  );
  const indexParam = params.length > arity ? (params[arity] as string) : undefined;
  const paramSet = new Set(params);
  const freeNames = freeVarsOf(bodyExpr, paramSet, analysis);

  // Element passing (series 057): a Copy element forwards by value (`copy`); a
  // non-Copy element is classified read-only (`borrow`, `&T`) vs consumed (`clone`,
  // owned `T`) from a local walk of the one body. `reduce`/`sort` (arity 2) don't
  // yet borrow their element — a non-Copy element there stays fail-loud.
  let elemMode: ElemMode = "copy";
  if (!isCopyRustType(elemType)) {
    if (arity !== 1) {
      throw new UnsupportedError({
        type: `'.${method}' over a non-Copy element type — element borrowing is only wired for map/filter/find/some/every (fail-loud residual, series 057)`,
      });
    }
    const use = classifyElementUse(bodyExpr, params[0] as string);
    if (use === "unresolved") {
      throw new UnsupportedError({
        type: `cannot classify the callback's element parameter '${params[0]}' as read-only or consumed — no silent clone (fail-loud, series 057)`,
      });
    }
    elemMode = use === "consume" ? "clone" : "borrow";
  }
  // A borrowed non-Copy element becomes a `&T` param (refined to `&str` for a
  // read-only String by `refineStrings`); copy/clone keep the owned element type.
  const elemParamTy: RustType =
    elemMode === "borrow"
      ? { kind: "ref", mut: false, inner: elemType }
      : elemType;

  // Param types: own params first, then each free var (Copy scalars only). The
  // typer `ctx` uses the element's *value* type (not the `&T` borrow). Arity 2 is
  // `reduce` (`acc` typed by `init`, `elem` Copy) or `sort` (both Copy elements);
  // arity 1 is the single element, which may borrow (`&T`) under `elemMode`.
  const ctx = new Map<string, RustType>();
  let ownParams: HirParam[];
  if (arity === 2) {
    const firstTy = accType ?? elemType;
    ownParams = [
      { name: params[0] as string, ty: firstTy },
      { name: params[1] as string, ty: elemType },
    ];
    ctx.set(params[0] as string, firstTy);
    ctx.set(params[1] as string, elemType);
  } else {
    ownParams = [{ name: params[0] as string, ty: elemParamTy }];
    ctx.set(params[0] as string, elemType);
  }
  if (indexParam) {
    // The index joins the f64 numeric surface (decision 2026-07-09): `number` is
    // uniformly f64, and JS's callback index *is* a number, so the shim forwards
    // `i as f64`. This lets arithmetic bodies (`x + i`) work and bind to `number[]`
    // — `usize` would clash with the f64 literals/result and only admit a bare `i`.
    ownParams.push({ name: indexParam, ty: { kind: "f64" } });
    ctx.set(indexParam, { kind: "f64" });
  }

  const freeParams: HirParam[] = [];
  const forwarded: HirExpr[] = [];
  for (const name of freeNames.names) {
    const t = analysis.bindingTypes.get(name);
    if (!t) {
      throw new UnsupportedError({
        type: `cannot lift callback: free variable '${name}' has unknown type`,
      });
    }
    if (isCopyRustType(t)) {
      // A Copy scalar forwards by value (the shipped 048 path, unchanged).
      ctx.set(name, t);
      freeParams.push({ name, ty: t });
      forwarded.push({ kind: "ident", name });
      continue;
    }
    // A captured **container** (Set/Map/Vec/String) forwards by reference (series
    // 079, issue #46): `&mut T` when the body mutates it through a method, else `&T`.
    // The single call site borrows the arg accordingly (`&env` / `&mut env`). Body
    // references already lower to method calls on the param name — no rewrite beyond
    // the `&`/`&mut` param type. The typer `ctx` keeps the *value* type.
    if (isCaptureContainerType(t)) {
      const mut = freeNames.mutated.has(name);
      ctx.set(name, t);
      freeParams.push({ name, ty: { kind: "ref", mut, inner: t } });
      forwarded.push({ kind: "ref", mut, expr: { kind: "ident", name } });
      continue;
    }
    throw new UnsupportedError({
      type: `cannot lift callback: free variable '${name}' is not a Copy scalar or a threadable container (only read-only scalars and Set/Map/Array/String captures forward)`,
    });
  }

  // A `flatMap` callback whose body is a ternary `cond ? U : U[]` (series 092)
  // lifts to a fn returning a uniform `Vec<U>` — the scalar arm is wrapped
  // `vec![x]`, so `flat_map`'s one-level flatten yields a homogeneous result. The
  // single-expression path (everything else) lowers + types the body directly.
  let ret: RustType;
  let fnBody: HirStmt[];
  // Unwrap source parens (`(cond ? … : …)`) so a parenthesized ternary body is
  // recognized (the emitter re-parenthesizes from precedence).
  let unwrapped = bodyExpr;
  while (unwrapped.type === "ParenthesizedExpression") {
    unwrapped = (unwrapped as unknown as { expression: Expression }).expression;
  }
  if (method === "flatMap" && unwrapped.type === "ConditionalExpression") {
    const t = liftFlatMapTernaryBody(
      unwrapped as unknown as {
        test: Expression;
        consequent: Expression;
        alternate: Expression;
      },
      ctx,
      analysis,
    );
    ret = t.ret;
    fnBody = t.fnBody;
  } else {
    const body = lowerExpr(bodyExpr, analysis);
    ret = typeCbBody(body, ctx);
    fnBody = [{ kind: "return", value: body }];
  }
  const cbName = `__cb_${method}_${++analysis.liftCounter}`;
  analysis.liftedFns.push({
    kind: "fn",
    name: cbName,
    // Async-aware lift (series 054c): an `async` callback lifts to an `async fn`.
    // This is readiness for 051b (dynamic `join_all` fan-out consumes it); in 054
    // the adapter guard (see `lowerCall`) rejects an async callback before it is
    // lifted, so this stays `false` in practice until 051b removes that guard.
    isAsync: arrow.async,
    params: [...ownParams, ...freeParams],
    ret,
    body: fnBody,
  });
  return { cbName, paramNames: params, forwarded, elemMode, indexParam };
}

/**
 * Lift a `flatMap` callback whose body is a ternary `cond ? U : U[]` (series 092).
 * JS `flatMap` flattens one level, so a scalar arm contributes one element and an
 * array arm is spread — the homogeneous result is `Vec<U>`. A **scalar** arm `x`
 * (element `U`) is wrapped `vec![x]`; an **array-literal** arm `[a, b]` already
 * yields `Vec<U>`; both arms must share `U`. The lifted body is
 * `if cond { return <Vec<U>> } else { return <Vec<U>> }`. Genuinely-different arm
 * types, an empty-array arm, or a non-array/non-scalar arm stay fail-loud (the
 * dynamic-value residual → epic #59).
 */
function liftFlatMapTernaryBody(
  cond: { test: Expression; consequent: Expression; alternate: Expression },
  ctx: Map<string, RustType>,
  analysis: ModuleAnalysis,
): { ret: RustType; fnBody: HirStmt[] } {
  const normalizeArm = (arm: Expression): { expr: HirExpr; elem: RustType } => {
    const hir = lowerExpr(arm, analysis);
    const ty = typeCbBody(hir, ctx);
    // An array-literal arm already yields `Vec<U>`; a scalar arm `x` → `vec![x]`.
    return ty.kind === "vec"
      ? { expr: hir, elem: ty.elem }
      : { expr: { kind: "array", elements: [hir] }, elem: ty };
  };
  const consequent = normalizeArm(cond.consequent);
  const alternate = normalizeArm(cond.alternate);
  if (!sameRustType(consequent.elem, alternate.elem)) {
    throw new UnsupportedError({
      type: "cannot lift flatMap ternary callback: arms have different element types (a genuinely dynamic `U | V` stays fail-loud → #59)",
    });
  }
  // Series 094: build the ternary through the shared expression-position `cond`
  // node — `return (if cond { <Vec<U>> } else { <Vec<U>> })` — instead of a
  // hand-rolled statement-`if` with `return`s. One ternary lowering, one emitter
  // path. The arm normalization (scalar → `vec![x]`) above is unchanged.
  return {
    ret: { kind: "vec", elem: consequent.elem },
    fnBody: [
      {
        kind: "return",
        value: {
          kind: "cond",
          test: truthyCond(cond.test, analysis),
          conseq: consequent.expr,
          alt: alternate.expr,
        },
      },
    ],
  };
}
