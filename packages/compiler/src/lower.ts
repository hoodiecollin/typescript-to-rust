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
  ArrowFunctionExpression,
  AssignmentExpression,
  AwaitExpression,
  BlockStatement,
  BreakStatement,
  CallExpression,
  ClassDeclaration,
  ContinueStatement,
  Expression,
  ExpressionStatement,
  ForOfStatement,
  ForStatement,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  IfStatement,
  Literal,
  MemberExpression,
  MethodDefinition,
  NewExpression,
  ObjectExpression,
  Program,
  PropertyDefinition,
  ReturnStatement,
  Statement,
  SwitchStatement,
  ThrowStatement,
  TSInterfaceDeclaration,
  TSType,
  VariableDeclaration,
  WhileStatement,
} from "./ast";
import type {
  Borrow,
  HirArg,
  HirExpr,
  HirClass,
  HirFn,
  HirItem,
  HirMatchArm,
  HirModule,
  HirParam,
  HirStmt,
  HirStruct,
  RustType,
  SelfRecv,
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
/** The error type for every fallible function this slice: the `Error` message. */
const ERR_STRING: RustType = { kind: "String" };

/** Wrap an ok-type in the slice's `Result<ok, String>`. */
function resultType(ok: RustType): RustType {
  return { kind: "result", ok, err: ERR_STRING };
}

/**
 * Lower a whole program to HIR.
 * @throws {UnsupportedError} on any construct outside the implemented dialect.
 */
export function lower(program: Program): HirModule {
  // Step 2: reject input forbidden by the dialect (`any`/`unknown`, …) — fail
  // loud with `DialectError`, distinct from the "not yet implemented" gate below.
  validate(program);
  // Normalize a top-level `const f = (…) => …` arrow into a synthetic function
  // declaration *before* analysis, so ownership, fallibility, and lowering treat
  // it identically to a `function` (see normalizeArrows).
  const normalized = normalizeArrows(program);
  const analysis = analyzeModule(normalized);
  const items: HirItem[] = [];
  const script: Statement[] = [];

  for (const stmt of normalized.body) {
    if (stmt.type === "FunctionDeclaration") {
      items.push(lowerFunction(stmt as FunctionDeclaration, analysis));
    } else if (stmt.type === "TSInterfaceDeclaration") {
      items.push(lowerInterface(stmt as TSInterfaceDeclaration, analysis.structs));
    } else if (stmt.type === "ClassDeclaration") {
      items.push(lowerClass(stmt as ClassDeclaration, analysis));
    } else {
      script.push(stmt);
    }
  }

  let main: HirStmt[] = [];
  let mainRet: RustType | undefined;
  let mainAsync: boolean | undefined;
  if (script.length > 0) {
    if (items.some((f) => f.kind === "fn" && f.name === "main")) {
      // No sound single lowering mixes script with a user-defined `main`.
      throw new UnsupportedError({
        type: "top-level statements alongside a user-defined main()",
      });
    }
    main = lowerStatements(script, analysis, SCRIPT_SCOPE);
    // A script that propagates a throwing call (or throws) makes `main` fallible:
    // `fn main() -> Result<(), String>`, returns wrapped in `Ok`, trailing `Ok(())`.
    if (analysis.fallible.has(SCRIPT_SCOPE)) {
      main = makeFallible(main, UNIT);
      mainRet = resultType(UNIT);
    }
    // A script that `await`s needs an async runtime entry: `#[tokio::main] async
    // fn main()` (composes with `mainRet` if the script also throws).
    if (hirHasAwait(main)) mainAsync = true;
  }

  // Final gate steps: refine `number` → `usize` where indexing demands it, then
  // read-only `string` params (`&String`) → the idiomatic `&str`.
  return refineStrings(refineNumerics({ items, main, mainRet, mainAsync }));
}

// ── Arrow normalization ──────────────────────────────────────────────────────

/**
 * Rewrite each top-level `const f = (…) => …` (a single-declarator `const` bound
 * to a non-`async` arrow) into a synthetic `FunctionDeclaration`, leaving every
 * other statement untouched. Run before analysis so a normalized arrow's
 * parameter ownership and call-site borrows are inferred, and calls to it adapt
 * their arguments, exactly as for a `function`. A non-normalized arrow (async,
 * `let`/`var`-bound, value-position, nested) stays an expression and is rejected
 * downstream in `lowerExpr` — the documented deferral boundary.
 */
function normalizeArrows(program: Program): Program {
  const body = program.body.map((stmt) => {
    const found = topLevelConstArrow(stmt);
    if (!found) return stmt;
    return arrowToFunctionDecl(found.name, found.arrow);
  });
  return { ...program, body };
}

/**
 * Build the synthetic `FunctionDeclaration` for a normalized arrow: the binding
 * name becomes the fn `id`; `params`/`returnType`/`async` carry over unchanged;
 * the body is the arrow's `BlockStatement` verbatim, or `{ return <expr>; }` for
 * an expression body (the `=> expr` desugar). Spans are inherited from the arrow
 * so any downstream diagnostic still points at the source.
 */
function arrowToFunctionDecl(
  name: Identifier,
  arrow: ArrowFunctionExpression,
): FunctionDeclaration {
  const body: BlockStatement =
    arrow.body.type === "BlockStatement"
      ? (arrow.body as BlockStatement)
      : {
          type: "BlockStatement",
          body: [
            {
              type: "ReturnStatement",
              argument: arrow.body as Expression,
              start: arrow.body.start,
              end: arrow.body.end,
            } satisfies ReturnStatement,
          ],
          start: arrow.body.start,
          end: arrow.body.end,
        };
  return {
    type: "FunctionDeclaration",
    id: name,
    async: arrow.async,
    params: arrow.params,
    returnType: arrow.returnType ?? null,
    body,
    start: arrow.start,
    end: arrow.end,
  };
}

/** A qualifying top-level `const <id> = <non-async arrow>`, else null. */
function topLevelConstArrow(
  stmt: Statement,
): { name: Identifier; arrow: ArrowFunctionExpression } | null {
  if (stmt.type !== "VariableDeclaration") return null;
  const decl = stmt as VariableDeclaration;
  if (decl.kind !== "const" || decl.declarations.length !== 1) return null;
  const d = decl.declarations[0];
  if (!d || d.init?.type !== "ArrowFunctionExpression") return null;
  const arrow = d.init as ArrowFunctionExpression;
  if (arrow.async) return null;
  return { name: d.id, arrow };
}

// ── Items ────────────────────────────────────────────────────────────────────

function lowerFunction(
  func: FunctionDeclaration,
  analysis: ModuleAnalysis,
): HirFn {
  if (!func.id) throw new UnsupportedError(func);
  const name = func.id.name;
  const info = analysis.fns.get(name);

  const params = func.params.map((p, i) =>
    lowerParam(p, info?.params[i], analysis.structs),
  );
  const ret = func.returnType
    ? lowerType(func.returnType.typeAnnotation, analysis.structs)
    : UNIT;

  if (!func.body)
    throw new UnsupportedError({ type: "function without a body" });
  // The function name is its own scope key for mutability lookups.
  const body = lowerStatements(func.body.body, analysis, name);

  // A fallible function (it throws, or calls something that throws) returns
  // `Result<ret, String>`: wrap its returns in `Ok`, keep its `throw`s as `Err`.
  // An `async` fallible fn composes both — `async fn … -> Result<…>` — and an
  // awaited fallible call propagates with `.await?` (see lowerAwait).
  if (analysis.fallible.has(name)) {
    return {
      kind: "fn",
      name,
      isAsync: func.async,
      params,
      ret: resultType(ret),
      body: makeFallible(body, ret),
    };
  }

  return { kind: "fn", name, isAsync: func.async, params, ret, body };
}

// ── Fallibility (throw / Result propagation) ─────────────────────────────────

/**
 * Lower `throw new Error(<message>)` to a `throw` HIR stmt (emitted as
 * `return Err(<message>);`). Only that exact shape maps this slice: a bare value,
 * a re-throw, an `Error` subclass, or a wrong argument count is fail-loud (each a
 * later series). The message lowers as an expression, so a string literal becomes
 * a `String` and `Err` carries it.
 */
function lowerThrow(stmt: ThrowStatement, analysis: ModuleAnalysis): HirStmt {
  const arg = stmt.argument;
  if (arg.type !== "NewExpression") {
    throw new UnsupportedError({ type: "throw of a non-Error value" });
  }
  const nw = arg as NewExpression;
  if (
    nw.callee.type !== "Identifier" ||
    (nw.callee as Identifier).name !== "Error"
  ) {
    throw new UnsupportedError({ type: "throw of a non-`new Error(...)` value" });
  }
  const [message] = nw.arguments;
  if (nw.arguments.length !== 1 || !message) {
    throw new UnsupportedError({
      type: "throw new Error() must have exactly one message argument",
    });
  }
  return { kind: "throw", value: lowerExpr(message, analysis) };
}

/**
 * Rewrite a fallible function's body so every normal `return v` yields `Ok(v)`
 * (and `return;` → `Ok(())`), leaving `throw`s to emit `Err`. A `void` body that
 * can fall through the end gets a trailing `return Ok(());` — the non-throwing
 * path must still produce `Ok`. `throw`s are untouched here (the emitter renders
 * them as `return Err`).
 */
function makeFallible(stmts: HirStmt[], okTy: RustType): HirStmt[] {
  const wrapped = stmts.map(wrapReturns);
  if (okTy.kind === "unit" && !diverges(wrapped)) {
    wrapped.push({ kind: "return", value: { kind: "ok", value: null } });
  }
  return wrapped;
}

/** Recursively wrap each `return v` in `Ok`, descending into control-flow bodies. */
function wrapReturns(stmt: HirStmt): HirStmt {
  switch (stmt.kind) {
    case "return":
      return { kind: "return", value: { kind: "ok", value: stmt.value } };
    case "if":
      return {
        kind: "if",
        cond: stmt.cond,
        conseq: stmt.conseq.map(wrapReturns),
        alt: stmt.alt ? stmt.alt.map(wrapReturns) : null,
      };
    case "while":
      return { kind: "while", cond: stmt.cond, body: stmt.body.map(wrapReturns) };
    case "block":
      return { kind: "block", body: stmt.body.map(wrapReturns) };
    case "forIn":
      return { ...stmt, body: stmt.body.map(wrapReturns) };
    case "match":
      return {
        kind: "match",
        disc: stmt.disc,
        arms: stmt.arms.map((a) => ({
          guard: a.guard,
          body: a.body.map(wrapReturns),
        })),
      };
    default:
      // `let`/`expr`/`throw`/`break`/`continue` carry no return to wrap.
      return stmt;
  }
}

/** Does a statement list definitely diverge (its last statement returns/throws)? */
function diverges(stmts: HirStmt[]): boolean {
  const last = stmts[stmts.length - 1];
  if (!last) return false;
  if (last.kind === "return" || last.kind === "throw") return true;
  if (last.kind === "if" && last.alt) {
    return diverges(last.conseq) && diverges(last.alt);
  }
  if (last.kind === "block") return diverges(last.body);
  return false;
}

/** Does a lowered HIR subtree contain a `throw` stmt or a `try` (`?`) expr? */
function hirHasThrowOrTry(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hirHasThrowOrTry);
  if (node === null || typeof node !== "object") return false;
  const kind = (node as { kind?: string }).kind;
  if (kind === "throw" || kind === "try") return true;
  return Object.values(node).some(hirHasThrowOrTry);
}

/**
 * Does a lowered HIR subtree contain an `await`? Used on the generated `main` to
 * decide `#[tokio::main]`. Nested functions are separate `items`, so walking
 * `main` sees exactly script-scope awaits.
 */
function hirHasAwait(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hirHasAwait);
  if (node === null || typeof node !== "object") return false;
  if ((node as { kind?: string }).kind === "await") return true;
  return Object.values(node).some(hirHasAwait);
}

/**
 * Lower an `interface` to a `struct` item. Data-only: `extends` (inheritance) and
 * optional/computed members are rejected (`UnsupportedError`), each a later
 * series. Field types resolve through `structs` so a struct field may name
 * another declared interface (though no fixture exercises nesting yet).
 */
function lowerInterface(
  decl: TSInterfaceDeclaration,
  structs: Set<string>,
): HirStruct {
  if (decl.extends && decl.extends.length > 0) {
    throw new UnsupportedError({ type: "interface extends (inheritance)" });
  }
  const fields = decl.body.body.map((m) => {
    if (m.type !== "TSPropertySignature" || m.computed) {
      throw new UnsupportedError({ type: "unsupported interface member" });
    }
    if (m.optional) {
      throw new UnsupportedError({ type: "optional interface field (x?: T)" });
    }
    if (!m.typeAnnotation) {
      throw new UnsupportedError({
        type: `interface field '${m.key.name}' without a type`,
      });
    }
    return { name: m.key.name, ty: lowerType(m.typeAnnotation.typeAnnotation, structs) };
  });
  return { kind: "struct", name: decl.id.name, fields };
}

/**
 * Lower a `class` to a `HirClass` (a `struct` + `impl`). Fields come from
 * `PropertyDefinition`s; the constructor becomes an associated `new`; each method
 * becomes an `fn` with a `self` receiver. Inheritance (`extends`/`implements`),
 * statics, accessors, and a missing constructor are rejected — each a later
 * series. Fields are collected first so a method or the constructor may reference
 * a field declared after it.
 */
function lowerClass(decl: ClassDeclaration, analysis: ModuleAnalysis): HirClass {
  if (!decl.id) throw new UnsupportedError({ type: "anonymous class" });
  if (decl.superClass || (decl.implements && decl.implements.length > 0)) {
    throw new UnsupportedError({
      type: "class inheritance (extends/implements)",
    });
  }
  const name = decl.id.name;
  const structs = analysis.structs;

  const fields = decl.body.body
    .filter((m): m is PropertyDefinition => m.type === "PropertyDefinition")
    .map((f) => {
      if (f.static || f.computed) {
        throw new UnsupportedError({ type: "static/computed class field" });
      }
      if (!f.typeAnnotation) {
        throw new UnsupportedError({
          type: `class field '${f.key.name}' without a type`,
        });
      }
      return { name: f.key.name, ty: lowerType(f.typeAnnotation.typeAnnotation, structs) };
    });

  let ctor: HirFn | null = null;
  const methods: HirFn[] = [];
  for (const member of decl.body.body) {
    if (member.type !== "MethodDefinition") continue;
    if (member.static || member.computed) {
      throw new UnsupportedError({ type: "static/computed class method" });
    }
    if (member.kind === "constructor") {
      ctor = lowerConstructor(member.value, name, fields, analysis);
    } else if (member.kind === "method") {
      methods.push(lowerMethod(member, name, analysis));
    } else {
      throw new UnsupportedError({ type: `class ${member.kind} accessor` });
    }
  }
  if (!ctor) {
    throw new UnsupportedError({ type: "class without an explicit constructor" });
  }
  // Throwing / error propagation inside a class is deferred (fallibility is
  // analysed for free functions + the script only) — reject fail-loud rather than
  // emit a `return Err`/`?` in a non-`Result` method.
  if (hirHasThrowOrTry(ctor.body) || methods.some((m) => hirHasThrowOrTry(m.body))) {
    throw new UnsupportedError({
      type: "throw / error propagation inside a class method or constructor (deferred)",
    });
  }
  return { kind: "class", name, fields, ctor, methods };
}

/**
 * Lower a `constructor(params) { this.f = e; … }` to an associated
 * `fn new(params) -> Name` returning a struct literal. The body must be a
 * sequence of `this.<field> = <expr>;` assignments covering exactly the declared
 * fields (a Rust struct literal is total) — anything else throws. Params are
 * taken by value (moved into the fields).
 */
function lowerConstructor(
  fn: FunctionExpression,
  className: string,
  fields: { name: string; ty: RustType }[],
  analysis: ModuleAnalysis,
): HirFn {
  const structs = analysis.structs;
  const params = fn.params.map((p) => lowerParam(p, undefined, structs));
  if (!fn.body) {
    throw new UnsupportedError({ type: "constructor without a body" });
  }
  const assigned = new Map<string, HirExpr>();
  for (const stmt of fn.body.body) {
    const init = constructorFieldInit(stmt, analysis);
    if (!init) {
      throw new UnsupportedError({
        type: "constructor body beyond `this.field = expr` initialization",
      });
    }
    assigned.set(init.field, init.value);
  }
  if (assigned.size !== fields.length) {
    throw new UnsupportedError({
      type: "constructor must initialize exactly the declared fields",
    });
  }
  const litFields = fields.map((f) => {
    const value = assigned.get(f.name);
    if (!value) {
      throw new UnsupportedError({
        type: `constructor does not initialize field '${f.name}'`,
      });
    }
    return { name: f.name, value };
  });
  const structLit: HirExpr = { kind: "structLit", name: className, fields: litFields };
  return {
    kind: "fn",
    name: "new",
    isAsync: false,
    params,
    ret: { kind: "struct", name: className },
    body: [{ kind: "return", value: structLit }],
  };
}

/** A constructor statement `this.<field> = <expr>;`, or null if it is anything else. */
function constructorFieldInit(
  stmt: Statement,
  analysis: ModuleAnalysis,
): { field: string; value: HirExpr } | null {
  if (stmt.type !== "ExpressionStatement") return null;
  const e = (stmt as ExpressionStatement).expression;
  if (e.type !== "AssignmentExpression") return null;
  const assign = e as AssignmentExpression;
  if (assign.operator !== "=") return null;
  const left = assign.left;
  if (left.type !== "MemberExpression") return null;
  const m = left as MemberExpression;
  if (m.computed || m.object.type !== "ThisExpression") return null;
  if (m.property.type !== "Identifier") return null;
  return {
    field: (m.property as Identifier).name,
    value: lowerExpr(assign.right, analysis),
  };
}

/**
 * Lower a class method to an `fn` with a `self` receiver. The receiver is
 * `&mut self` when the body assigns a `this.<field>`, else `&self`. Params are
 * taken by value (method-param borrow inference is deferred). `this` lowers to
 * the `self` identifier (see `lowerExpr`), so `this.x` becomes `self.x`.
 */
function lowerMethod(
  member: MethodDefinition,
  className: string,
  analysis: ModuleAnalysis,
): HirFn {
  const fn = member.value;
  const name = member.key.name;
  // async in a class is deferred: `asyncFns` tracks free functions only, so an
  // async method could be defined but never soundly awaited. Fail-loud.
  if (fn.async) {
    throw new UnsupportedError({
      type: "async method (async only on free functions this slice)",
    });
  }
  const structs = analysis.structs;
  const params = fn.params.map((p) => lowerParam(p, undefined, structs));
  const ret = fn.returnType
    ? lowerType(fn.returnType.typeAnnotation, structs)
    : UNIT;
  if (!fn.body) throw new UnsupportedError({ type: "method without a body" });
  const body = lowerStatements(fn.body.body, analysis, `${className}.${name}`);
  const recv: SelfRecv = astAssignsThis(fn.body) ? "refMut" : "ref";
  return { kind: "fn", name, isAsync: fn.async, params, ret, body, recv };
}

/** Does an AST subtree assign to a `this.<field>` (→ a `&mut self` receiver)? */
function astAssignsThis(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(astAssignsThis);
  if (!isAstNode(node)) return false;
  if (node.type === "AssignmentExpression") {
    const left = (node as Record<string, unknown>).left;
    if (isAstNode(left) && left.type === "MemberExpression") {
      const object = (left as Record<string, unknown>).object;
      if (isAstNode(object) && object.type === "ThisExpression") return true;
    }
  }
  for (const key in node) {
    if (key === "type") continue;
    if (astAssignsThis((node as Record<string, unknown>)[key])) return true;
  }
  return false;
}

function lowerParam(
  p: Identifier,
  info: { ownership: "move" | "ref" | "refMut" } | undefined,
  structs: Set<string>,
): HirParam {
  if (!p.typeAnnotation) {
    throw new UnsupportedError({
      type: `parameter '${p.name}' without a type annotation`,
      start: p.start,
    });
  }
  const base = lowerType(p.typeAnnotation.typeAnnotation, structs);
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
    case "ForOfStatement":
      return [lowerForOf(stmt as ForOfStatement, analysis, scope)];
    case "SwitchStatement":
      return [lowerSwitch(stmt as SwitchStatement, analysis, scope)];
    case "BreakStatement": {
      if ((stmt as BreakStatement).label) {
        throw new UnsupportedError({ type: "labeled break" });
      }
      return [{ kind: "break" }];
    }
    case "ContinueStatement": {
      if ((stmt as ContinueStatement).label) {
        throw new UnsupportedError({ type: "labeled continue" });
      }
      return [{ kind: "continue" }];
    }
    case "ThrowStatement":
      return [lowerThrow(stmt as ThrowStatement, analysis)];
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
 * Does `node` contain a `continue` that targets *this* loop — i.e. one not
 * nested inside another loop (which owns its own `continue`)? Used to reject an
 * unsound `continue` in the C-`for` desugar. A `switch`/`if`/block is transparent
 * to `continue`; a nested `while`/`for`/`for…of` is a barrier.
 */
function hasOwnContinue(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasOwnContinue);
  if (!isAstNode(node)) return false;
  if (node.type === "ContinueStatement") return true;
  if (
    node.type === "WhileStatement" ||
    node.type === "ForStatement" ||
    node.type === "ForOfStatement"
  ) {
    return false;
  }
  for (const key in node) {
    if (key === "type") continue;
    if (hasOwnContinue((node as Record<string, unknown>)[key])) return true;
  }
  return false;
}

function isAstNode(x: unknown): x is { type: string } {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as { type?: unknown }).type === "string"
  );
}

/**
 * Desugar a C-style `for (init; test; update) body` into a scoped `while`:
 * `{ init; while (test) { …body; update; } }`. The wrapping `block` contains the
 * loop variable's scope; the `update` runs as the loop body's last statement.
 *
 * A `continue` in the body would jump to the `while` condition and **skip** the
 * appended `update` — a semantic change — so an *own* `continue` (not inside a
 * nested loop) is rejected. `break` is sound (it exits the `while`, exactly as
 * the `for` would). The labeled-block fix is a deferred series (see design 009).
 */
function lowerFor(
  stmt: ForStatement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt {
  if (hasOwnContinue(stmt.body)) {
    throw new UnsupportedError({
      type: "continue inside a C-style for (unsound while-desugar — deferred)",
    });
  }

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
 * Lower `for (const val of arr) body` to `for val in arr.iter() { body }`.
 * `.iter()` iterates by reference — sound whether the iterable is owned or
 * borrowed, never consuming it — so the loop binding is `&T`. Only a single
 * identifier binding is supported; destructuring throws (see design 008).
 */
function lowerForOf(
  stmt: ForOfStatement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt {
  const decl = stmt.left.declarations[0];
  if (!decl || stmt.left.declarations.length !== 1) {
    throw new UnsupportedError({ type: "for-of with a non-single binding" });
  }
  const iter: HirExpr = {
    kind: "method",
    receiver: lowerExpr(stmt.right, analysis),
    name: "iter",
    args: [],
  };
  return {
    kind: "forIn",
    pat: decl.id.name,
    iter,
    body: lowerBlock(stmt.body, analysis, scope),
  };
}

/**
 * Lower `switch (disc) { … }` to a `match` with **guarded wildcard** arms —
 * `case v:` → `_ if disc == v => { … }`, `default:` → `_ => { … }` (emitted
 * last). Rust forbids `f64` literal patterns, so the discriminant is compared in
 * a guard. Rust `match` has no fall-through: each case must terminate with
 * `break` (stripped — it is the case terminator) or `return`; a non-terminating
 * non-final case, or an empty/stacked case, throws. A synthetic `_ => {}` is
 * appended when there is no `default`, so the match is exhaustive.
 */
function lowerSwitch(
  stmt: SwitchStatement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt {
  const disc = lowerExpr(stmt.discriminant, analysis);
  const arms: HirMatchArm[] = [];
  let defaultArm: HirMatchArm | null = null;

  stmt.cases.forEach((c, i) => {
    const body = lowerSwitchCaseBody(
      c.consequent,
      i === stmt.cases.length - 1,
      analysis,
      scope,
    );
    if (c.test === null) {
      defaultArm = { guard: null, body };
    } else {
      const guard: HirExpr = {
        kind: "binary",
        op: "==",
        left: disc,
        right: lowerExpr(c.test, analysis),
      };
      arms.push({ guard, body });
    }
  });

  // `default` last; else a catch-all so the `match` is exhaustive.
  arms.push(defaultArm ?? { guard: null, body: [] });
  return { kind: "match", disc, arms };
}

/** Lower a case body, enforcing the terminator rule and stripping a trailing `break`. */
function lowerSwitchCaseBody(
  consequent: Statement[],
  isLast: boolean,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt[] {
  const body = lowerStatements(consequent, analysis, scope);
  if (body.length === 0) {
    throw new UnsupportedError({
      type: "empty/stacked switch case (fall-through not supported)",
    });
  }
  const last = body[body.length - 1];
  if (last?.kind === "break") return body.slice(0, -1);
  if (last?.kind === "return") return body;
  if (!isLast) {
    throw new UnsupportedError({
      type: "switch case falls through (needs break or return)",
    });
  }
  return body;
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
      ? lowerType(d.id.typeAnnotation.typeAnnotation, analysis.structs)
      : null;
    // An object literal is interpreted from its binding's type: a `hashmap`
    // annotation makes it a `HashMap::from([…])` construction, a `struct` a
    // `Name { … }` literal. A bare object literal (neither) stays unsupported.
    let init: HirExpr;
    if (ty?.kind === "hashmap" && d.init.type === "ObjectExpression") {
      init = lowerHashMapLiteral(d.init as ObjectExpression, analysis);
    } else if (ty?.kind === "struct" && d.init.type === "ObjectExpression") {
      init = lowerStructLiteral(d.init as ObjectExpression, ty.name, analysis);
    } else {
      init = lowerExpr(d.init, analysis);
    }
    return {
      kind: "let",
      name: d.id.name,
      mut: mutable?.has(d.id.name) ?? false,
      ty,
      init,
    };
  });
}

/**
 * Lower a record object literal to a `hashmap` HirExpr — each `key: value`
 * property becomes a `(key, value)` entry. Keys are string literals or bare
 * identifiers (both a `String`); spread and computed keys are unsupported.
 */
function lowerHashMapLiteral(
  obj: ObjectExpression,
  analysis: ModuleAnalysis,
): HirExpr {
  const entries = obj.properties.map((p) => {
    if (p.type !== "Property" || p.computed) {
      throw new UnsupportedError({
        type: "unsupported object property (spread or computed key)",
      });
    }
    return { key: lowerKey(p.key), value: lowerExpr(p.value, analysis) };
  });
  return { kind: "hashmap", entries };
}

/**
 * Lower a struct object literal to a `structLit` HirExpr — each `field: value`
 * property becomes a named field. Field names are identifiers (or string
 * literals); spread and computed keys are unsupported. Field values lower as
 * expressions; the struct's declared field types are not re-checked here (the
 * cargo oracle catches a type mismatch).
 */
function lowerStructLiteral(
  obj: ObjectExpression,
  name: string,
  analysis: ModuleAnalysis,
): HirExpr {
  const fields = obj.properties.map((p) => {
    if (p.type !== "Property" || p.computed) {
      throw new UnsupportedError({
        type: "unsupported object property (spread or computed key)",
      });
    }
    const key = lowerKey(p.key);
    if (key.kind !== "string") {
      throw new UnsupportedError({ type: "struct field name must be static" });
    }
    return { name: key.value, value: lowerExpr(p.value, analysis) };
  });
  return { kind: "structLit", name, fields };
}

/** A record key: a string literal or a bare identifier, both a `String`. */
function lowerKey(key: Expression): HirExpr {
  if (key.type === "Literal" && typeof (key as Literal).value === "string") {
    return { kind: "string", value: (key as Literal).value as string };
  }
  if (key.type === "Identifier") {
    return { kind: "string", value: (key as Identifier).name };
  }
  throw new UnsupportedError({
    type: "record key must be a string literal or identifier",
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
    case "ThisExpression":
      // `this` is the method's `self` receiver; `this.x` reuses the `field` node.
      return { kind: "ident", name: "self" };
    case "NewExpression":
      return lowerNew(expr as NewExpression, analysis);
    case "AwaitExpression":
      return lowerAwait(expr as AwaitExpression, analysis);
    case "ObjectExpression":
      // An object literal only lowers contextually, in a record-typed binding
      // (see lowerVarDecl). Bare/struct-typed literals await series 011.
      throw new UnsupportedError({
        type: "object literal without a Record type (struct literals: series 011)",
      });
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

/**
 * `await <asyncCall>` → `<call>.await`. Only `await` of a call to a known free
 * `async` function maps: awaiting a non-call, or a call to a non-`async`
 * function, is fail-loud (there is no future to poll). The awaited call lowers
 * with `awaited = true` so `lowerCall` accepts the `async` callee.
 *
 * When the awaited fn is also *fallible*, the `Result` it yields is
 * `?`-propagated *after* the `.await` (`<call>.await?`) — the `?` sits outside
 * the await (correct precedence), and the fallibility fixpoint guarantees the
 * enclosing fn is itself `Result`, so `?` is well-typed.
 */
function lowerAwait(expr: AwaitExpression, analysis: ModuleAnalysis): HirExpr {
  const arg = expr.argument;
  if (arg.type !== "CallExpression") {
    throw new UnsupportedError({
      type: "await of a non-call expression (only `await asyncFn(...)`)",
    });
  }
  const call = arg as CallExpression;
  const callee = call.callee;
  if (
    callee.type !== "Identifier" ||
    !analysis.asyncFns.has((callee as Identifier).name)
  ) {
    throw new UnsupportedError({
      type: "await of a call to a non-async function",
    });
  }
  const awaited: HirExpr = {
    kind: "await",
    expr: lowerCall(call, analysis, true),
  };
  return analysis.fallible.has((callee as Identifier).name)
    ? { kind: "try", expr: awaited }
    : awaited;
}

function lowerCall(
  call: CallExpression,
  analysis: ModuleAnalysis,
  awaited = false,
): HirExpr {
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
    const callExpr: HirExpr = { kind: "call", callee: name, args };
    // A call to an `async` function is only valid `await`ed — a bare call is an
    // un-polled future that never runs (a `must_use` warning, not an error, so
    // it would silently diverge from TS). `lowerAwait` passes `awaited = true`.
    // async fns are never fallible (async + throw is rejected), so no `?`.
    if (analysis.asyncFns.has(name)) {
      if (!awaited) {
        throw new UnsupportedError({
          type: "call to an async function not directly awaited (an un-polled future never runs)",
        });
      }
      return callExpr;
    }
    // A call to a fallible function propagates its error with `?`. The
    // fallibility fixpoint guarantees the enclosing function is itself fallible,
    // so its return type is already `Result` and `?` is well-typed.
    if (analysis.fallible.has(name)) return { kind: "try", expr: callExpr };
    return callExpr;
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

/** `new C(args)` → `C::new(args)`. Constructor params are owned (args by value). */
function lowerNew(expr: NewExpression, analysis: ModuleAnalysis): HirExpr {
  if (expr.callee.type !== "Identifier") {
    throw new UnsupportedError({ type: "new with a non-identifier callee" });
  }
  const className = (expr.callee as Identifier).name;
  const args: HirArg[] = expr.arguments.map((a) => ({
    borrow: "owned",
    expr: lowerExpr(a, analysis),
  }));
  return { kind: "call", callee: `${className}::new`, args };
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

function lowerType(ty: TSType, structs: Set<string>): RustType {
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
      if (ref.typeName.name === "Promise") {
        // An `async fn`'s Rust return type is its resolved `T`, not a wrapper —
        // Rust wraps in `Future` implicitly. `Promise<void>` → `()`. In-dialect
        // `Promise` only ever annotates an `async` return (see design 014).
        const inner = ref.typeArguments?.params?.[0];
        if (!inner) throw new UnsupportedError(ty);
        return lowerType(inner, structs);
      }
      if (ref.typeName.name === "Array") {
        const inner = ref.typeArguments?.params?.[0];
        if (!inner) throw new UnsupportedError(ty);
        return { kind: "vec", elem: lowerType(inner, structs) };
      }
      if (ref.typeName.name === "Record") {
        // `Record<string, V>` → `HashMap<String, V>`. Only a `string` key maps
        // soundly: `f64` (a `number` key) is neither `Eq` nor `Hash` in Rust.
        const [key, value] = ref.typeArguments?.params ?? [];
        if (!key || !value) throw new UnsupportedError(ty);
        if (key.type !== "TSStringKeyword") {
          throw new UnsupportedError({
            type: "Record with a non-string key (only string keys map to HashMap)",
          });
        }
        return {
          kind: "hashmap",
          key: { kind: "String" },
          value: lowerType(value, structs),
        };
      }
      // A reference to a declared `interface` → its nominal `struct` type. An
      // unknown type name stays fail-loud (`Promise`, `Map`, … are unsupported).
      if (structs.has(ref.typeName.name)) {
        return { kind: "struct", name: ref.typeName.name };
      }
      throw new UnsupportedError(ty);
    }
    default:
      throw new UnsupportedError(ty);
  }
}
