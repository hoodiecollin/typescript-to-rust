/**
 * Lowering: ESTree AST → typed HIR.
 *
 * This is the single place where the dialect is enforced and where analysis is
 * consumed. It resolves TS annotations to `RustType`, folds parameter borrow
 * forms (`&T` / `&mut T`) into their types, marks `mut` bindings, and adapts each
 * call argument to its callee's inferred ownership. Anything outside the
 * implemented dialect throws `UnsupportedError` here — never downstream, never
 * silently (see hir.ts for why the emitter is then pure and total).
 */

import { type ModuleAnalysis, SCRIPT_SCOPE, analyzeModule } from "./analysis";
import type {
  BlockStatement,
  CallExpression,
  Expression,
  ForStatement,
  FunctionDeclaration,
  Identifier,
  IfStatement,
  Literal,
  MemberExpression,
  Program,
  Statement,
  TSType,
  VariableDeclaration,
  WhileStatement,
} from "./ast";
import type {
  Borrow,
  HirArg,
  HirExpr,
  HirFn,
  HirModule,
  HirParam,
  HirStmt,
  RustType,
} from "./hir";
import { refineNumerics } from "./numeric";
import { refineStrings } from "./strings";
import { DialectError, validate } from "./validate";

export { DialectError };

export class UnsupportedError extends Error {
  constructor(
    public readonly node: { type: string; start?: number; end?: number },
  ) {
    super(`Unsupported ${node.type} (the dialect does not implement this yet)`);
    this.name = "UnsupportedError";
  }
}

const UNIT: RustType = { kind: "unit" };

/**
 * Lower a whole program to HIR.
 * @throws {UnsupportedError} on any construct outside the implemented dialect.
 */
export function lower(program: Program): HirModule {
  // Step 2: reject input forbidden by the dialect (`any`/`unknown`, …) — fail
  // loud with `DialectError`, distinct from the "not yet implemented" gate below.
  validate(program);
  const analysis = analyzeModule(program);
  const items: HirFn[] = [];
  const script: Statement[] = [];

  for (const stmt of program.body) {
    if (stmt.type === "FunctionDeclaration") {
      items.push(lowerFunction(stmt as FunctionDeclaration, analysis));
    } else {
      script.push(stmt);
    }
  }

  let main: HirStmt[] = [];
  if (script.length > 0) {
    if (items.some((f) => f.name === "main")) {
      // No sound single lowering mixes script with a user-defined `main`.
      throw new UnsupportedError({
        type: "top-level statements alongside a user-defined main()",
      });
    }
    main = lowerStatements(script, analysis, SCRIPT_SCOPE);
  }

  // Final gate steps: refine `number` → `usize` where indexing demands it, then
  // read-only `string` params (`&String`) → the idiomatic `&str`.
  return refineStrings(refineNumerics({ items, main }));
}

// ── Items ────────────────────────────────────────────────────────────────────

function lowerFunction(
  func: FunctionDeclaration,
  analysis: ModuleAnalysis,
): HirFn {
  if (!func.id) throw new UnsupportedError(func);
  const name = func.id.name;
  const info = analysis.fns.get(name);

  const params = func.params.map((p, i) => lowerParam(p, info?.params[i]));
  const ret = func.returnType
    ? lowerType(func.returnType.typeAnnotation)
    : UNIT;

  if (!func.body)
    throw new UnsupportedError({ type: "function without a body" });
  // The function name is its own scope key for mutability lookups.
  const body = lowerStatements(func.body.body, analysis, name);

  return { kind: "fn", name, isAsync: func.async, params, ret, body };
}

function lowerParam(
  p: Identifier,
  info: { ownership: "move" | "ref" | "refMut" } | undefined,
): HirParam {
  if (!p.typeAnnotation) {
    throw new UnsupportedError({
      type: `parameter '${p.name}' without a type annotation`,
      start: p.start,
    });
  }
  const base = lowerType(p.typeAnnotation.typeAnnotation);
  const ownership = info?.ownership ?? "move";
  const ty: RustType =
    ownership === "ref"
      ? { kind: "ref", mut: false, inner: base }
      : ownership === "refMut"
        ? { kind: "ref", mut: true, inner: base }
        : base;
  return { name: p.name, ty };
}

// ── Statements ───────────────────────────────────────────────────────────────

function lowerStatements(
  stmts: Statement[],
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt[] {
  return stmts.flatMap((s) => lowerStatement(s, analysis, scope));
}

/** A statement lowers to zero or more HIR statements (one `let` per declarator). */
function lowerStatement(
  stmt: Statement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt[] {
  switch (stmt.type) {
    case "VariableDeclaration":
      return lowerVarDecl(stmt as VariableDeclaration, analysis, scope);
    case "ReturnStatement": {
      const arg = (stmt as { argument: Expression | null }).argument;
      return [{ kind: "return", value: arg ? lowerExpr(arg, analysis) : null }];
    }
    case "ExpressionStatement":
      return [
        {
          kind: "expr",
          expr: lowerExpr(
            (stmt as { expression: Expression }).expression,
            analysis,
          ),
        },
      ];
    case "IfStatement":
      return [lowerIf(stmt as IfStatement, analysis, scope)];
    case "WhileStatement": {
      const w = stmt as WhileStatement;
      return [
        {
          kind: "while",
          cond: lowerExpr(w.test, analysis),
          body: lowerBlock(w.body, analysis, scope),
        },
      ];
    }
    case "ForStatement":
      return [lowerFor(stmt as ForStatement, analysis, scope)];
    default:
      throw new UnsupportedError(stmt);
  }
}

function lowerIf(
  stmt: IfStatement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt {
  return {
    kind: "if",
    cond: lowerExpr(stmt.test, analysis),
    conseq: lowerBlock(stmt.consequent, analysis, scope),
    alt: lowerAlternate(stmt.alternate, analysis, scope),
  };
}

/**
 * Lower an `else` branch: absent → `null`; an `else if` (the alternate is itself
 * an `IfStatement`) → a one-element `[if]` the emitter renders as `else if …`;
 * an `else { … }` block → its lowered statements.
 */
function lowerAlternate(
  alt: Statement | null,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt[] | null {
  if (!alt) return null;
  if (alt.type === "IfStatement") {
    return [lowerIf(alt as IfStatement, analysis, scope)];
  }
  return lowerBlock(alt, analysis, scope);
}

/**
 * Desugar a C-style `for (init; test; update) body` into a scoped `while`:
 * `{ init; while (test) { …body; update; } }`. The wrapping `block` contains the
 * loop variable's scope; the `update` runs as the loop body's last statement.
 * (Sound only without `continue`, which is not in the dialect yet — see design.)
 */
function lowerFor(
  stmt: ForStatement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt {
  const init: HirStmt[] = stmt.init
    ? stmt.init.type === "VariableDeclaration"
      ? lowerVarDecl(stmt.init as VariableDeclaration, analysis, scope)
      : [{ kind: "expr", expr: lowerExpr(stmt.init as Expression, analysis) }]
    : [];

  const body = lowerBlock(stmt.body, analysis, scope);
  if (stmt.update) {
    body.push({ kind: "expr", expr: lowerExpr(stmt.update, analysis) });
  }

  const cond: HirExpr = stmt.test
    ? lowerExpr(stmt.test, analysis)
    : { kind: "bool", value: true };

  return { kind: "block", body: [...init, { kind: "while", cond, body }] };
}

/**
 * Lower a control-flow body — a `{ … }` block or a single bare statement. The
 * scope key is unchanged: mutability is name-based and per-function, so a binding
 * inside a block resolves under the enclosing function's scope (see analysis.ts).
 */
function lowerBlock(
  body: Statement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt[] {
  if (body.type === "BlockStatement") {
    return lowerStatements((body as BlockStatement).body, analysis, scope);
  }
  return lowerStatement(body, analysis, scope);
}

function lowerVarDecl(
  decl: VariableDeclaration,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt[] {
  const mutable = analysis.mut.get(scope);
  return decl.declarations.map((d) => {
    if (!d.init) throw new UnsupportedError({ type: "uninitialized binding" });
    const ty = d.id.typeAnnotation
      ? lowerType(d.id.typeAnnotation.typeAnnotation)
      : null;
    return {
      kind: "let",
      name: d.id.name,
      mut: mutable?.has(d.id.name) ?? false,
      ty,
      init: lowerExpr(d.init, analysis),
    };
  });
}

// ── Expressions ──────────────────────────────────────────────────────────────

function lowerExpr(expr: Expression, analysis: ModuleAnalysis): HirExpr {
  switch (expr.type) {
    case "Literal":
      return lowerLiteral(expr as Literal);
    case "Identifier":
      return { kind: "ident", name: (expr as Identifier).name };
    case "BinaryExpression": {
      const b = expr as {
        operator: string;
        left: Expression;
        right: Expression;
      };
      return {
        kind: "binary",
        op: b.operator,
        left: lowerExpr(b.left, analysis),
        right: lowerExpr(b.right, analysis),
      };
    }
    case "AssignmentExpression": {
      const a = expr as {
        operator: string;
        left: Expression;
        right: Expression;
      };
      return {
        kind: "assign",
        op: a.operator,
        target: lowerExpr(a.left, analysis),
        value: lowerExpr(a.right, analysis),
      };
    }
    case "ArrayExpression":
      return {
        kind: "array",
        elements: (expr as { elements: Expression[] }).elements.map((e) =>
          lowerExpr(e, analysis),
        ),
      };
    case "CallExpression":
      return lowerCall(expr as CallExpression, analysis);
    case "MemberExpression":
      return lowerMember(expr as MemberExpression, analysis);
    default:
      throw new UnsupportedError(expr);
  }
}

function lowerLiteral(lit: Literal): HirExpr {
  const v = lit.value;
  if (typeof v === "number") return { kind: "number", value: v };
  if (typeof v === "string") return { kind: "string", value: v };
  if (typeof v === "boolean") return { kind: "bool", value: v };
  if (v === null) throw new UnsupportedError({ type: "null literal" });
  throw new UnsupportedError({ type: `literal ${typeof v}` });
}

function isConsoleLog(callee: Expression): boolean {
  if (callee.type !== "MemberExpression") return false;
  const m = callee as MemberExpression;
  return (
    m.object.type === "Identifier" &&
    (m.object as Identifier).name === "console" &&
    m.property.type === "Identifier" &&
    (m.property as Identifier).name === "log"
  );
}

function lowerCall(call: CallExpression, analysis: ModuleAnalysis): HirExpr {
  // console.log(...) → println!
  if (isConsoleLog(call.callee)) {
    return {
      kind: "println",
      args: call.arguments.map((a) => lowerExpr(a, analysis)),
    };
  }

  // Direct call to a known function: adapt each argument to the callee's
  // inferred parameter ownership (move → `x`, ref → `&x`, refMut → `&mut x`).
  if (call.callee.type === "Identifier") {
    const name = (call.callee as Identifier).name;
    const sig = analysis.fns.get(name);
    const args: HirArg[] = call.arguments.map((a, i) => {
      const param = sig?.params[i];
      let borrow: Borrow = "owned";
      if (param && !param.isCopy) {
        if (param.ownership === "ref") borrow = "ref";
        else if (param.ownership === "refMut") borrow = "refMut";
      }
      return { borrow, expr: lowerExpr(a, analysis) };
    });
    return { kind: "call", callee: name, args };
  }

  // Method call: `obj.method(args)`.
  if (call.callee.type === "MemberExpression") {
    const m = call.callee as MemberExpression;
    if (m.property.type !== "Identifier") throw new UnsupportedError(call);
    return {
      kind: "method",
      receiver: lowerExpr(m.object, analysis),
      name: (m.property as Identifier).name,
      args: call.arguments.map((a) => lowerExpr(a, analysis)),
    };
  }

  throw new UnsupportedError(call);
}

function lowerMember(
  member: MemberExpression,
  analysis: ModuleAnalysis,
): HirExpr {
  if (member.computed) {
    return {
      kind: "index",
      object: lowerExpr(member.object, analysis),
      index: lowerExpr(member.property, analysis),
    };
  }
  if (member.property.type === "Identifier") {
    const prop = (member.property as Identifier).name;
    // `.length` is a property in TS but a method in Rust.
    if (prop === "length")
      return { kind: "len", object: lowerExpr(member.object, analysis) };
    return {
      kind: "field",
      object: lowerExpr(member.object, analysis),
      name: prop,
    };
  }
  throw new UnsupportedError(member);
}

// ── Types ────────────────────────────────────────────────────────────────────

function lowerType(ty: TSType): RustType {
  switch (ty.type) {
    case "TSNumberKeyword":
      return { kind: "f64" };
    case "TSStringKeyword":
      return { kind: "String" };
    case "TSBooleanKeyword":
      return { kind: "bool" };
    case "TSVoidKeyword":
      return UNIT;
    case "TSTypeReference": {
      const ref = ty as Extract<TSType, { type: "TSTypeReference" }>;
      if (ref.typeName.name === "Array") {
        const inner = ref.typeArguments?.params?.[0];
        if (!inner) throw new UnsupportedError(ty);
        return { kind: "vec", elem: lowerType(inner) };
      }
      throw new UnsupportedError(ty);
    }
    default:
      throw new UnsupportedError(ty);
  }
}
