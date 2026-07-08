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

import {
  type ModuleAnalysis,
  SCRIPT_SCOPE,
  analyzeModule,
  isErrorSubclass,
} from "./analysis";
import { refineArena } from "./arena";
import type {
  ArrayExpression,
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
  Param,
  Program,
  PropertyDefinition,
  ReturnStatement,
  Statement,
  SwitchStatement,
  TSEnumDeclaration,
  TSInterfaceDeclaration,
  TSType,
  ThrowStatement,
  TryStatement,
  VariableDeclaration,
  WhileStatement,
} from "./ast";
import { DialectError, UnsupportedError } from "./errors";
import type {
  Borrow,
  HirArg,
  HirClass,
  HirEnum,
  HirErrorClass,
  HirExpr,
  HirFn,
  HirItem,
  HirMatchArm,
  HirModule,
  HirParam,
  HirStmt,
  HirStruct,
  MapBuildPart,
  RustType,
  SelfRecv,
} from "./hir";
import { refineNumerics } from "./numeric";
import { refineOwnership } from "./ownership";
import { refineRc } from "./rc";
import { refineStrings } from "./strings";
import { validate } from "./validate";

// Re-exported so existing importers (`from "./lower"`) and the emitter's own
// re-export keep working; both classes now live in ./errors (see that file).
export { DialectError, UnsupportedError };

const UNIT: RustType = { kind: "unit" };
/** The default fallible error type: the `Error` message as a `String`. */
const ERR_STRING: RustType = { kind: "String" };

/** Wrap an ok-type in `Result<ok, err>`. */
function resultType(ok: RustType, err: RustType): RustType {
  return { kind: "result", ok, err };
}

/**
 * The program-wide error type: `Box<dyn std::error::Error>` when any custom
 * error class is declared (series 022), else `String`. Uniform across every
 * fallible function so `?` composes.
 */
function programErrType(analysis: ModuleAnalysis): RustType {
  return analysis.errorClasses.size > 0 ? { kind: "boxError" } : ERR_STRING;
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
  // Enum names are nominal types too — resolve them like structs in `lowerType`
  // (the emitter renders both as the bare name). They stay in `analysis.enums`
  // as well, so a member access `E.Variant` still lowers to a path, not a field.
  for (const e of analysis.enums) analysis.structs.add(e);
  // Struct field types (series 032) — a pre-pass so a struct object literal can
  // recurse into a struct-typed field / array element wherever it appears.
  analysis.structFields = collectStructFields(normalized, analysis.structs);
  const items: HirItem[] = [];
  const script: Statement[] = [];

  for (const stmt of normalized.body) {
    if (stmt.type === "FunctionDeclaration") {
      // A sync generator (`function* g()`, series 025d) lowers to a
      // `fn -> impl Iterator`; a plain function to a normal `fn`.
      items.push(
        (stmt as { generator?: boolean }).generator === true
          ? lowerGenerator(stmt as FunctionDeclaration, analysis)
          : lowerFunction(stmt as FunctionDeclaration, analysis),
      );
    } else if (stmt.type === "TSInterfaceDeclaration") {
      items.push(
        lowerInterface(stmt as TSInterfaceDeclaration, analysis.structs),
      );
    } else if (stmt.type === "TSEnumDeclaration") {
      items.push(lowerEnum(stmt as TSEnumDeclaration));
    } else if (stmt.type === "ClassDeclaration") {
      // A `class X extends Error` is a custom error type, not a data class.
      items.push(
        isErrorSubclass(stmt)
          ? lowerErrorClass(stmt as ClassDeclaration)
          : lowerClass(stmt as ClassDeclaration, analysis),
      );
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
    main = lowerStatements(
      takeDirectives(script, { panicAllowed: true }),
      analysis,
      SCRIPT_SCOPE,
    );
    // A script that propagates a throwing call (or throws) makes `main` fallible:
    // `fn main() -> Result<(), String>`, returns wrapped in `Ok`, trailing `Ok(())`.
    if (analysis.fallible.has(SCRIPT_SCOPE)) {
      main = makeFallible(main, UNIT);
      mainRet = resultType(UNIT, programErrType(analysis));
    }
    // A script that `await`s needs an async runtime entry: `#[tokio::main] async
    // fn main()` (composes with `mainRet` if the script also throws).
    if (hirHasAwait(main)) mainAsync = true;
  }

  // Final gate steps: refine `number` → `usize` where indexing demands it, then
  // read-only `string` params (`&String`) → the idiomatic `&str`, then the
  // ownership-model directives — `"use rc"` scopes → `Rc<RefCell<T>>` (028b) and
  // `"use arena"` scopes → `bumpalo` bump allocation (028c) — and *finally*
  // use-after-move → `.clone()`. Ownership runs **last** so it sees the HIR after
  // the directives have imposed their own ownership model: an `rc` alias is already
  // `Rc::clone` (not a bare move) and an arena `Vec` is already un-annotated, so the
  // clone pass leaves both alone and only fills the remaining plain-move gaps (037).
  return refineOwnership(
    refineArena(
      refineRc(
        refineStrings(refineNumerics({ items, main, mainRet, mainAsync })),
        { rcScopes: analysis.rcScopes, classes: analysis.classes },
      ),
      analysis.arenaScopes,
    ),
  );
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

// ── Directives (series 028) ──────────────────────────────────────────────────

/**
 * Consume the leading string-literal *directives* of a scope, validating each,
 * and return the remaining statements. `"use panic"` (028a) is consumed here —
 * its semantics already live in `analysis.panicScopes` — as are `"use rc"` (028b,
 * `analysis.rcScopes`, applied by `refineRc`), `"use arena"` (028c,
 * `analysis.arenaScopes`, applied by `refineArena`), and the JS-standard
 * `"use strict"` no-op. Any other `"use …"` string fails loud (`DialectError`,
 * never a silent no-op). A non-`use` leading string is not a directive and is
 * left in place.
 *
 * @throws {DialectError} on an unrecognized `"use …"` directive.
 * @throws {UnsupportedError} on a strategy directive (`"use panic"`/`"use rc"`/
 *   `"use arena"`) outside a free fn / script.
 */
function takeDirectives(
  stmts: Statement[],
  opts?: { panicAllowed?: boolean },
): Statement[] {
  let i = 0;
  for (; i < stmts.length; i++) {
    const s = stmts[i];
    if (!s || s.type !== "ExpressionStatement") break;
    const e = (s as ExpressionStatement).expression;
    if (e.type !== "Literal" || typeof (e as Literal).value !== "string") break;
    const d = (e as Literal).value as string;
    if (d === "use panic") {
      if (!opts?.panicAllowed) {
        throw new UnsupportedError({
          type: "`use panic` outside a free function or the top-level script",
        });
      }
      continue;
    }
    if (d === "use strict") continue; // JS prologue, a no-op for us
    if (d === "use rc") {
      // 028b: consumed here — its semantics live in `analysis.rcScopes`, applied
      // by the `refineRc` pass. Like `"use panic"`, only on a free fn / script.
      if (!opts?.panicAllowed) {
        throw new UnsupportedError({
          type: "`use rc` outside a free function or the top-level script",
        });
      }
      continue;
    }
    if (d === "use arena") {
      // 028c: consumed here — semantics live in `analysis.arenaScopes`, applied
      // by the `refineArena` pass. Like `"use rc"`, only on a free fn / script.
      if (!opts?.panicAllowed) {
        throw new UnsupportedError({
          type: "`use arena` outside a free function or the top-level script",
        });
      }
      continue;
    }
    if (d.startsWith("use ")) {
      throw new DialectError(`unrecognized directive "${d}"`);
    }
    break; // a non-`use` leading string literal is not a directive
  }
  return stmts.slice(i);
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
  // A missing return type used to default silently to `-> ()`; it now fails loud
  // (series 046c). An explicit `: void` annotation still lowers to `UNIT` via
  // `lowerType`, so genuinely unit-returning functions annotate `: void`.
  if (!func.returnType) {
    throw new UnsupportedError({
      type: `function '${name}' without a return type annotation`,
      start: func.id.start,
    });
  }
  const ret = lowerType(func.returnType.typeAnnotation, analysis.structs);

  if (!func.body)
    throw new UnsupportedError({ type: "function without a body" });
  // The function name is its own scope key for mutability lookups. Leading
  // directives (`"use panic"`, 028a) are consumed here — panic semantics already
  // live in `analysis.panicScopes`; stripping keeps the string out of the body.
  const body = lowerStatements(
    takeDirectives(func.body.body, { panicAllowed: true }),
    analysis,
    name,
  );

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
      ret: resultType(ret, programErrType(analysis)),
      body: makeFallible(body, ret),
    };
  }

  return { kind: "fn", name, isAsync: func.async, params, ret, body };
}

/**
 * Lower a sync generator (`function* g(): Generator<T> { yield a; yield b; … }`,
 * series 025d) to a `fn g(…) -> impl Iterator<Item = T>` that returns a fixed
 * sequence: `vec![a, b, …].into_iter()`. This first slice handles the
 * **straight-line finite-yield** shape — a body that is exactly a sequence of
 * `yield <expr>;` statements. Anything else (a `yield` inside a loop / `if` /
 * `switch`, a `yield*` delegation, a non-`yield` statement, an `async` generator,
 * or a missing/again-`Generator` return annotation) is a real state-machine
 * transform and stays fail-loud (`UnsupportedError`) until a later increment.
 *
 * The item type comes from the `Generator<T>` / `IterableIterator<T>` return
 * annotation; `for (const x of g())` consumes the result directly (see
 * `lowerForOf`).
 */
function lowerGenerator(
  func: FunctionDeclaration,
  analysis: ModuleAnalysis,
): HirFn {
  if (!func.id) throw new UnsupportedError(func);
  const name = func.id.name;
  const info = analysis.fns.get(name);
  const params = func.params.map((p, i) =>
    lowerParam(p, info?.params[i], analysis.structs),
  );

  // The element type is the first type argument of the `Generator<T>` /
  // `IterableIterator<T>` return annotation. A bare/absent annotation is fail-loud
  // — an item type can't be inferred soundly for `impl Iterator`.
  const ann = func.returnType?.typeAnnotation;
  const ref =
    ann?.type === "TSTypeReference"
      ? (ann as Extract<TSType, { type: "TSTypeReference" }>)
      : null;
  const genNames = new Set(["Generator", "IterableIterator", "Iterable"]);
  if (!ref || !genNames.has(ref.typeName.name)) {
    throw new UnsupportedError({
      type: "generator without a `Generator<T>` / `IterableIterator<T>` return annotation",
    });
  }
  const itemAnn = ref.typeArguments?.params?.[0];
  if (!itemAnn)
    throw new UnsupportedError({ type: "generator without an item type" });
  const item = lowerType(itemAnn, analysis.structs);

  if (!func.body)
    throw new UnsupportedError({ type: "generator without a body" });
  // Straight-line finite yields only: every statement must be a bare `yield e;`.
  const elements: HirExpr[] = func.body.body.map((s) => {
    const expr =
      s.type === "ExpressionStatement"
        ? (s as ExpressionStatement).expression
        : null;
    if (!expr || expr.type !== "YieldExpression") {
      throw new UnsupportedError({
        type: "generator body is not a straight-line sequence of `yield` (state-machine generators are a later slice)",
      });
    }
    const y = expr as unknown as { delegate?: boolean; argument?: Expression };
    if (y.delegate) {
      throw new UnsupportedError({ type: "`yield*` delegation" });
    }
    if (!y.argument) {
      throw new UnsupportedError({ type: "bare `yield` (no value)" });
    }
    return lowerExpr(y.argument, analysis);
  });

  // `vec![e1, …].into_iter()` is an idiomatic `impl Iterator<Item = T>` — no
  // state machine needed for the finite case.
  const body: HirStmt[] = [
    {
      kind: "return",
      value: {
        kind: "method",
        receiver: { kind: "array", elements },
        name: "into_iter",
        args: [],
      },
    },
  ];
  return {
    kind: "fn",
    name,
    isAsync: false,
    params,
    ret: { kind: "implIterator", item },
    body,
  };
}

// ── Fallibility (throw / Result propagation) ─────────────────────────────────

/** The built-in single-message Error constructors, all erased to `Err(String)`. */
const ERROR_CLASSES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
]);

/**
 * Lower a `throw` to a `throw` HIR stmt (emitted as `return Err(<message>);`).
 * Two shapes map, both carrying a `String` payload (E is uniformly `String`):
 * `throw new <ErrorClass>(message)` for the built-in single-message constructors
 * (the class distinction is erased), and a bare string literal `throw "msg"` (the
 * literal is its own message). A thrown variable/expression (needs type tracking
 * to confirm `String`), a user/custom error class (custom error types are a later
 * series), a `cause`/multi-arg throw, or any other value is fail-loud. The message
 * lowers as an expression, so a string literal becomes a `String` and `Err`
 * carries it.
 */
function lowerThrow(
  stmt: ThrowStatement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt {
  const arg = stmt.argument;
  const errTy = programErrType(analysis);
  // In a `"use panic"` scope (028a) a throw aborts with its message; the class
  // (built-in or custom) is erased, exactly as under the `String` error type.
  const panic = analysis.panicScopes.has(scope);
  if (arg.type === "NewExpression") {
    const nw = arg as NewExpression;
    if (nw.callee.type !== "Identifier") {
      throw new UnsupportedError({
        type: "throw of a non-identifier constructor",
      });
    }
    const cname = (nw.callee as Identifier).name;
    const isCustom = analysis.errorClasses.has(cname);
    if (!isCustom && !ERROR_CLASSES.has(cname)) {
      throw new UnsupportedError({
        type: "throw of an unknown error class (declare it as `class X extends Error`)",
      });
    }
    const [message] = nw.arguments;
    if (nw.arguments.length !== 1 || !message) {
      throw new UnsupportedError({
        type: "throw new <Error>() must have exactly one message argument",
      });
    }
    const msg = lowerExpr(message, analysis);
    if (panic) return { kind: "throw", value: msg, panic: true };
    // A custom error is boxed: `Box::new(<X>::new(msg))`. A built-in `Error` /
    // string throw carries the message; under a boxed program error type it
    // converts with `.into()` (the `From<String>` for `Box<dyn Error>`).
    if (isCustom) {
      const ctor: HirExpr = {
        kind: "call",
        callee: `${cname}::new`,
        args: [{ borrow: "owned", expr: msg }],
      };
      return {
        kind: "throw",
        value: {
          kind: "call",
          callee: "Box::new",
          args: [{ borrow: "owned", expr: ctor }],
        },
      };
    }
    return { kind: "throw", value: boxIfNeeded(msg, errTy) };
  }
  // `throw "literal"` — a bare string literal is thrown as its own message.
  if (arg.type === "Literal" && typeof (arg as Literal).value === "string") {
    const msg = lowerExpr(arg, analysis);
    if (panic) return { kind: "throw", value: msg, panic: true };
    return { kind: "throw", value: boxIfNeeded(msg, errTy) };
  }
  throw new UnsupportedError({
    type: "throw of a non-Error, non-string-literal value",
  });
}

/**
 * Under a `Box<dyn Error>` program error type, a `String` message must convert to
 * the boxed error via `.into()` (the standard `From<String>` impl). Under the
 * `String` error type (no custom error classes) the message is carried as-is.
 */
function boxIfNeeded(msg: HirExpr, errTy: RustType): HirExpr {
  return errTy.kind === "boxError"
    ? { kind: "method", receiver: msg, name: "into", args: [] }
    : msg;
}

/**
 * Lower a `class X extends Error { constructor(message: string) { super(message); } }`
 * to a `HirErrorClass`. Only that exact shape maps — no fields, exactly one
 * constructor taking a single message param whose body is `super(message);` —
 * anything else is fail-loud (richer custom error shapes are a later series).
 */
function lowerErrorClass(decl: ClassDeclaration): HirErrorClass {
  const name = decl.id?.name;
  if (!name) throw new UnsupportedError({ type: "anonymous error class" });
  const members = decl.body.body;
  const nonCtor = members.filter(
    (m) => !(m.type === "MethodDefinition" && m.kind === "constructor"),
  );
  if (nonCtor.length > 0) {
    throw new UnsupportedError({
      type: "custom error class with extra members (only { message } is supported)",
    });
  }
  const ctors = members.filter(
    (m): m is MethodDefinition =>
      m.type === "MethodDefinition" && m.kind === "constructor",
  );
  const [ctorDef] = ctors;
  if (ctors.length !== 1 || !ctorDef) {
    throw new UnsupportedError({
      type: "custom error class must have exactly one constructor",
    });
  }
  const ctor = ctorDef.value;
  if (ctor.params.length !== 1) {
    throw new UnsupportedError({
      type: "custom error class constructor must take exactly one message param",
    });
  }
  const body = ctor.body?.body ?? [];
  const only = body[0];
  const isSuperCall =
    body.length === 1 &&
    only?.type === "ExpressionStatement" &&
    (only as ExpressionStatement).expression.type === "CallExpression" &&
    ((only as ExpressionStatement).expression as CallExpression).callee.type ===
      "Super";
  if (!isSuperCall) {
    throw new UnsupportedError({
      type: "custom error class constructor body must be `super(message)`",
    });
  }
  return { kind: "errorClass", name };
}

/**
 * Lower a `try`/`catch`/`finally` to a `tryCatch` HIR node (an `if let Err` over
 * a `Result`-returning IIFE closure). Statement-level recovery only: a `catch`
 * handler is required, and neither the `try` nor the `catch` body may `return` /
 * `break` / `continue` past the closure (value-yielding `try`/`catch` is
 * deferred). A `finally` runs after; a re-`throw` in `catch` alongside a
 * `finally` is rejected (the trailing `finally` would be skipped). The `try`
 * body is `makeFallible`-wrapped so its fallible calls/`throw`s get the closure's
 * `Ok(())` tail (there are no returns to wrap — they're rejected).
 */
function lowerTry(
  stmt: TryStatement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt {
  if (!stmt.handler) {
    throw new UnsupportedError({
      type: "try/finally without a catch handler (deferred)",
    });
  }
  const rawTry = lowerStatements(stmt.block.body, analysis, scope);
  const catchBody = lowerStatements(stmt.handler.body.body, analysis, scope);
  if (escapesClosure(rawTry, false) || escapesClosure(catchBody, false)) {
    throw new UnsupportedError({
      type: "return/break/continue inside try/catch (value-yielding try/catch: deferred)",
    });
  }
  const finallyBody = stmt.finalizer
    ? lowerStatements(stmt.finalizer.body, analysis, scope)
    : null;
  if (finallyBody && hirHasThrowOrTry(catchBody)) {
    throw new UnsupportedError({
      type: "re-throw inside catch alongside a finally (deferred)",
    });
  }
  return {
    kind: "tryCatch",
    tryBody: makeFallible(rawTry, UNIT),
    catchParam: stmt.handler.param ? stmt.handler.param.name : null,
    catchBody,
    finallyBody,
    errTy: programErrType(analysis),
  };
}

/**
 * Does a statement list contain a control-flow jump that would escape the `try`
 * IIFE closure? A `return` anywhere escapes it; a `break`/`continue` escapes only
 * when it is *not* bound by a loop nested inside the try (`insideLoop`). Descends
 * `if`/`block`/`match` and into loops (to catch a `return` there), but a
 * `break`/`continue` under a nested loop is that loop's own concern.
 */
function escapesClosure(stmts: HirStmt[], insideLoop: boolean): boolean {
  for (const s of stmts) {
    switch (s.kind) {
      case "return":
        return true;
      case "break":
      case "continue":
        if (!insideLoop) return true;
        break;
      case "if":
        if (escapesClosure(s.conseq, insideLoop)) return true;
        if (s.alt && escapesClosure(s.alt, insideLoop)) return true;
        break;
      case "block":
        if (escapesClosure(s.body, insideLoop)) return true;
        break;
      case "match":
        for (const arm of s.arms)
          if (escapesClosure(arm.body, insideLoop)) return true;
        break;
      case "while":
      case "forIn":
      case "forRange":
        if (escapesClosure(s.body, true)) return true;
        break;
    }
  }
  return false;
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
      return {
        kind: "while",
        cond: stmt.cond,
        body: stmt.body.map(wrapReturns),
      };
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
    if (!m.typeAnnotation) {
      throw new UnsupportedError({
        type: `interface field '${m.key.name}' without a type`,
      });
    }
    // An optional field `x?: T` is `Option<T>` (series 042b).
    return {
      name: m.key.name,
      ty: fieldRustType(
        m.typeAnnotation.typeAnnotation,
        m.optional === true,
        structs,
      ),
    };
  });
  return { kind: "struct", name: decl.id.name, fields };
}

/**
 * Lower `enum E { A, B = 1 }` to a `HirEnum` (a C-like Rust enum). Variants must
 * be plain identifiers; an initializer, if present, must be an integer literal
 * (an explicit discriminant). `const enum` (compile-time inlining) and
 * string-valued members are rejected — each a later slice.
 */
function lowerEnum(decl: TSEnumDeclaration): HirEnum {
  if (decl.const) {
    throw new UnsupportedError({
      type: "`const enum` (compile-time inlining)",
    });
  }
  const variants = decl.body.members.map((m) => {
    if (m.computed || m.id.type !== "Identifier") {
      throw new UnsupportedError({ type: "computed enum member" });
    }
    let disc: number | null = null;
    if (m.initializer) {
      const init = m.initializer;
      if (
        init.type !== "Literal" ||
        typeof (init as Literal).value !== "number"
      ) {
        throw new UnsupportedError({
          type: "enum member initializer must be an integer literal (string enums unsupported)",
        });
      }
      const v = (init as Literal).value as number;
      if (!Number.isInteger(v)) {
        throw new UnsupportedError({
          type: "enum member with a fractional discriminant",
        });
      }
      disc = v;
    }
    return { name: m.id.name, disc };
  });
  return { kind: "enum", name: decl.id.name, variants };
}

/**
 * Lower a `class` to a `HirClass` (a `struct` + `impl`). Fields come from
 * `PropertyDefinition`s; the constructor becomes an associated `new`; each method
 * becomes an `fn` with a `self` receiver. Inheritance (`extends`/`implements`),
 * statics, accessors, and a missing constructor are rejected — each a later
 * series. Fields are collected first so a method or the constructor may reference
 * a field declared after it.
 */
function lowerClass(
  decl: ClassDeclaration,
  analysis: ModuleAnalysis,
): HirClass {
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
      return {
        name: f.key.name,
        ty: lowerType(f.typeAnnotation.typeAnnotation, structs),
      };
    });

  // Parameter properties (`constructor(public x: T)`) each contribute a field,
  // appended after the explicit ones (declaration order within the ctor params).
  const ctorMember = decl.body.body.find(
    (m): m is MethodDefinition =>
      m.type === "MethodDefinition" && m.kind === "constructor",
  );
  if (ctorMember) {
    for (const p of ctorMember.value.params as unknown as Param[]) {
      if (p.type !== "TSParameterProperty") continue;
      const inner = p.parameter;
      if (!inner.typeAnnotation) {
        throw new UnsupportedError({
          type: `parameter property '${inner.name}' without a type`,
        });
      }
      fields.push({
        name: inner.name,
        ty: lowerType(inner.typeAnnotation.typeAnnotation, structs),
      });
    }
  }

  let ctor: HirFn | null = null;
  let dispose: HirStmt[] | null = null;
  const methods: HirFn[] = [];
  for (const member of decl.body.body) {
    if (member.type !== "MethodDefinition") continue;
    // A `[Symbol.dispose]() { … }` method → the class's `Drop` impl (series 025).
    if (isDisposeMethod(member)) {
      if (!member.value.body) {
        throw new UnsupportedError({ type: "[Symbol.dispose] without a body" });
      }
      dispose = lowerStatements(
        member.value.body.body,
        analysis,
        `${name}.drop`,
      );
      continue;
    }
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
    throw new UnsupportedError({
      type: "class without an explicit constructor",
    });
  }
  // Throwing / `?`-propagation inside methods and constructors is supported
  // (series 023): the fallibility fixpoint types the method/ctor as `Result` and
  // `?`-propagates fallible method/`new` calls.
  return { kind: "class", name, fields, ctor, methods, dispose };
}

/** Is this a `[Symbol.dispose]() { … }` method (→ the class's `Drop` impl)? */
function isDisposeMethod(member: MethodDefinition): boolean {
  if (!member.computed) return false;
  const key = member.key as unknown as Expression;
  if (key.type !== "MemberExpression") return false;
  const m = key as MemberExpression;
  return (
    m.object.type === "Identifier" &&
    (m.object as Identifier).name === "Symbol" &&
    m.property.type === "Identifier" &&
    (m.property as Identifier).name === "dispose"
  );
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
  // A parameter property (`public x: T`) both declares a field (added in
  // `lowerClass`) and initializes it from the moved-in argument — seed that
  // field-init here and unwrap the binding to an ordinary param.
  const assigned = new Map<string, HirExpr>();
  const params = (fn.params as unknown as Param[]).map((p) => {
    if (p.type === "TSParameterProperty") {
      assigned.set(p.parameter.name, {
        kind: "ident",
        name: p.parameter.name,
      });
      return lowerParam(p.parameter, undefined, structs);
    }
    return lowerParam(p, undefined, structs);
  });
  if (!fn.body) {
    throw new UnsupportedError({ type: "constructor without a body" });
  }
  const isFallible = analysis.fallibleCtors.has(className);
  // Field-init assignments are folded into the returned struct literal; any other
  // statement is a *guard* (`if (…) throw …`), allowed only in a fallible ctor
  // (which returns `Result`), emitted as leading statements before the return.
  const leading: HirStmt[] = [];
  for (const stmt of fn.body.body) {
    const init = constructorFieldInit(stmt, analysis);
    if (init) {
      assigned.set(init.field, init.value);
      continue;
    }
    if (!isFallible) {
      throw new UnsupportedError({
        type: "constructor body beyond `this.field = expr` initialization",
      });
    }
    leading.push(...lowerStatement(stmt, analysis, `${className}.constructor`));
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
  const structLit: HirExpr = {
    kind: "structLit",
    name: className,
    fields: litFields,
  };
  if (isFallible) {
    return {
      kind: "fn",
      name: "new",
      isAsync: false,
      params,
      ret: resultType(
        { kind: "struct", name: className },
        programErrType(analysis),
      ),
      body: [
        ...leading,
        { kind: "return", value: { kind: "ok", value: structLit } },
      ],
    };
  }
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
 * `m["k"] = v` — a `=` write to a *string-keyed* computed member — lowers to a
 * HashMap insert `m.insert("k".to_string(), v)` (series 031, gap E): Rust's
 * `Index` on `HashMap` is read-only, so an index-assign there is rejected. A
 * numeric index (`arr[0] = v`) is a `Vec` write (valid via `IndexMut`) and
 * returns `null` — left as an ordinary index-assign. A non-`=` operator likewise
 * returns `null`. A non-literal key can't be told apart from a `Vec` index
 * without a binding-type table, so it too stays an index-assign (a documented
 * residual for the rarer HashMap-variable-key write).
 */
function tryHashMapInsert(
  a: { operator: string; left: Expression; right: Expression },
  analysis: ModuleAnalysis,
): HirExpr | null {
  if (a.operator !== "=" || a.left.type !== "MemberExpression") return null;
  const m = a.left as MemberExpression;
  if (!m.computed || m.property.type !== "Literal") return null;
  const key = (m.property as { value: unknown }).value;
  if (typeof key !== "string") return null; // numeric index → Vec, not HashMap
  return {
    kind: "method",
    receiver: lowerExpr(m.object, analysis),
    name: "insert",
    args: [{ kind: "string", value: key }, lowerExpr(a.right, analysis)],
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
  // A missing return type fails loud (series 046c); an explicit `: void` still
  // lowers to `UNIT`.
  if (!fn.returnType) {
    throw new UnsupportedError({
      type: `method '${name}' without a return type annotation`,
      start: (member.key as { start?: number }).start,
    });
  }
  const ret = lowerType(fn.returnType.typeAnnotation, structs);
  if (!fn.body) throw new UnsupportedError({ type: "method without a body" });
  const body = lowerStatements(
    takeDirectives(fn.body.body),
    analysis,
    `${className}.${name}`,
  );
  // `&mut self` when the method mutates `self` — directly or transitively (it
  // calls another self-mutating method); `analysis.mutatingMethods` is the
  // fixpoint of both. A fallible method (throws or propagates) returns `Result`.
  const recv: SelfRecv = analysis.mutatingMethods.has(name) ? "refMut" : "ref";
  if (analysis.fallibleMethods.has(name)) {
    return {
      kind: "fn",
      name,
      isAsync: fn.async,
      params,
      ret: resultType(ret, programErrType(analysis)),
      body: makeFallible(body, ret),
      recv,
    };
  }
  return { kind: "fn", name, isAsync: fn.async, params, ret, body, recv };
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
  // An optional param `(x?: T)` is `Option<T>` (series 042); `(x: T | undefined)`
  // already lowers to `option` via the union in `lowerType`.
  const annotated = lowerType(p.typeAnnotation.typeAnnotation, structs);
  const optional =
    (p as { optional?: boolean }).optional === true ||
    annotated.kind === "option";
  const base: RustType =
    (p as { optional?: boolean }).optional && annotated.kind !== "option"
      ? { kind: "option", inner: annotated }
      : annotated;
  // An `Option` param is passed **by value** (owned): `??`/pattern-matching
  // consumes it, and `&Option<T>` would not satisfy those. Non-optional params
  // keep the inferred borrow.
  const ownership = optional ? "move" : (info?.ownership ?? "move");
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
    case "ExpressionStatement": {
      const e = (stmt as { expression: Expression }).expression;
      // `xs.forEach(p => …)` lowers to a `for` loop (a statement), not an expr.
      const forEach = tryForEach(e, analysis, scope);
      if (forEach) return forEach;
      return [{ kind: "expr", expr: lowerExpr(e, analysis) }];
    }
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
      return [lowerThrow(stmt as ThrowStatement, analysis, scope)];
    case "TryStatement":
      return [lowerTry(stmt as TryStatement, analysis, scope)];
    default:
      throw new UnsupportedError(stmt);
  }
}

function lowerIf(
  stmt: IfStatement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt {
  // Option narrowing (series 042c): `if (x !== undefined) { … }` →
  // `if let Some(x) = x { … }`, so `x` is the inner `T` inside the block. The
  // `=== undefined` form narrows the *else* branch (branches swap).
  const narrow = optionNarrowTest(stmt.test);
  if (narrow) {
    const conseq = lowerBlock(stmt.consequent, analysis, scope);
    const alt = stmt.alternate
      ? lowerBlock(stmt.alternate, analysis, scope)
      : null;
    const scrutinee: HirExpr = { kind: "ident", name: narrow.name };
    if (narrow.op === "!==") {
      return {
        kind: "ifLet",
        binding: narrow.name,
        scrutinee,
        someBody: conseq,
        noneBody: alt,
      };
    }
    // `=== undefined`: the present-value branch is the `else`; narrow only when
    // it exists (a bare `if (x === undefined)` uses the `is_none()` condition).
    if (alt) {
      return {
        kind: "ifLet",
        binding: narrow.name,
        scrutinee,
        someBody: alt,
        noneBody: conseq,
      };
    }
  }
  return {
    kind: "if",
    cond: lowerExpr(stmt.test, analysis),
    conseq: lowerBlock(stmt.consequent, analysis, scope),
    alt: lowerAlternate(stmt.alternate, analysis, scope),
  };
}

/**
 * Recognize an `Option`-narrowing `if` test — `x === undefined`/`null` or
 * `x !== undefined`/`null` where `x` is an identifier (series 042c). Returns the
 * binding name and operator, or `null` when it is not that shape.
 */
function optionNarrowTest(
  test: Expression,
): { name: string; op: "===" | "!==" } | null {
  if (test.type !== "BinaryExpression") return null;
  const b = test as { operator: string; left: Expression; right: Expression };
  if (b.operator !== "===" && b.operator !== "!==") return null;
  const leftNull = isNullishExpr(b.left);
  const rightNull = isNullishExpr(b.right);
  if (leftNull === rightNull) return null;
  const idExpr = leftNull ? b.right : b.left;
  if (idExpr.type !== "Identifier") return null;
  return { name: (idExpr as Identifier).name, op: b.operator as "===" | "!==" };
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
 * A bare `continue` in the body would jump to the `while` condition and **skip**
 * the appended `update` — a semantic change. Rather than reject it (as before),
 * each *own* `continue` (not inside a nested loop) is rewritten to
 * `{ update; continue; }`, so the loop variable still advances before continuing
 * (`inlineUpdateBeforeContinue`). This is label-free — an unlabeled `break`
 * through a labeled block is a hard error (E0695), so the `'step:`-block approach
 * is avoided. `break` is untouched: a bare `break` exits the `while`, exactly as
 * the `for` would. A `for` with no `update` needs no rewrite (nothing to skip).
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

  const update: HirStmt | null = stmt.update
    ? { kind: "expr", expr: lowerExpr(stmt.update, analysis) }
    : null;

  let body = lowerBlock(stmt.body, analysis, scope);
  // An own `continue` skips the bottom `update`; inline the update before each so
  // the loop variable still advances. Only meaningful when there is an `update`.
  if (update && hasOwnContinue(stmt.body)) {
    body = inlineUpdateBeforeContinue(body, update);
  }
  if (update) body.push(update);

  const cond: HirExpr = stmt.test
    ? lowerExpr(stmt.test, analysis)
    : { kind: "bool", value: true };

  return { kind: "block", body: [...init, { kind: "while", cond, body }] };
}

/**
 * Rewrite each *own* `continue` in a C-style `for` body to `{ update; continue; }`
 * (a `block`), so the loop variable advances before re-testing. Descends through
 * `if`/`block`/`match` (transparent to `continue`) but stops at a nested
 * `while`/`forIn` — that loop owns its own `continue`. A nested C-style `for` is a
 * `block` containing a `while`, so its inner `continue`s sit under the barrier and
 * are left untouched. The `update` node is shared across sites (never mutated).
 */
function inlineUpdateBeforeContinue(
  stmts: HirStmt[],
  update: HirStmt,
): HirStmt[] {
  return stmts.map((s) => inlineUpdateInStmt(s, update));
}

function inlineUpdateInStmt(stmt: HirStmt, update: HirStmt): HirStmt {
  switch (stmt.kind) {
    case "continue":
      return { kind: "block", body: [update, { kind: "continue" }] };
    case "if":
      return {
        kind: "if",
        cond: stmt.cond,
        conseq: inlineUpdateBeforeContinue(stmt.conseq, update),
        alt: stmt.alt ? inlineUpdateBeforeContinue(stmt.alt, update) : null,
      };
    case "block":
      return {
        kind: "block",
        body: inlineUpdateBeforeContinue(stmt.body, update),
      };
    case "match":
      return {
        kind: "match",
        disc: stmt.disc,
        arms: stmt.arms.map((a) => ({
          guard: a.guard,
          body: inlineUpdateBeforeContinue(a.body, update),
        })),
      };
    default:
      // `while`/`forIn` own their own `continue` (barrier); other stmts carry none.
      return stmt;
  }
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
  // Array-pattern destructuring `for (const [k, v] of …)` (series 043) — the
  // `Object.entries` consumption form. Over `Object.entries(m)` iterate the map
  // directly (`for (k, v) in m.iter()`); over a stored `Vec<(K,V)>` iterate it.
  const declId = decl.id as unknown as {
    type: string;
    elements?: ({ type: string; name?: string } | null)[];
  };
  if (declId.type === "ArrayPattern") {
    const elems = declId.elements ?? [];
    const k = elems[0];
    const v = elems[1];
    if (
      elems.length !== 2 ||
      k?.type !== "Identifier" ||
      v?.type !== "Identifier" ||
      !k.name ||
      !v.name
    ) {
      throw new UnsupportedError({
        type: "for-of destructuring must bind exactly `[k, v]` identifiers",
      });
    }
    const target = isObjectEntriesCall(stmt.right)
      ? ((stmt.right as CallExpression).arguments[0] as Expression)
      : stmt.right;
    return {
      kind: "forIn",
      pat: `(${k.name}, ${v.name})`,
      iter: {
        kind: "method",
        receiver: lowerExpr(target, analysis),
        name: "iter",
        args: [],
      },
      body: lowerBlock(stmt.body, analysis, scope),
    };
  }
  // A `for (const x of g())` over a call to a sync generator (series 025d)
  // consumes the returned `impl Iterator` directly — no `.iter()`, and the
  // binding is `x` by value (`Item = T`). Everything else iterates by reference
  // (`.iter()`, binding `&T`), sound whether the iterable is owned or borrowed.
  const overGenerator =
    stmt.right.type === "CallExpression" &&
    (stmt.right as CallExpression).callee.type === "Identifier" &&
    analysis.generators.has(
      ((stmt.right as CallExpression).callee as Identifier).name,
    );
  const iter: HirExpr = overGenerator
    ? lowerExpr(stmt.right, analysis)
    : {
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

/**
 * Is an initializer a *statically-obvious* scalar literal or homogeneous
 * scalar-literal array (series 046)? Purely syntactic — one look at the node, no
 * scope, no types:
 *   - a `Literal` whose `typeof value` is `number` / `string` / `boolean`
 *     (`null` is `"object"`, so it is excluded) → true;
 *   - a non-empty `ArrayExpression` whose every element is such a scalar
 *     `Literal` **of the same `typeof`** → true;
 *   - anything else (call, binary, `-5` `UnaryExpression`, `null`/`undefined`,
 *     identifier, member access, template literal, object literal, empty /
 *     mixed / nested array) → false.
 * An untyped binding is allowed iff this holds; everything else must annotate.
 */
function isScalarLiteral(e: Expression | null): e is Literal {
  return (
    e != null &&
    e.type === "Literal" &&
    (typeof (e as Literal).value === "number" ||
      typeof (e as Literal).value === "string" ||
      typeof (e as Literal).value === "boolean")
  );
}

function isObviousLiteralInit(expr: Expression): boolean {
  if (isScalarLiteral(expr)) return true;
  if (expr.type === "ArrayExpression") {
    const els = (expr as ArrayExpression).elements;
    if (els.length === 0) return false;
    if (!els.every(isScalarLiteral)) return false;
    const first = typeof (els[0] as Literal).value;
    return els.every((e) => typeof (e as Literal).value === first);
  }
  return false;
}

/** An `<array>.find(…)` call — the shipped 042d form the lowerer types `Option<T>` by construction. */
function isArrayFindCall(e: Expression): boolean {
  return (
    e.type === "CallExpression" &&
    (e as CallExpression).callee.type === "MemberExpression" &&
    ((e as CallExpression).callee as MemberExpression).computed === false &&
    (((e as CallExpression).callee as MemberExpression).property as Identifier)
      .name === "find"
  );
}

function lowerVarDecl(
  decl: VariableDeclaration,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt[] {
  const mutable = analysis.mut.get(scope);
  return decl.declarations.map((d) => {
    if (!d.init) throw new UnsupportedError({ type: "uninitialized binding" });
    // Array/object destructuring in a plain binding is unsupported (only the
    // `for (const [k, v] of Object.entries(…))` pattern is, via `lowerForOf`).
    if ((d.id as { type: string }).type !== "Identifier") {
      throw new UnsupportedError({ type: "destructuring binding" });
    }
    const ty = d.id.typeAnnotation
      ? lowerType(d.id.typeAnnotation.typeAnnotation, analysis.structs)
      : null;
    // An untyped binding is allowed only for a statically-obvious scalar or
    // homogeneous-scalar-array literal (series 046) — anything else (a user
    // call, arithmetic, `-5`, `null`/`undefined`, an identifier, a member
    // access, an empty / mixed / nested array) leaks an un-checked type to
    // Rust inference, so it fails loud pointing at the fix: annotate it.
    //
    // Exceptions — builtin forms the lowerer already types *by construction*,
    // so no annotation is needed (and, for JSON.parse, none can express the
    // type): a stored `Object.entries(…)` (→ `Vec<(String, V)>`, 043b), an
    // untyped `JSON.parse(…)` (→ `serde_json::Value`, the 045c fallback), and
    // an `<array>.find(…)` (→ `Option<T>`, 042d). `using`/`await using`
    // resources are also skipped — their acquisition is typed by construction.
    const declKind = (decl as { kind: string }).kind;
    const gated = declKind === "const" || declKind === "let" || declKind === "var";
    if (
      gated &&
      ty === null &&
      !isObviousLiteralInit(d.init) &&
      !isObjectEntriesCall(d.init) &&
      !isJsonParseCall(d.init) &&
      !isArrayFindCall(d.init)
    ) {
      throw new UnsupportedError({
        type: `binding '${d.id.name}' without a type annotation`,
        start: d.id.start,
      });
    }
    // An object/array literal is interpreted from its binding's type: a `hashmap`
    // → `HashMap::from([…])`, a `struct` → `Name { … }`, a `vec<struct>` →
    // `vec![Name { … }, …]`, recursing into nested literals (series 032). A bare
    // object literal (no struct/record type) stays unsupported (via `lowerExpr`).
    const init = lowerTyped(d.init, ty, analysis);
    // Track an `Object.entries(...)` binding so `es[i][0]`/`es[i][1]` can lower to
    // tuple field access (series 043).
    if (isObjectEntriesCall(d.init)) analysis.entriesBindings.add(d.id.name);
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
  // The struct's declared field types drive recursion into nested struct / array
  // literals (series 032). An unknown struct has no entry — values lower plainly
  // (the cargo oracle catches a mismatch).
  const fieldTypes = analysis.structFields.get(name);
  const provided = new Set<string>();
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
    provided.add(key.value);
    const declared = fieldTypes?.find((f) => f.name === key.value)?.ty ?? null;
    return { name: key.value, value: lowerTyped(p.value, declared, analysis) };
  });
  // An omitted **optional** field (`Option<T>`) defaults to `None` (series 042b):
  // Rust struct literals require every field, so fill the gaps the JS literal left.
  for (const f of fieldTypes ?? []) {
    if (f.ty.kind === "option" && !provided.has(f.name)) {
      fields.push({ name: f.name, value: { kind: "none" } });
    }
  }
  return { kind: "structLit", name, fields };
}

/**
 * Lower an initializer *against a declared target type* (series 032). This is
 * what turns an object/array literal into the right Rust shape by its context:
 *   - `struct` + object literal → a nested `structLit` (recursing into fields);
 *   - `hashmap` + object literal → a `HashMap::from([…])`;
 *   - `vec` + array literal → an array whose elements lower against the elem type
 *     (so a `Array<Point>` of object literals becomes `vec![Point { … }, …]`).
 * Anything else lowers as a plain expression.
 */
function lowerTyped(
  expr: Expression,
  ty: RustType | null,
  analysis: ModuleAnalysis,
): HirExpr {
  // `const x: T = JSON.parse(s)` deserializes into the annotated target type
  // (series 045); without an annotation it falls to the `Value` form in lowerCall.
  if (ty && isJsonParseCall(expr)) {
    const src = (expr as CallExpression).arguments[0];
    if (src) {
      return { kind: "jsonParse", source: lowerExpr(src, analysis), target: ty };
    }
  }
  // Option coercion (series 042): a plain value flowing into an `Option<T>` slot
  // is `Some`-wrapped (recursing against the inner type); `undefined`/`null`
  // becomes `None`. Centralized here so `let`-init, struct fields, and array
  // elements all coerce uniformly.
  if (ty?.kind === "option") {
    return isNullishExpr(expr)
      ? { kind: "none" }
      : { kind: "some", value: lowerTyped(expr, ty.inner, analysis) };
  }
  if (ty?.kind === "struct" && expr.type === "ObjectExpression") {
    return lowerStructLiteral(expr as ObjectExpression, ty.name, analysis);
  }
  if (ty?.kind === "hashmap" && expr.type === "ObjectExpression") {
    const obj = expr as ObjectExpression;
    // An object spread `{ ...a, k: v }` builds a merged map (series 044); a plain
    // record literal stays a direct `IndexMap::from`.
    if (
      obj.properties.some(
        (p) => (p as { type: string }).type === "SpreadElement",
      )
    ) {
      return { kind: "mapBuild", base: null, parts: mapBuildParts(obj, analysis) };
    }
    return lowerHashMapLiteral(obj, analysis);
  }
  if (ty?.kind === "vec" && expr.type === "ArrayExpression") {
    return {
      kind: "array",
      elements: (expr as ArrayExpression).elements.map((e) =>
        lowerTyped(e, ty.elem, analysis),
      ),
    };
  }
  return lowerExpr(expr, analysis);
}

/**
 * Collect each declared struct's field types (interfaces + non-error classes,
 * including parameter properties) — a lenient pre-pass for series 032. Malformed
 * members are skipped here; the real lowering (`lowerInterface`/`lowerClass`)
 * still fails loud on them.
 */
/**
 * The Rust type of a struct/interface field, folding in optionality (series
 * 042b): an optional field (`x?: T`) is `Option<T>`; `x: T | undefined` already
 * lowers to `option` via the union. Shared by `lowerInterface` and
 * `collectStructFields` so the emitted struct and the coercion table agree.
 */
function fieldRustType(
  annotation: TSType,
  optional: boolean,
  structs: Set<string>,
): RustType {
  const base = lowerType(annotation, structs);
  return optional && base.kind !== "option"
    ? { kind: "option", inner: base }
    : base;
}

function collectStructFields(
  program: Program,
  structs: Set<string>,
): Map<string, { name: string; ty: RustType }[]> {
  const map = new Map<string, { name: string; ty: RustType }[]>();
  for (const stmt of program.body) {
    if (stmt.type === "TSInterfaceDeclaration") {
      const decl = stmt as TSInterfaceDeclaration;
      if (decl.extends && decl.extends.length > 0) continue;
      const fields: { name: string; ty: RustType }[] = [];
      for (const m of decl.body.body) {
        if (
          m.type === "TSPropertySignature" &&
          !m.computed &&
          m.typeAnnotation
        ) {
          fields.push({
            name: m.key.name,
            ty: fieldRustType(
              m.typeAnnotation.typeAnnotation,
              m.optional === true,
              structs,
            ),
          });
        }
      }
      map.set(decl.id.name, fields);
    } else if (stmt.type === "ClassDeclaration" && !isErrorSubclass(stmt)) {
      const decl = stmt as ClassDeclaration;
      if (!decl.id) continue;
      const fields: { name: string; ty: RustType }[] = [];
      for (const m of decl.body.body) {
        if (
          m.type === "PropertyDefinition" &&
          !m.static &&
          !m.computed &&
          m.typeAnnotation
        ) {
          fields.push({
            name: m.key.name,
            ty: lowerType(m.typeAnnotation.typeAnnotation, structs),
          });
        }
      }
      const ctor = decl.body.body.find(
        (m): m is MethodDefinition =>
          m.type === "MethodDefinition" && m.kind === "constructor",
      );
      for (const p of (ctor?.value.params ?? []) as unknown as Param[]) {
        if (p.type === "TSParameterProperty" && p.parameter.typeAnnotation) {
          fields.push({
            name: p.parameter.name,
            ty: lowerType(p.parameter.typeAnnotation.typeAnnotation, structs),
          });
        }
      }
      map.set(decl.id.name, fields);
    }
  }
  return map;
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
    case "ParenthesizedExpression":
      // Source parens are structural only — the grouping is already encoded in
      // the tree. Unwrap; the emitter re-parenthesizes from precedence (026).
      return lowerExpr(
        (expr as unknown as { expression: Expression }).expression,
        analysis,
      );
    case "Literal":
      return lowerLiteral(expr as Literal);
    case "Identifier": {
      const name = (expr as Identifier).name;
      // `undefined` is an identifier in ESTree (not a literal); it is the absent
      // optional (series 042).
      if (name === "undefined") return { kind: "none" };
      return { kind: "ident", name };
    }
    case "ChainExpression":
      return lowerChain(
        (expr as unknown as { expression: Expression }).expression,
        analysis,
      );
    case "BinaryExpression": {
      const b = expr as {
        operator: string;
        left: Expression;
        right: Expression;
      };
      // Comparison against `undefined`/`null` (series 042c): `x === undefined` /
      // `x === null` → `x.is_none()`; `!==` → `x.is_some()`. The non-nullish side
      // is the `Option` receiver. (Valid TS only writes this when the operand is
      // optional.)
      if (b.operator === "===" || b.operator === "!==") {
        const leftNullish = isNullishExpr(b.left);
        const rightNullish = isNullishExpr(b.right);
        if (leftNullish !== rightNullish) {
          const opt = leftNullish ? b.right : b.left;
          return {
            kind: "method",
            receiver: lowerExpr(opt, analysis),
            name: b.operator === "===" ? "is_none" : "is_some",
            args: [],
          };
        }
      }
      return {
        kind: "binary",
        op: b.operator,
        left: lowerExpr(b.left, analysis),
        right: lowerExpr(b.right, analysis),
      };
    }
    case "LogicalExpression": {
      // `&&` / `||` map directly to Rust's short-circuit operators (a `binary`
      // HIR node; the emitter's `BINARY_PREC` parenthesizes them). `??` (nullish
      // coalescing) needs `Option` semantics the dialect doesn't model (a bare
      // `null` is already fail-loud) — so it stays fail-loud, never guessed.
      const l = expr as unknown as {
        operator: string;
        left: Expression;
        right: Expression;
      };
      // `x ?? d` → `x.unwrap_or(d)` (series 042, graduates #7): the left is an
      // `Option`, the right the fallback of the inner type.
      if (l.operator === "??") {
        return {
          kind: "method",
          receiver: lowerExpr(l.left, analysis),
          name: "unwrap_or",
          args: [lowerExpr(l.right, analysis)],
        };
      }
      if (l.operator !== "&&" && l.operator !== "||") {
        throw new UnsupportedError({
          type: `logical operator '${l.operator}'`,
        });
      }
      return {
        kind: "binary",
        op: l.operator,
        left: lowerExpr(l.left, analysis),
        right: lowerExpr(l.right, analysis),
      };
    }
    case "UnaryExpression": {
      const u = expr as unknown as { operator: string; argument: Expression };
      // `-x` (negation) and `!x` (logical not) map directly. `+x`, `~x`,
      // `typeof`/`void`/`delete` have no clean typed target — fail loud.
      if (u.operator !== "-" && u.operator !== "!") {
        throw new UnsupportedError({ type: `unary operator '${u.operator}'` });
      }
      return {
        kind: "unary",
        op: u.operator,
        operand: lowerExpr(u.argument, analysis),
      };
    }
    case "AssignmentExpression": {
      const a = expr as {
        operator: string;
        left: Expression;
        right: Expression;
      };
      // A `=` write to a *string-keyed* computed member is a HashMap insert, not
      // an index-assign — Rust's `Index` on `HashMap` is read-only (series 031,
      // gap E). A numeric index is a `Vec` write and stays an index-assign.
      const insert = tryHashMapInsert(a, analysis);
      if (insert) return insert;
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

/**
 * Lower an optional-chain expression (series 042d). Only the single-level
 * optional member `a?.b` (`a.map(|v| v.b)`) is supported; a deeper chain
 * (`a?.b?.c`, `a?.[i]`, `a?.()`) stays fail-loud.
 */
function lowerChain(inner: Expression, analysis: ModuleAnalysis): HirExpr {
  if (inner.type === "MemberExpression") {
    const m = inner as MemberExpression;
    if (
      (m as { optional?: boolean }).optional &&
      !m.computed &&
      m.property.type === "Identifier" &&
      m.object.type !== "MemberExpression"
    ) {
      return {
        kind: "optMember",
        receiver: lowerExpr(m.object, analysis),
        field: (m.property as Identifier).name,
      };
    }
  }
  throw new UnsupportedError({
    type: "optional chaining beyond a single `a?.b` member (deeper chains are a later slice)",
  });
}

function lowerLiteral(lit: Literal): HirExpr {
  const v = lit.value;
  if (typeof v === "number") return { kind: "number", value: v };
  if (typeof v === "string") return { kind: "string", value: v };
  if (typeof v === "boolean") return { kind: "bool", value: v };
  // `null` is the absent optional → `None` (series 042).
  if (v === null) return { kind: "none" };
  throw new UnsupportedError({ type: `literal ${typeof v}` });
}

/**
 * Is this expression the JS `undefined` (an identifier) or `null` (a literal)?
 * Both are the absent optional (`None`) in the dialect's nullability model
 * (series 042).
 */
function isNullishExpr(expr: Expression): boolean {
  if (expr.type === "Identifier") return (expr as Identifier).name === "undefined";
  if (expr.type === "Literal") return (expr as Literal).value === null;
  return false;
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
    const params = sig?.params ?? [];
    // Iterate over params (not just supplied args) so an omitted trailing
    // optional param is filled with `None` (series 042).
    const arity = Math.max(call.arguments.length, params.length);
    const args: HirArg[] = [];
    for (let i = 0; i < arity; i++) {
      const param = params[i];
      const a = call.arguments[i];
      // An optional param is `Option<T>` and passed by value: a present arg is
      // `Some`-wrapped (`undefined`/`null` → `None`), an omitted one is `None`.
      if (param?.optional) {
        const expr: HirExpr = !a
          ? { kind: "none" }
          : isNullishExpr(a)
            ? { kind: "none" }
            : { kind: "some", value: lowerExpr(a, analysis) };
        args.push({ borrow: "owned", expr });
        continue;
      }
      if (!a) break; // a missing non-optional arg is a TS-invalid / cargo-loud arity error
      let borrow: Borrow = "owned";
      if (param && !param.isCopy) {
        if (param.ownership === "ref") borrow = "ref";
        else if (param.ownership === "refMut") borrow = "refMut";
      }
      args.push({ borrow, expr: lowerExpr(a, analysis) });
    }
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
    const methodName = (m.property as Identifier).name;
    // `Object.keys(m)` / `Object.values(m)` are static calls on the global
    // `Object` (series 041), not a method on a value — handle before the
    // value-method routing. `Object.<anything else>` is fail-loud.
    if (
      m.object.type === "Identifier" &&
      (m.object as Identifier).name === "Object"
    ) {
      return lowerObjectStatic(methodName, call, analysis);
    }
    // `JSON.stringify(v)` / `JSON.parse(s)` — static calls on the global `JSON`
    // (series 045). `parse` here has no type context → the untyped `Value`
    // fallback; a `const x: T = JSON.parse(s)` gets its `T` in `lowerTyped`.
    if (
      m.object.type === "Identifier" &&
      (m.object as Identifier).name === "JSON"
    ) {
      const arg = call.arguments[0];
      if (methodName === "stringify" && arg) {
        return { kind: "jsonStringify", value: lowerExpr(arg, analysis) };
      }
      if (methodName === "parse" && arg) {
        return {
          kind: "jsonParse",
          source: lowerExpr(arg, analysis),
          target: null,
        };
      }
      throw new UnsupportedError({ type: `JSON.${methodName}` });
    }
    // A user-declared class method of this name is a native call — never hijack
    // it with the library-method routing below (map/filter/at/pad*, 027/033).
    const isUserMethod = analysis.methodNames.has(methodName);
    // Value-position closures over arrays (027-cl): `xs.map/filter(arrow)` →
    // iterator chains. `forEach` is a statement (see `tryForEach`).
    if (
      !isUserMethod &&
      (methodName === "map" || methodName === "filter") &&
      call.arguments.length === 1 &&
      call.arguments[0]?.type === "ArrowFunctionExpression"
    ) {
      const cl = arrowExprClosure(
        call.arguments[0] as ArrowFunctionExpression,
        analysis,
      );
      const receiver = lowerExpr(m.object, analysis);
      return methodName === "map"
        ? { kind: "iterMap", receiver, param: cl.param, body: cl.body }
        : { kind: "iterFilter", receiver, param: cl.param, body: cl.body };
    }
    // `some`/`every` → native `.iter().any()`/`.all()` (039); same single-param
    // predicate-closure shape as `filter`, but yielding a `bool`.
    if (
      !isUserMethod &&
      (methodName === "some" || methodName === "every") &&
      call.arguments.length === 1 &&
      call.arguments[0]?.type === "ArrowFunctionExpression"
    ) {
      const cl = arrowExprClosure(
        call.arguments[0] as ArrowFunctionExpression,
        analysis,
      );
      const receiver = lowerExpr(m.object, analysis);
      return methodName === "some"
        ? { kind: "iterAny", receiver, param: cl.param, body: cl.body }
        : { kind: "iterAll", receiver, param: cl.param, body: cl.body };
    }
    // `find` → native `.iter().find(|&&x| p).copied()` → `Option<T>` (042d).
    if (
      !isUserMethod &&
      methodName === "find" &&
      call.arguments.length === 1 &&
      call.arguments[0]?.type === "ArrowFunctionExpression"
    ) {
      const cl = arrowExprClosure(
        call.arguments[0] as ArrowFunctionExpression,
        analysis,
      );
      return {
        kind: "iterFind",
        receiver: lowerExpr(m.object, analysis),
        param: cl.param,
        body: cl.body,
      };
    }
    // `reduce((acc, x) => e, init)` → native `.iter().fold(init, |acc, &x| e)`
    // (039). The two-param closure seeds `acc` from the required `init` arg; a
    // no-init `reduce` is `Option`-typed (fail-loud, a later slice).
    if (
      !isUserMethod &&
      methodName === "reduce" &&
      call.arguments[0]?.type === "ArrowFunctionExpression"
    ) {
      if (call.arguments.length !== 2 || !call.arguments[1]) {
        throw new UnsupportedError({
          type: "reduce without an explicit initial value (Option-typed, a later slice)",
        });
      }
      const cl = arrowClosureN(
        call.arguments[0] as ArrowFunctionExpression,
        analysis,
        2,
      );
      const receiver = lowerExpr(m.object, analysis);
      const init = lowerExpr(call.arguments[1], analysis);
      return {
        kind: "iterReduce",
        receiver,
        acc: cl.params[0] as string,
        elem: cl.params[1] as string,
        body: cl.body,
        init,
      };
    }
    // `sort` → `tslib` (040): default (0 args) is a lexicographic string compare;
    // a comparator arrow uses the two-param closure shape. A non-arrow `sort`
    // argument is fail-loud (there is no faithful native form).
    if (!isUserMethod && methodName === "sort") {
      if (call.arguments.length === 0) {
        return {
          kind: "iterSortDefault",
          receiver: lowerExpr(m.object, analysis),
        };
      }
      if (
        call.arguments.length === 1 &&
        call.arguments[0]?.type === "ArrowFunctionExpression"
      ) {
        const cl = arrowClosureN(
          call.arguments[0] as ArrowFunctionExpression,
          analysis,
          2,
        );
        return {
          kind: "iterSortBy",
          receiver: lowerExpr(m.object, analysis),
          a: cl.params[0] as string,
          b: cl.params[1] as string,
          body: cl.body,
        };
      }
      throw new UnsupportedError({
        type: "sort with a non-arrow comparator (pass `(a, b) => …` or no argument)",
      });
    }
    // Quirk-heavy library methods route to the `tslib` fidelity crate (027);
    // clean-mapping methods fall through to the native `method` call below.
    const routed = isUserMethod
      ? null
      : tryTslibMethod(methodName, m, call, analysis);
    if (routed) return routed;
    const methodExpr: HirExpr = {
      kind: "method",
      receiver: lowerExpr(m.object, analysis),
      name: methodName,
      args: call.arguments.map((a) => lowerExpr(a, analysis)),
    };
    // A call to a fallible method propagates its error with `?`; the fallibility
    // fixpoint guarantees the enclosing scope is itself `Result`.
    return analysis.fallibleMethods.has(methodName)
      ? { kind: "try", expr: methodExpr }
      : methodExpr;
  }

  throw new UnsupportedError(call);
}

/**
 * Extract an `arity`-param, expression-bodied arrow closure's param names and
 * lowered body (series 033/039). The body is the arrow's expression, or a block
 * of exactly one `return <expr>`. A wrong param count, `async`, destructured
 * params, and multi-statement bodies are all fail-loud (later slices).
 */
function arrowClosureN(
  arrow: ArrowFunctionExpression,
  analysis: ModuleAnalysis,
  arity: number,
): { params: string[]; body: HirExpr } {
  if (arrow.async) {
    throw new UnsupportedError({ type: "async arrow closure" });
  }
  if (arrow.params.length !== arity) {
    throw new UnsupportedError({
      type: `closure must take exactly ${arity} parameter(s)`,
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
  return { params: params as string[], body: lowerExpr(bodyExpr, analysis) };
}

/**
 * The single-param specialization used by `map`/`filter`/`some`/`every`/`find`
 * (series 027-cl). Delegates to `arrowClosureN` with arity 1.
 */
function arrowExprClosure(
  arrow: ArrowFunctionExpression,
  analysis: ModuleAnalysis,
): { param: string; body: HirExpr } {
  const { params, body } = arrowClosureN(arrow, analysis, 1);
  return { param: params[0] as string, body };
}

/**
 * `xs.forEach(p => body)` → `for &p in xs.iter() { body }` (series 027-cl) — a
 * statement, so it is recognized here (before generic expression lowering) rather
 * than in `lowerCall`. The `&p` pattern copies each Copy element out of the
 * `.iter()` borrow. Returns null when `stmt` is not a `forEach` call.
 */
function tryForEach(
  expr: Expression,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt[] | null {
  if (expr.type !== "CallExpression") return null;
  const call = expr as CallExpression;
  if (call.callee.type !== "MemberExpression") return null;
  const m = call.callee as MemberExpression;
  if (m.property.type !== "Identifier") return null;
  if ((m.property as Identifier).name !== "forEach") return null;
  // A user-declared `forEach` method is a native call, not the array HOF.
  if (analysis.methodNames.has("forEach")) return null;
  if (
    call.arguments.length !== 1 ||
    call.arguments[0]?.type !== "ArrowFunctionExpression"
  ) {
    return null;
  }
  const arrow = call.arguments[0] as ArrowFunctionExpression;
  if (arrow.async)
    throw new UnsupportedError({ type: "async forEach closure" });
  if (arrow.params.length !== 1) {
    throw new UnsupportedError({
      type: "forEach closure must take exactly one parameter",
    });
  }
  const param = arrow.params[0]?.name;
  if (!param) throw new UnsupportedError({ type: "closure parameter binding" });
  const body: HirStmt[] = arrow.expression
    ? [{ kind: "expr", expr: lowerExpr(arrow.body as Expression, analysis) }]
    : lowerStatements((arrow.body as BlockStatement).body, analysis, scope);
  const iter: HirExpr = {
    kind: "method",
    receiver: lowerExpr(m.object, analysis),
    name: "iter",
    args: [],
  };
  return [{ kind: "forIn", pat: `&${param}`, iter, body }];
}

/**
 * Route a *quirk-heavy* library method to the `tslib` fidelity crate (series
 * 027), or return null to leave it as a native `method` call. The emitter's
 * hybrid rule: emit native idiomatic Rust where a JS method maps cleanly, and
 * confine JS-quirk semantics (negative `at`, `padStart`/`padEnd`) to `tslib`.
 * Numeric args are passed as owned `f64` — `tslib` floors them, so the runtime
 * coercion lives in the audited crate, not a codegen `as usize` cast.
 */
function tryTslibMethod(
  methodName: string,
  m: MemberExpression,
  call: CallExpression,
  analysis: ModuleAnalysis,
): HirExpr | null {
  const recvRef = (): HirArg => ({
    borrow: "ref",
    expr: lowerExpr(m.object, analysis),
  });
  const args = call.arguments;
  // `xs.at(i)` → `tslib::array::at(&xs, i)` (JS negative-from-end indexing).
  if (methodName === "at" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::array::at",
      args: [
        recvRef(),
        { borrow: "owned", expr: lowerExpr(args[0], analysis) },
      ],
    };
  }
  // `xs.slice(start[, end])` → `tslib::array::slice{,_from}(&xs, …)` (040): JS's
  // clamped, negative-aware, end-exclusive shallow copy. Numeric args are owned
  // `f64` (floored in `tslib`, the `at` precedent).
  if (methodName === "slice" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::array::slice_from",
      args: [
        recvRef(),
        { borrow: "owned", expr: lowerExpr(args[0], analysis) },
      ],
    };
  }
  if (methodName === "slice" && args.length === 2 && args[0] && args[1]) {
    return {
      kind: "call",
      callee: "tslib::array::slice",
      args: [
        recvRef(),
        { borrow: "owned", expr: lowerExpr(args[0], analysis) },
        { borrow: "owned", expr: lowerExpr(args[1], analysis) },
      ],
    };
  }
  // `s.padStart(n, pad)` / `s.padEnd(n, pad)` → `tslib::string::pad_{start,end}`.
  if (
    (methodName === "padStart" || methodName === "padEnd") &&
    args.length === 2 &&
    args[0] &&
    args[1]
  ) {
    const fn = methodName === "padStart" ? "pad_start" : "pad_end";
    return {
      kind: "call",
      callee: `tslib::string::${fn}`,
      args: [
        recvRef(),
        { borrow: "owned", expr: lowerExpr(args[0], analysis) },
        { borrow: "ref", expr: lowerExpr(args[1], analysis) },
      ],
    };
  }
  return null;
}

/**
 * Lower a static call on the global `Object` (series 041). `keys`/`values` map
 * to a native iteration of the `IndexMap`-backed record (insertion order matches
 * JS); everything else — `entries` (needs pair-array access) and `assign` (merge
 * + variadic sources) included — is fail-loud, a tracked residual.
 */
/** Is `e` a call to `JSON.parse(...)` (series 045)? */
function isJsonParseCall(e: Expression): boolean {
  if (e.type !== "CallExpression") return false;
  const callee = (e as CallExpression).callee;
  if (callee.type !== "MemberExpression") return false;
  const m = callee as MemberExpression;
  return (
    m.object.type === "Identifier" &&
    (m.object as Identifier).name === "JSON" &&
    m.property.type === "Identifier" &&
    (m.property as Identifier).name === "parse"
  );
}

/** Is `e` a call to `Object.entries(...)` (series 043)? */
function isObjectEntriesCall(e: Expression): boolean {
  if (e.type !== "CallExpression") return false;
  const callee = (e as CallExpression).callee;
  if (callee.type !== "MemberExpression") return false;
  const m = callee as MemberExpression;
  return (
    m.object.type === "Identifier" &&
    (m.object as Identifier).name === "Object" &&
    m.property.type === "Identifier" &&
    (m.property as Identifier).name === "entries"
  );
}

function lowerObjectStatic(
  methodName: string,
  call: CallExpression,
  analysis: ModuleAnalysis,
): HirExpr {
  if (
    (methodName === "keys" ||
      methodName === "values" ||
      methodName === "entries") &&
    call.arguments.length === 1 &&
    call.arguments[0]
  ) {
    const map = lowerExpr(call.arguments[0], analysis);
    if (methodName === "keys") return { kind: "objectKeys", map };
    if (methodName === "values") return { kind: "objectValues", map };
    return { kind: "objectEntries", map };
  }
  // `Object.assign(target, ...sources)` → a merged-map builder (series 044).
  if (methodName === "assign" && call.arguments.length >= 1 && call.arguments[0]) {
    const [target, ...sources] = call.arguments;
    const parts: MapBuildPart[] = [];
    let base: HirExpr | null;
    if ((target as Expression).type === "ObjectExpression") {
      base = null;
      parts.push(...mapBuildParts(target as ObjectExpression, analysis));
    } else {
      base = lowerExpr(target as Expression, analysis);
    }
    for (const s of sources) {
      parts.push({ kind: "spread", expr: lowerExpr(s, analysis) });
    }
    return { kind: "mapBuild", base, parts };
  }
  throw new UnsupportedError({
    type: `Object.${methodName} (only keys/values/entries/assign are supported)`,
  });
}

/**
 * Turn an object literal's properties into `mapBuild` parts (series 044): a
 * `...spread` becomes a `spread` part, a `key: value` a `entry` part. Computed
 * keys are fail-loud.
 */
function mapBuildParts(
  obj: ObjectExpression,
  analysis: ModuleAnalysis,
): MapBuildPart[] {
  return obj.properties.map((raw): MapBuildPart => {
    const p = raw as unknown as {
      type: string;
      argument?: Expression;
      computed?: boolean;
      key?: Expression;
      value?: Expression;
    };
    if (p.type === "SpreadElement" && p.argument) {
      return { kind: "spread", expr: lowerExpr(p.argument, analysis) };
    }
    if (p.type === "Property" && !p.computed && p.key && p.value) {
      return {
        kind: "entry",
        key: lowerKey(p.key as Parameters<typeof lowerKey>[0]),
        value: lowerExpr(p.value, analysis),
      };
    }
    throw new UnsupportedError({
      type: "unsupported object-spread property (computed key)",
    });
  });
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
  const callExpr: HirExpr = { kind: "call", callee: `${className}::new`, args };
  // A `new` of a class with a fallible constructor propagates with `?`.
  return analysis.fallibleCtors.has(className)
    ? { kind: "try", expr: callExpr }
    : callExpr;
}

function lowerMember(
  member: MemberExpression,
  analysis: ModuleAnalysis,
): HirExpr {
  if (member.computed) {
    // Pair index on an `Object.entries` element — `es[i][0]` / `es[i][1]` →
    // tuple field `.0` / `.1` (series 043). The base must be `<entriesBinding>[i]`
    // and the index the literal `0` or `1`.
    const prop = member.property;
    const base = member.object;
    if (
      (prop.type === "Literal" &&
        ((prop as Literal).value === 0 || (prop as Literal).value === 1)) &&
      base.type === "MemberExpression" &&
      (base as MemberExpression).computed &&
      (base as MemberExpression).object.type === "Identifier" &&
      analysis.entriesBindings.has(
        ((base as MemberExpression).object as Identifier).name,
      )
    ) {
      return {
        kind: "tupleField",
        tuple: lowerExpr(base, analysis),
        index: (prop as Literal).value as 0 | 1,
      };
    }
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
    // `E.Variant` (member of a declared enum) → the Rust path `E::Variant`.
    if (
      member.object.type === "Identifier" &&
      analysis.enums.has((member.object as Identifier).name)
    ) {
      return {
        kind: "path",
        segments: [(member.object as Identifier).name, prop],
      };
    }
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
    case "TSNullKeyword":
    case "TSUndefinedKeyword":
      // A bare `null`/`undefined` type (not in a `T | null` union) has no `T` to
      // make `Option` over — fail-loud (series 042).
      throw new UnsupportedError(ty);
    case "TSUnionType": {
      // `T | undefined` / `T | null` / `T | null | undefined` → `Option<T>`
      // (series 042). A union of two *real* types is enum territory — fail-loud.
      const u = ty as unknown as { types: TSType[] };
      const real = u.types.filter(
        (m) => m.type !== "TSUndefinedKeyword" && m.type !== "TSNullKeyword",
      );
      const hasNullish = real.length !== u.types.length;
      if (hasNullish && real.length === 1 && real[0]) {
        return { kind: "option", inner: lowerType(real[0], structs) };
      }
      throw new UnsupportedError(ty);
    }
    default:
      throw new UnsupportedError(ty);
  }
}
