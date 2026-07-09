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
import { isTypePartialEq } from "./derives";
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
  HirCatchArm,
  HirClass,
  HirEnum,
  HirErrorEnum,
  HirExpr,
  HirFn,
  HirItem,
  HirMatchArm,
  HirModule,
  HirParam,
  HirStmt,
  HirStruct,
  HirTrait,
  MapBuildPart,
  RustType,
  SelfRecv,
} from "./hir";
import { refineNumerics } from "./numeric";
import { refineOwnership } from "./ownership";
import { refineTaskEscape } from "./task-escape";
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
 * The program-wide error type: the synthesized `AppError` enum when any custom
 * error class is declared (series 049), else `String`. Uniform across every
 * fallible function so `?` composes.
 */
function programErrType(analysis: ModuleAnalysis): RustType {
  return analysis.errorClasses.size > 0 ? { kind: "appError" } : ERR_STRING;
}

/**
 * Synthesize the one whole-program `AppError` enum (series 049) from the declared
 * custom error classes (each a struct variant, `message: String` first, then its
 * declared typed fields) plus a fixed `Other { message: String }` catch-all.
 * Returns `null` when no custom error class is declared (`E` stays `String`, no
 * enum emitted — the 022-no-custom compat path). `#[error("{message}")]` is
 * option (A): Display shows only the message, mirroring JS `String(err)`.
 */
function synthesizeErrorEnum(analysis: ModuleAnalysis): HirErrorEnum | null {
  if (analysis.errorClasses.size === 0) return null;
  const variants = [...analysis.errorClasses.values()].map((c) => ({
    name: c.name,
    fields: [
      { name: "message", ty: ERR_STRING },
      ...c.fields.map((f) => ({ name: f.name, ty: f.ty })),
    ],
    display: "{message}",
  }));
  variants.push({
    name: "Other",
    fields: [{ name: "message", ty: ERR_STRING }],
    display: "{message}",
  });
  return { kind: "errorEnum", variants };
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
  // Binding → type map (series 048): every `const`/`let`/`var` and function param
  // resolved to a `RustType`, so callback lifting can type a forwarded free var
  // and a receiver's element type. Needs `lowerType`, so it runs here, not in
  // `analyzeModule`.
  analysis.bindingTypes = collectBindingTypes(normalized, analysis.structs);
  // Error-class shapes (series 049b): validate each `class X extends Error` and
  // collect its ordered typed fields into `analysis.errorClasses`, *before* any
  // function body is lowered — a `throw new X(…)` inside a body constructs the
  // `AppError::X` variant and needs the field order. Needs `lowerType`, so it
  // runs here (like `structFields`), not in `analyzeModule`.
  for (const stmt of normalized.body) {
    if (stmt.type === "ClassDeclaration" && isErrorSubclass(stmt)) {
      const shape = lowerErrorClass(stmt as ClassDeclaration, analysis.structs);
      analysis.errorClasses.set(shape.name, shape);
    }
  }
  const items: HirItem[] = [];
  const script: Statement[] = [];

  // The one synthesized `AppError` enum (series 049) leads the items when any
  // custom error class is declared; nothing when none is (E stays String).
  const errorEnum = synthesizeErrorEnum(analysis);
  if (errorEnum) items.push(errorEnum);

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
      // A `class X extends Error` is a custom error type — its shape was
      // collected into the synthesized enum above, so nothing is emitted per
      // class here. A plain data class becomes a `struct` + `impl`.
      if (!isErrorSubclass(stmt)) {
        items.push(lowerClass(stmt as ClassDeclaration, analysis));
      }
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

  // Callback lifting (series 048) collected the synthesized `__cb_*` fns during
  // lowering (of both the item bodies above and the script `main`); append them
  // as top-level items now, *before* the refine chain, so the passes below type
  // and refine them like any other fn.
  items.push(...analysis.liftedFns);

  // Class inheritance (series 053b/c): synthesize the shared `trait IA` for each
  // extended base and rewire each participating class's `impl IA` (overrides +
  // forwarders + on-demand accessors). Runs after all bodies are lowered so
  // `analysis.dynFieldReads` (populated by polymorphic field reads) is complete.
  items.push(...synthesizeTraits(items, analysis));

  // Final gate steps: refine `number` → `usize` where indexing demands it, then
  // read-only `string` params (`&String`) → the idiomatic `&str`, then the
  // ownership-model directives — `"use rc"` scopes → `Rc<RefCell<T>>` (028b) and
  // `"use arena"` scopes → `bumpalo` bump allocation (028c) — and *finally*
  // use-after-move → `.clone()`. Ownership runs **last** so it sees the HIR after
  // the directives have imposed their own ownership model: an `rc` alias is already
  // `Rc::clone` (not a bare move) and an arena `Vec` is already un-annotated, so the
  // clone pass leaves both alone and only fills the remaining plain-move gaps (037).
  // The task-escape pass (series 051c increment 2) runs **before**
  // `refineOwnership`: it rewrites shared spawn-arg captures to `Arc::clone`
  // handles and the parent's later uses to `.lock().unwrap()`, so by the time the
  // clone-inserting ownership pass runs, those sites are `arcClone`/`lockAccess`
  // nodes (not bare movable idents) and it leaves them alone — no spurious
  // `.clone()`. It runs *after* lowering has baked each callee param's `refMut`
  // ownership signal into its `HirParam.ty` (the `Arc` vs `Arc<Mutex>` input), and
  // after the numeric/string/rc/arena refinements so the wrapped inner types are
  // final.
  return refineOwnership(
    refineTaskEscape(
      refineArena(
        refineRc(
          refineStrings(refineNumerics({ items, main, mainRet, mainAsync })),
          { rcScopes: analysis.rcScopes, classes: analysis.classes },
        ),
        analysis.arenaScopes,
      ),
    ),
  );
}

// ── Arrow normalization ──────────────────────────────────────────────────────

/**
 * Rewrite each top-level `const f = (…) => …` (a single-declarator `const` bound
 * to an arrow, `async` or not) into a synthetic `FunctionDeclaration`, leaving
 * every other statement untouched. Run before analysis so a normalized arrow's
 * parameter ownership and call-site borrows are inferred, and calls to it adapt
 * their arguments, exactly as for a `function`. An `async` arrow normalizes to an
 * `async` fn (series 054b). A non-normalized arrow (`let`/`var`-bound,
 * value-position, nested) stays an expression and is rejected downstream in
 * `lowerExpr` — the documented deferral boundary.
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

/** A qualifying top-level `const <id> = <arrow>` (async or not), else null. */
function topLevelConstArrow(
  stmt: Statement,
): { name: Identifier; arrow: ArrowFunctionExpression } | null {
  if (stmt.type !== "VariableDeclaration") return null;
  const decl = stmt as VariableDeclaration;
  if (decl.kind !== "const" || decl.declarations.length !== 1) return null;
  const d = decl.declarations[0];
  if (!d || d.init?.type !== "ArrowFunctionExpression") return null;
  const arrow = d.init as ArrowFunctionExpression;
  // An `async` top-level const arrow normalizes to an `async` fn (series 054b):
  // `arrowToFunctionDecl` carries `async` over, so it flows through the async
  // free-fn path (`asyncFns` → `async fn` → awaitable) with no further work.
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
  // Class inheritance (series 053b, INH10): a base-typed param is monomorphic —
  // `impl IA` (static dispatch, zero-cost). Rewrites the param type and records
  // it as a `dyn` binding so a `.method()` dispatches through the trait and a
  // `.field` read routes through an accessor.
  applyBaseParamTraits(params, analysis);
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
 * Lower a `throw` to a `throw` HIR stmt (emitted as `return Err(<value>);`).
 * Three shapes map: `throw new <CustomClass>(message, …fields)` → the matching
 * `AppError::<Class>` struct variant (message first, then declared fields);
 * `throw new <BuiltinError>(message)` → `AppError::Other { message }` (the
 * built-in class distinction is erased); and a bare string literal `throw "msg"`
 * → `AppError::Other { message }`. Under the no-custom-class `String` error type
 * the message is carried bare (022 compat). A thrown variable/expression, an
 * unknown class, or any other value is fail-loud.
 */
function lowerThrow(
  stmt: ThrowStatement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt {
  const arg = stmt.argument;
  const hasAppError = analysis.errorClasses.size > 0;
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
    const custom = analysis.errorClasses.get(cname);
    if (!custom && !ERROR_CLASSES.has(cname)) {
      throw new UnsupportedError({
        type: "throw of an unknown error class (declare it as `class X extends Error`)",
      });
    }
    const [message] = nw.arguments;
    if (!message) {
      throw new UnsupportedError({
        type: "throw new <Error>() must have at least a message argument",
      });
    }
    const msg = lowerExpr(message, analysis);
    if (panic) return { kind: "throw", value: msg, panic: true };
    if (custom) {
      // `throw new Foo(msg, a, b)` → `AppError::Foo { message: msg, f: a, g: b }`
      // (message first, then declared fields 1:1 with the remaining args).
      const rest = nw.arguments.slice(1);
      if (rest.length !== custom.fields.length) {
        throw new UnsupportedError({
          type: `throw new ${cname}() takes a message plus ${custom.fields.length} field argument(s)`,
        });
      }
      const fields = [
        { name: "message", value: msg },
        ...custom.fields.map((f, i) => ({
          name: f.name,
          value: lowerExpr(rest[i] as Expression, analysis),
        })),
      ];
      return {
        kind: "throw",
        value: { kind: "enumVariant", enumName: "AppError", variant: cname, fields },
      };
    }
    // A built-in `Error` throw → `AppError::Other { message }`, or the bare
    // `String` message under the no-custom-class program error type (022 compat).
    if (nw.arguments.length !== 1) {
      throw new UnsupportedError({
        type: "throw new Error() must have exactly one message argument",
      });
    }
    return { kind: "throw", value: otherOrMessage(msg, hasAppError) };
  }
  // `throw "literal"` — a bare string literal is thrown as its own message.
  if (arg.type === "Literal" && typeof (arg as Literal).value === "string") {
    const msg = lowerExpr(arg, analysis);
    if (panic) return { kind: "throw", value: msg, panic: true };
    return { kind: "throw", value: otherOrMessage(msg, hasAppError) };
  }
  throw new UnsupportedError({
    type: "throw of a non-Error, non-string-literal value",
  });
}

/**
 * A built-in `Error`/string throw's payload: under an `AppError` program error
 * type it constructs the catch-all `AppError::Other { message }` directly (no
 * `.into()` round-trip); under the `String` error type (no custom class) the
 * message is carried bare (022-no-custom compat).
 */
function otherOrMessage(msg: HirExpr, hasAppError: boolean): HirExpr {
  return hasAppError
    ? {
        kind: "enumVariant",
        enumName: "AppError",
        variant: "Other",
        fields: [{ name: "message", value: msg }],
      }
    : msg;
}

/**
 * Lower a `class X extends Error { field: T; …; constructor(message: string,
 * field: T, …) { super(message); this.field = field; … } }` to its `AppError`
 * variant shape `{ name, fields }` (series 049b). The recognized shape:
 *   - members are declared **data fields** (`field: T`) plus exactly one ctor;
 *     any method/getter/setter is fail-loud (ERR10);
 *   - the ctor's first param is the message; the remaining params map 1:1 to the
 *     declared fields, in declaration order;
 *   - the ctor body is `super(message);` followed by **identity** assignments
 *     `this.f = f;` (one per field, RHS the bare matching param ident) — a
 *     computed/reordered/defaulted/extra statement is fail-loud (ERR11).
 * `message` itself is implicit (always the variant's first field); the returned
 * `fields` are the *extra* declared data fields.
 */
function lowerErrorClass(
  decl: ClassDeclaration,
  structs: Set<string>,
): { name: string; fields: { name: string; ty: RustType }[] } {
  const name = decl.id?.name;
  if (!name) throw new UnsupportedError({ type: "anonymous error class" });
  const members = decl.body.body;

  // Declared data fields (`field: T`), in declaration order → variant fields.
  const props = members.filter(
    (m): m is PropertyDefinition => m.type === "PropertyDefinition",
  );
  const fields = props.map((f) => {
    if (f.static || f.computed) {
      throw new UnsupportedError({ type: "static/computed error-class field" });
    }
    if (!f.typeAnnotation) {
      throw new UnsupportedError({
        type: `error-class field '${f.key.name}' without a type`,
      });
    }
    return {
      name: f.key.name,
      ty: lowerType(f.typeAnnotation.typeAnnotation, structs),
    };
  });

  // Anything that is neither a data field nor the constructor is fail-loud
  // (methods, getters/setters — only typed data + the fixed ctor map).
  const extras = members.filter(
    (m) =>
      m.type !== "PropertyDefinition" &&
      !(m.type === "MethodDefinition" && m.kind === "constructor"),
  );
  if (extras.length > 0) {
    throw new UnsupportedError({
      type: "custom error class with a method/getter (only typed data fields are supported)",
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
  // First param is the message; the rest map 1:1 (in order) to the fields.
  if (ctor.params.length !== fields.length + 1) {
    throw new UnsupportedError({
      type: "custom error class constructor params must be (message, …fields) 1:1",
    });
  }
  const paramNames = (ctor.params as unknown as Identifier[]).map((p) => p.name);
  fields.forEach((f, i) => {
    if (paramNames[i + 1] !== f.name) {
      throw new UnsupportedError({
        type: `error-class constructor param '${paramNames[i + 1]}' must match field '${f.name}' (reordering unsupported)`,
      });
    }
  });

  // Body: `super(message);` then one identity `this.f = f;` per field, in order.
  const body = ctor.body?.body ?? [];
  if (body.length !== fields.length + 1) {
    throw new UnsupportedError({
      type: "error-class constructor body must be `super(message);` then one `this.f = f;` per field",
    });
  }
  const first = body[0];
  const isSuperCall =
    first?.type === "ExpressionStatement" &&
    (first as ExpressionStatement).expression.type === "CallExpression" &&
    ((first as ExpressionStatement).expression as CallExpression).callee.type ===
      "Super";
  if (!isSuperCall) {
    throw new UnsupportedError({
      type: "error-class constructor body must start with `super(message)`",
    });
  }
  fields.forEach((f, i) => {
    const stmt = body[i + 1];
    if (!isIdentityFieldAssign(stmt, f.name)) {
      throw new UnsupportedError({
        type: `error-class constructor must assign \`this.${f.name} = ${f.name};\` (computed/defaulted/reordered init unsupported)`,
      });
    }
  });

  return { name, fields };
}

/** Is `stmt` exactly `this.<field> = <field>;` (an identity assign of `field`)? */
function isIdentityFieldAssign(
  stmt: Statement | undefined,
  field: string,
): boolean {
  if (!stmt || stmt.type !== "ExpressionStatement") return false;
  const e = (stmt as ExpressionStatement).expression;
  if (e.type !== "AssignmentExpression") return false;
  const a = e as AssignmentExpression;
  if (a.operator !== "=") return false;
  const left = a.left;
  if (
    left.type !== "MemberExpression" ||
    (left as MemberExpression).computed ||
    (left as MemberExpression).object.type !== "ThisExpression" ||
    (left as MemberExpression).property.type !== "Identifier" ||
    ((left as MemberExpression).property as Identifier).name !== field
  ) {
    return false;
  }
  // RHS must be the bare matching param identifier — no `.trim()`, no default.
  return a.right.type === "Identifier" && (a.right as Identifier).name === field;
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
  const catchParam = stmt.handler.param ? stmt.handler.param.name : null;
  // Series 049c: recognize an `instanceof` ladder catch body → a native `match`
  // over the owned bound error (no `downcast_ref`). Non-ladder catches keep the
  // opaque bind. The `escapesClosure` gate above already rejected a per-branch
  // `return` (the #16 boundary), so a recognized ladder is statement-level only.
  const discriminant =
    catchParam && analysis.errorClasses.size > 0
      ? recognizeDiscriminant(stmt.handler.body.body, catchParam, analysis, scope)
      : undefined;
  return {
    kind: "tryCatch",
    tryBody: makeFallible(rawTry, UNIT),
    catchParam,
    catchBody,
    finallyBody,
    errTy: programErrType(analysis),
    discriminant,
  };
}

/**
 * Recognize a discriminating `instanceof` ladder catch body (series 049c) and
 * lower it to `match` arms over the owned bound error. The body must be a single
 * `if`/`else if`/…/`else` chain whose every non-final test is `<catchParam>
 * instanceof <CustomClass>` (a *declared* error class). Returns the arms, or
 * `undefined` when the body is not that shape (the opaque bind is kept — ERR16).
 *   - each `instanceof Foo` branch → `AppError::Foo { <read fields>, .. }`, with
 *     `e.field` reads rewritten to the owned bound `field`;
 *   - a trailing `else` → the wildcard `other => …` (binds the whole error);
 *   - no trailing `else` → an appended `_ => {}` (exhaustiveness; JS swallows
 *     non-matching errors, ERR15).
 * An `instanceof` on a *built-in* error class is fail-loud (no variant to match).
 */
function recognizeDiscriminant(
  body: Statement[],
  catchParam: string,
  analysis: ModuleAnalysis,
  scope: string,
): HirCatchArm[] | undefined {
  if (body.length !== 1 || body[0]?.type !== "IfStatement") return undefined;
  const arms: HirCatchArm[] = [];
  let node: Statement | null = body[0] as IfStatement;
  while (node && node.type === "IfStatement") {
    const iff = node as IfStatement;
    const cls = instanceofTest(iff.test, catchParam);
    if (cls === null) return undefined; // not an `e instanceof X` test → opaque
    if (!analysis.errorClasses.has(cls)) {
      if (ERROR_CLASSES.has(cls)) {
        throw new UnsupportedError({
          type: `\`instanceof ${cls}\` in a catch — built-in error throws collapse into Other (no variant to match)`,
        });
      }
      return undefined; // an unknown class — not a recognized ladder
    }
    // Fields of `cls` read as `e.field` in this branch bind owned; rewrite the
    // reads to the bound `field` ident before lowering the branch body.
    const read = collectFieldReads(iff.consequent, catchParam, analysis, cls);
    const conseq = rewriteFieldReads(iff.consequent, catchParam, read);
    arms.push({
      kind: "variant",
      variant: cls,
      binds: read,
      body: lowerBlock(conseq, analysis, scope),
    });
    node = iff.alternate;
  }
  // A trailing `else { … }` → the `other` wildcard (binds the whole error);
  // no `else` → an appended `_ => {}` for exhaustiveness (JS swallow parity).
  if (node) {
    arms.push({
      kind: "wildcard",
      binder: "other",
      body: lowerBlock(node, analysis, scope),
    });
  } else {
    arms.push({ kind: "wildcard", binder: null, body: [] });
  }
  return arms;
}

/** `<catchParam> instanceof <Class>` → the class name, else `null`. */
function instanceofTest(test: Expression, catchParam: string): string | null {
  if (test.type !== "BinaryExpression") return null;
  const b = test as { operator: string; left: Expression; right: Expression };
  if (b.operator !== "instanceof") return null;
  if (b.left.type !== "Identifier" || (b.left as Identifier).name !== catchParam) {
    return null;
  }
  if (b.right.type !== "Identifier") return null;
  return (b.right as Identifier).name;
}

/**
 * Collect the declared field names of `cls` that the branch reads as
 * `<catchParam>.<field>` (so the match arm binds each owned). `message` is a
 * valid field too. Order follows the variant's field order for stable output.
 */
function collectFieldReads(
  branch: Statement,
  catchParam: string,
  analysis: ModuleAnalysis,
  cls: string,
): string[] {
  const shape = analysis.errorClasses.get(cls);
  const candidates = ["message", ...(shape?.fields.map((f) => f.name) ?? [])];
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isAstNode(node)) return;
    if (node.type === "MemberExpression") {
      const m = node as unknown as MemberExpression;
      if (
        !m.computed &&
        m.object.type === "Identifier" &&
        (m.object as Identifier).name === catchParam &&
        m.property.type === "Identifier"
      ) {
        found.add((m.property as Identifier).name);
      }
    }
    for (const key in node) {
      if (key === "type") continue;
      walk((node as Record<string, unknown>)[key]);
    }
  };
  walk(branch);
  return candidates.filter((c) => found.has(c));
}

/**
 * Rewrite each `<catchParam>.<field>` member access (for a field in `binds`) to a
 * bare `<field>` identifier, so a lowered branch reads the match-arm-bound owned
 * field. A structural clone — the source AST is untouched.
 */
function rewriteFieldReads<T>(node: T, catchParam: string, binds: string[]): T {
  if (Array.isArray(node)) {
    return node.map((n) => rewriteFieldReads(n, catchParam, binds)) as unknown as T;
  }
  if (!isAstNode(node)) return node;
  const n = node as unknown as MemberExpression;
  if (
    n.type === "MemberExpression" &&
    !n.computed &&
    n.object.type === "Identifier" &&
    (n.object as Identifier).name === catchParam &&
    n.property.type === "Identifier" &&
    binds.includes((n.property as Identifier).name)
  ) {
    return {
      type: "Identifier",
      name: (n.property as Identifier).name,
      start: n.start,
      end: n.end,
    } as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const key in node as Record<string, unknown>) {
    out[key] = rewriteFieldReads(
      (node as Record<string, unknown>)[key],
      catchParam,
      binds,
    );
  }
  return out as T;
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
  // `implements` / multiple inheritance stays fail-loud (INH16) — single-`extends`
  // composition only.
  if (decl.implements && decl.implements.length > 0) {
    throw new UnsupportedError({
      type: "class inheritance (implements / interface conformance)",
    });
  }
  const name = decl.id.name;
  const structs = analysis.structs;
  // Class inheritance (series 053). A subclass `class B extends A` gains a
  // synthetic `base: A` embed (prepended so `super(...)` reads first, like Rust
  // field-init order). `A` must be a declared class (not `Error` — those are
  // error subclasses handled elsewhere, and never reach here).
  const baseName =
    decl.superClass && decl.superClass.type === "Identifier"
      ? (decl.superClass as Identifier).name
      : analysis.superclass.get(name);
  if (decl.superClass && decl.superClass.type !== "Identifier") {
    throw new UnsupportedError({ type: "class extends a non-identifier base" });
  }
  if (baseName && !analysis.classes.has(baseName)) {
    throw new UnsupportedError({
      type: `class extends '${baseName}' which is not a declared class`,
    });
  }
  const base = baseName
    ? { field: "base" as const, ty: { kind: "struct" as const, name: baseName } }
    : undefined;

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

  // Class inheritance (series 053): the synthetic `base: A` embed is *prepended*
  // to the field list, so the struct literal, the struct definition, and the
  // derive walk all see it first (Rust field-init order, and `super(...)` runs
  // before own-field init).
  if (base) fields.unshift({ name: base.field, ty: base.ty });

  let ctor: HirFn | null = null;
  let dispose: HirStmt[] | null = null;
  const methods: HirFn[] = [];
  // Class inheritance (series 053a): mark the class under lowering so a
  // `this.<field>` read can be classified own-vs-inherited (`.base` hop).
  const prevClass = analysis.currentClass;
  analysis.currentClass = name;
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
      ctor = lowerConstructor(member.value, name, fields, analysis, baseName);
    } else if (member.kind === "method") {
      methods.push(lowerMethod(member, name, analysis));
    } else {
      throw new UnsupportedError({ type: `class ${member.kind} accessor` });
    }
  }
  analysis.currentClass = prevClass;
  if (!ctor) {
    throw new UnsupportedError({
      type: "class without an explicit constructor",
    });
  }
  // Throwing / `?`-propagation inside methods and constructors is supported
  // (series 023): the fallibility fixpoint types the method/ctor as `Result` and
  // `?`-propagates fallible method/`new` calls.
  //
  // Class inheritance (series 053b): a class that participates in an `extends`
  // relationship — either a subclass (`baseName` set) or a base that is itself
  // extended (in `analysis.baseClasses`) — implements the shared trait `I<Root>`
  // (named after the root base). `overrides` names the trait methods this class
  // provides itself; the rest fall through to the trait default (via a
  // forwarder synthesized in the emitter for a subclass, or the default itself
  // for the base). Accessors (053c) are attached later in `lower()` once the
  // module's `dynFieldReads` are known.
  const inChain = !!baseName || analysis.baseClasses.has(name);
  if (!inChain) {
    return { kind: "class", name, fields, ctor, methods, dispose };
  }
  const root = rootBaseOf(name, analysis);
  const implTrait = traitNameOf(root);
  const overrides = analysis.overrides.get(name) ?? new Set<string>();
  return {
    kind: "class",
    name,
    fields,
    ctor,
    methods,
    dispose,
    base,
    implTrait,
    overrides,
  };
}

/** The trait name synthesized for a base class `A` — `IA` (design §Trait). */
function traitNameOf(baseName: string): string {
  return `I${baseName}`;
}

/**
 * Rewrite base-typed params to `impl IA` (series 053b, INH10) and record each as
 * a `dyn` binding, so a `.method()` in the body dispatches through the trait and
 * a base-`.field` read routes through an accessor. A param whose (possibly
 * borrowed) type names an extended base class is monomorphic static dispatch.
 */
function applyBaseParamTraits(
  params: HirParam[],
  analysis: ModuleAnalysis,
): void {
  for (const p of params) {
    const inner = p.ty.kind === "ref" ? p.ty.inner : p.ty;
    if (inner.kind === "struct" && analysis.baseClasses.has(inner.name)) {
      const base = inner.name;
      p.ty = { kind: "implTrait", trait: traitNameOf(base) };
      analysis.dynBindings.set(p.name, base);
    }
  }
}

/**
 * Class inheritance trait synthesis (series 053b/c). For each extended base
 * (a root of an `extends` chain), build the shared `trait IA` from the base's
 * public methods (as default bodies) plus on-demand accessors for base fields
 * read through a `dyn IA` (`analysis.dynFieldReads`). Rewire each participating
 * `HirClass`'s `impl IA`:
 *   - the trait-owning **base** moves its methods into the trait defaults and
 *     keeps an empty `impl IA for Base {}` (uses every default);
 *   - a **subclass** provides its overrides directly and a *forwarder*
 *     `fn m(&self){ self.base.m() }` for every non-overridden trait method, plus
 *     an accessor `fn x(&self) -> &T { &self.base.x }` for each polymorphic
 *     field read.
 * Returns the synthesized `HirTrait` items.
 */
function synthesizeTraits(
  items: HirItem[],
  analysis: ModuleAnalysis,
): HirTrait[] {
  const classByName = new Map<string, HirClass>();
  for (const it of items) {
    if (it.kind === "class") classByName.set(it.name, it);
  }
  const traits: HirTrait[] = [];
  for (const root of analysis.baseClasses) {
    const base = classByName.get(root);
    if (!base) continue;
    const traitName = traitNameOf(root);
    // Trait surface: the base's own public methods (their bodies become the
    // trait defaults). Subclasses may override these; never add new methods.
    const traitMethods = base.methods;
    const traitMethodNames = new Set(traitMethods.map((m) => m.name));
    // Accessors: base fields read through a `dyn IA`. Each maps to the projection
    // reaching the field on that class (`self.x` on the base, `self.base.x` on a
    // subclass). The trait carries only the signature.
    const dynFields = [...(analysis.dynFieldReads.get(root) ?? [])];
    const accessorSigs = dynFields
      .map((field) => {
        const f = base.fields.find((bf) => bf.name === field);
        return f ? { field, ty: f.ty } : null;
      })
      .filter((a): a is { field: string; ty: RustType } => a !== null);
    traits.push({
      kind: "trait",
      name: traitName,
      methods: traitMethods,
      accessors: accessorSigs,
    });

    // Rewire every class in this chain (the base + its transitive subclasses).
    for (const c of classByName.values()) {
      if (rootBaseOf(c.name, analysis) !== root) continue;
      const isBase = c.name === root;
      const overrides = new Set<string>();
      if (isBase) {
        // The base supplies the real bodies for every trait method — mark them
        // all as `overrides` so they land in `impl IA for Base` (not the inherent
        // impl). The trait itself declares only signatures.
        for (const m of c.methods) overrides.add(m.name);
        c.overrides = overrides;
      } else {
        // A subclass: its own methods that match a trait method are overrides.
        const forwarders: HirFn[] = [];
        for (const m of c.methods) {
          if (traitMethodNames.has(m.name)) overrides.add(m.name);
        }
        // Forward every non-overridden trait method to the embedded base.
        for (const tm of traitMethods) {
          if (overrides.has(tm.name)) continue;
          overrides.add(tm.name);
          forwarders.push(makeForwarder(tm));
        }
        c.methods = [...c.methods, ...forwarders];
        c.overrides = overrides;
      }
      // Accessors: the projection to the field on *this* class. On the base it
      // is `self.x`; on a subclass it hops through `.base` to the owner.
      if (accessorSigs.length > 0) {
        c.accessors = accessorSigs.map(({ field, ty }) => ({
          field,
          ty,
          proj: accessorProjection(c.name, field, analysis),
        }));
      }
    }
  }
  return traits;
}

/** A forwarder trait method `fn m(&self, …) -> R { self.base.m(…) }` (053b). */
function makeForwarder(tm: HirFn): HirFn {
  return {
    kind: "fn",
    name: tm.name,
    isAsync: tm.isAsync,
    params: tm.params,
    ret: tm.ret,
    recv: tm.recv ?? "ref",
    body: [
      {
        kind: "return",
        value: {
          kind: "method",
          receiver: {
            kind: "field",
            object: { kind: "ident", name: "self" },
            name: "base",
          },
          name: tm.name,
          args: tm.params.map((p) => ({ kind: "ident", name: p.name })),
        },
      },
    ],
  };
}

/**
 * Is a base-typed array literal *heterogeneous* (series 053c)? True when it
 * holds a `new C(...)` whose class `C` is a *subclass* of the base (a class name
 * ≠ the base). A literal of only base instances stays a homogeneous `Vec<A>`.
 */
function isHeterogeneous(
  arr: ArrayExpression,
  base: string,
  analysis: ModuleAnalysis,
): boolean {
  return arr.elements.some((e) => {
    if (!e || e.type !== "NewExpression") return false;
    const callee = (e as NewExpression).callee;
    if (callee.type !== "Identifier") return false;
    const name = (callee as Identifier).name;
    return name !== base && analysis.classes.has(name);
  });
}

/** The `&self` projection reaching `field` on `cls` — `self.x` or `self.base.x` … */
function accessorProjection(
  cls: string,
  field: string,
  analysis: ModuleAnalysis,
): HirExpr {
  const hops = baseHopsToField(cls, field, analysis);
  let obj: HirExpr = { kind: "ident", name: "self" };
  for (let i = 0; i < hops; i++) {
    obj = { kind: "field", object: obj, name: "base" };
  }
  return { kind: "field", object: obj, name: field };
}

/** The root (top-most) base of a class in its `extends` chain (itself if none). */
function rootBaseOf(name: string, analysis: ModuleAnalysis): string {
  let cur = name;
  let up = analysis.superclass.get(cur);
  while (up && analysis.classes.has(up)) {
    cur = up;
    up = analysis.superclass.get(cur);
  }
  return cur;
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
  baseName?: string,
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
  let sawSuper = false;
  for (const stmt of fn.body.body) {
    // Class inheritance (series 053a): `super(args)` in a subclass constructor
    // initializes the synthetic `base: A` embed via `A::new(args)`.
    const superCall = constructorSuperCall(stmt, analysis);
    if (superCall) {
      if (!baseName) {
        throw new UnsupportedError({
          type: "`super(...)` in a class with no base (extends) clause",
        });
      }
      sawSuper = true;
      assigned.set("base", {
        kind: "call",
        callee: `${baseName}::new`,
        args: superCall.map((expr) => ({ borrow: "owned", expr })),
      });
      continue;
    }
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
  // A subclass constructor with no `super(...)` would leave `base` uninitialized
  // — struct-literal totality (INH6). Fail loud.
  if (baseName && !sawSuper) {
    throw new UnsupportedError({
      type: "subclass constructor without a `super(...)` call (base field uninitialized)",
    });
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

/**
 * A constructor statement `super(args);` — the lowered argument expressions, or
 * null if the statement is not a bare `super(...)` call (series 053a).
 */
function constructorSuperCall(
  stmt: Statement,
  analysis: ModuleAnalysis,
): HirExpr[] | null {
  if (stmt.type !== "ExpressionStatement") return null;
  const e = (stmt as ExpressionStatement).expression;
  if (e.type !== "CallExpression") return null;
  const call = e as CallExpression;
  if (call.callee.type !== "Super") return null;
  return call.arguments.map((a) => lowerExpr(a as Expression, analysis));
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
  // async methods (series 054a): `analysis.asyncMethods` records the method name
  // so `await obj.m(...)` recognizes it (see `lowerAwait`). `isAsync: fn.async`
  // flows to the emitter (`async fn m(&self, …)`); a throwing async method
  // composes via the `fallibleMethods` branch below (`async fn … -> Result`),
  // exactly like a free async fn. A bare un-awaited async method call stays
  // fail-loud in `lowerCall` (un-polled future → spawn is 051c).
  const structs = analysis.structs;
  const params = fn.params.map((p) => lowerParam(p, undefined, structs));
  // Class inheritance (series 053b, INH10): a base-typed method param → `impl IA`.
  applyBaseParamTraits(params, analysis);
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

function isAstNode(x: unknown): x is { type: string; [k: string]: unknown } {
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
  // Class inheritance (series 053c): iterating a `Vec<Box<dyn IA>>` binds each
  // element as a `&Box<dyn IA>` — record the loop binding as a `dyn` binding so
  // a `.field` read inside routes through a trait accessor and `.m()` dispatches
  // virtually. Set before lowering the body.
  if (
    stmt.right.type === "Identifier" &&
    analysis.dynBindings.has((stmt.right as Identifier).name)
  ) {
    const base = analysis.dynBindings.get(
      (stmt.right as Identifier).name,
    ) as string;
    analysis.dynBindings.set(decl.id.name, base);
  }
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

/**
 * The struct `RustType` of a comparison operand when it is a struct-typed binding
 * (series 047c) — resolved from `analysis.bindingTypes` (the 046/048 binding→type
 * pre-pass). Used only to upgrade a non-`PartialEq` struct `===` to a clean
 * `UnsupportedError`; a non-ident or non-struct operand returns null (default path).
 */
function structTypeOfOperand(
  e: Expression,
  analysis: ModuleAnalysis,
): Extract<RustType, { kind: "struct" }> | null {
  if (e.type === "Identifier") {
    const t = analysis.bindingTypes.get((e as Identifier).name);
    // Only a genuine *data struct* (present in `structFields`) is checkable — an
    // enum is also registered as a `struct` RustType but has no field table, and
    // enums derive `PartialEq`, so `enumVal === E.Variant` must take the default
    // path, never the non-PartialEq fail-loud upgrade.
    if (t && t.kind === "struct" && analysis.structFields.has(t.name)) return t;
  }
  return null;
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

/**
 * Is `e` an `await Promise.allSettled(...)` (series 051b)? Its result type is
 * `Vec<Result<T, String>>`, which no dialect TS annotation expresses (the
 * dialect has no `PromiseSettledResult`); Rust infers it, so the binding is
 * allowed un-annotated (like a `join!` tuple destructure).
 */
function isAllSettledAwait(e: Expression): boolean {
  if (e.type !== "AwaitExpression") return false;
  const arg = (e as AwaitExpression).argument;
  if (arg.type !== "CallExpression") return false;
  const callee = (arg as CallExpression).callee;
  if (callee.type !== "MemberExpression") return false;
  const m = callee as MemberExpression;
  return (
    m.object.type === "Identifier" &&
    (m.object as Identifier).name === "Promise" &&
    m.property.type === "Identifier" &&
    (m.property as Identifier).name === "allSettled"
  );
}

/**
 * Is `e` an un-awaited async **free** call `doWork()` — the initializer of a
 * `JoinHandle<T>` binding (series 051c increment 1, `const h = doWork()`)? Its
 * result type is a `JoinHandle<T>`, which no dialect TS annotation expresses (the
 * dialect has no `JoinHandle`); Rust infers it, so the binding is allowed
 * un-annotated (like a `join!` tuple destructure or an `allSettled` await).
 */
function isSpawnInit(e: Expression, analysis: ModuleAnalysis): boolean {
  return (
    e.type === "CallExpression" &&
    (e as CallExpression).callee.type === "Identifier" &&
    analysis.asyncFns.has(((e as CallExpression).callee as Identifier).name)
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
    // Tuple-destructuring a fixed-arity `Promise.all` (series 051a): a
    // `const [a, b] = await Promise.all([…])` binds the `join!`/`try_join!` tuple
    // as `let (a, b) = …`. Only this combinator initializer is a valid array
    // pattern in a plain binding — a general array destructure stays fail-loud.
    if ((d.id as { type: string }).type === "ArrayPattern") {
      const init = lowerExpr(d.init, analysis);
      if (!isJoinTuple(init)) {
        throw new UnsupportedError({ type: "destructuring binding" });
      }
      const pat = d.id as unknown as {
        elements?: ({ type: string; name?: string } | null)[];
      };
      const names = (pat.elements ?? []).map((el) => {
        if (!el || el.type !== "Identifier" || !el.name) {
          throw new UnsupportedError({
            type: "Promise.all tuple destructure must bind plain identifiers",
          });
        }
        return el.name;
      });
      return {
        kind: "let",
        name: names[0] as string,
        mut: false,
        ty: null,
        init,
        names,
      };
    }
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
      !isArrayFindCall(d.init) &&
      !isAllSettledAwait(d.init) &&
      !isSpawnInit(d.init, analysis)
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
    // Track a `JoinHandle` binding (series 051c increment 1): a binding whose
    // lowered init is a `{kind:"spawn"}` node (an un-awaited async call) is a
    // `JoinHandle<T>`. A later `await h` on it lowers to `joinHandleAwait`
    // (`h.await.unwrap()`). Statements lower top-to-bottom, so this is recorded
    // before the `await`.
    if (init.kind === "spawn") analysis.joinHandleBindings.add(d.id.name);
    // Class inheritance (series 053c): a heterogeneous base-typed array binding
    // is `Vec<Box<dyn IA>>`. Rewrite its declared type and record it as a `dyn`
    // binding so a later `.field` read routes through a trait accessor and a
    // `for-of` element inherits the polymorphic type.
    let letTy = ty;
    if (
      ty?.kind === "vec" &&
      ty.elem.kind === "struct" &&
      analysis.baseClasses.has(ty.elem.name) &&
      d.init.type === "ArrayExpression" &&
      isHeterogeneous(d.init as ArrayExpression, ty.elem.name, analysis)
    ) {
      const base = ty.elem.name;
      letTy = {
        kind: "vec",
        elem: { kind: "box", inner: { kind: "dyn", trait: traitNameOf(base) } },
      };
      analysis.dynBindings.set(d.id.name, base);
    }
    return {
      kind: "let",
      name: d.id.name,
      mut: mutable?.has(d.id.name) ?? false,
      ty: letTy,
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
    // Class inheritance (series 053c): a base-typed array holding *different*
    // subtypes is heterogeneous → `Vec<Box<dyn IA>>`; each element is upcast
    // with `Box::new(...)`. Detected when the elem type is an extended base and
    // the literal's `new` elements name a subclass (a class ≠ the base).
    if (
      ty.elem.kind === "struct" &&
      analysis.baseClasses.has(ty.elem.name) &&
      isHeterogeneous(expr as ArrayExpression, ty.elem.name, analysis)
    ) {
      return {
        kind: "array",
        elements: (expr as ArrayExpression).elements.map((e) => ({
          kind: "boxNew",
          value: lowerExpr(e, analysis),
        })),
      };
    }
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
        // Fail-loud upgrade (series 047c): a struct operand whose type is not
        // `PartialEq`-eligible (e.g. an `fnPtr` field) can't compare structurally.
        // Raise a clean dialect signal here instead of the opaque cargo `E0369`.
        for (const side of [b.left, b.right]) {
          const st = structTypeOfOperand(side, analysis);
          if (st && !isTypePartialEq(st, analysis.structFields)) {
            throw new UnsupportedError({
              type: `'===' on a struct '${st.name}' with a non-comparable (non-PartialEq) field`,
            });
          }
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
  // `await h` where `h` is a spawned-task handle (series 051c increment 1) →
  // `h.await.unwrap()`. A `JoinHandle`'s `.await` yields `Result<T, JoinError>`;
  // `.unwrap()` surfaces a task panic (a documented divergence). Checked before
  // the call-only guard below, since the awaited value here is a bare binding.
  if (
    arg.type === "Identifier" &&
    analysis.joinHandleBindings.has((arg as Identifier).name)
  ) {
    return {
      kind: "joinHandleAwait",
      expr: { kind: "ident", name: (arg as Identifier).name },
    };
  }
  if (arg.type !== "CallExpression") {
    throw new UnsupportedError({
      type: "await of a non-call expression (only `await asyncFn(...)`)",
    });
  }
  const call = arg as CallExpression;
  const callee = call.callee;

  // `await sleep(ms)` — the dialect's one modeled delay primitive (series 051b).
  // `sleep` is a recognized built-in (like `console.log`), NOT a user async fn;
  // its single `number` arg → `Duration::from_millis(ms as u64)`. Checked before
  // the generic async-fn Identifier handling below.
  if (
    callee.type === "Identifier" &&
    (callee as Identifier).name === "sleep" &&
    !analysis.asyncFns.has("sleep")
  ) {
    const msArg = call.arguments[0];
    if (!msArg || call.arguments.length !== 1) {
      throw new UnsupportedError({
        type: "sleep expects exactly one numeric argument",
      });
    }
    return {
      kind: "await",
      expr: { kind: "sleep", ms: lowerExpr(msArg, analysis) },
    };
  }

  // ── Async concurrency combinators (series 051a) ─────────────────────────────
  // All three 051a shapes appear under `await`; route them here before the plain
  // async-method / async-fn paths below.
  if (callee.type === "MemberExpression") {
    const combinator = lowerAwaitCombinator(call, callee as MemberExpression, analysis);
    if (combinator) return combinator;
  }

  // `await obj.m(...)` — an async method call (series 054a). The method must be
  // in `analysis.asyncMethods`; the receiver + args lower via `lowerCall`'s method
  // branch (with `awaited=true`, which returns the bare method expr). A fallible
  // async method `?`-propagates by wrapping the `await` in `try` → `.await?`.
  if (callee.type === "MemberExpression") {
    const prop = (callee as MemberExpression).property;
    const methodName = prop.type === "Identifier" ? (prop as Identifier).name : null;
    if (!methodName || !analysis.asyncMethods.has(methodName)) {
      throw new UnsupportedError({
        type: "await of a call to a non-async method",
      });
    }
    const awaited: HirExpr = {
      kind: "await",
      expr: lowerCall(call, analysis, true),
    };
    return analysis.fallibleMethods.has(methodName)
      ? { kind: "try", expr: awaited }
      : awaited;
  }
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

/**
 * Route the three series-051a async-concurrency combinators, each of which
 * appears under `await` with a `MemberExpression` callee:
 *
 *  - `recv.then(cb)` — a non-async single-expr `cb` → sequential `await` of the
 *    receiver then the lifted `__cb_then_<n>` (no extra `.await`; `cb` is sync).
 *  - `Promise.all([a(), b(), …])` — a fixed-arity array literal → `tokio::join!`
 *    (a tuple), or `tokio::try_join!(…)?` when any element is fallible.
 *  - `Promise.race([a(), b(), …])` — a fixed-arity array literal → `tokio::select!`
 *    (first to complete); all arms must unify to one output type.
 *
 * Returns `null` when the callee is neither `.then` nor a `Promise.all/race` (so
 * `lowerAwait` falls through to its async-method / async-fn handling).
 */
function lowerAwaitCombinator(
  call: CallExpression,
  callee: MemberExpression,
  analysis: ModuleAnalysis,
): HirExpr | null {
  const prop = callee.property;
  const propName = prop.type === "Identifier" ? (prop as Identifier).name : null;

  // `recv.then(cb)` — promise chaining.
  if (propName === "then" && !callee.computed) {
    // A two-arg `.then(onOk, onErr)` reject handler is `catch` territory (CONC9).
    if (call.arguments.length >= 2) {
      throw new UnsupportedError({
        type: "`.then` with a reject handler (two-arg) — catch territory",
      });
    }
    // The receiver must be a call to an async fn; lower it as an awaited receiver.
    const recv = callee.object;
    if (recv.type !== "CallExpression") {
      throw new UnsupportedError({
        type: "`.then` on a non-call receiver (only `asyncFn(...).then(cb)`)",
      });
    }
    const recvCall = recv as CallExpression;
    const recvCallee = recvCall.callee;
    if (
      recvCallee.type !== "Identifier" ||
      !analysis.asyncFns.has((recvCallee as Identifier).name)
    ) {
      throw new UnsupportedError({
        type: "`.then` receiver must be a call to an async function",
      });
    }
    const recvAwaited: HirExpr = {
      kind: "await",
      expr: lowerCall(recvCall, analysis, true),
    };
    // The callback: a non-async single-expression arrow taking exactly one param.
    const cb = call.arguments[0];
    if (!cb || cb.type !== "ArrowFunctionExpression") {
      throw new UnsupportedError({
        type: "`.then` callback must be an arrow function",
      });
    }
    // The resolved value type of the receiver (the `cb`'s single param type).
    const elemType = asyncCallItemType(recvCall, analysis);
    // `liftCallback` validates the arrow shape (rejects an async or multi-param
    // arrow) and pushes the `fn __cb_then_<n>` into `analysis.liftedFns`.
    const lifted = liftCallback(
      cb as ArrowFunctionExpression,
      analysis,
      "then",
      elemType,
      1,
    );
    return {
      kind: "call",
      callee: lifted.cbName,
      args: [
        { borrow: "owned", expr: recvAwaited },
        ...lifted.forwarded.map((f) => ({ borrow: "owned" as const, expr: f })),
      ],
    };
  }

  // `Promise.all([...])` / `Promise.race([...])` / `Promise.allSettled(...)`.
  const obj = callee.object;
  if (
    obj.type === "Identifier" &&
    (obj as Identifier).name === "Promise" &&
    (propName === "all" || propName === "race" || propName === "allSettled")
  ) {
    const arg0 = call.arguments[0];

    // ── Dynamic fan-out (series 051b) — `Promise.all(arr.map(f))` /
    // `Promise.allSettled(arr.map(f))`. The sole argument is `arr.map(f)`, a
    // CallExpression whose callee is a `.map` MemberExpression. `race` never
    // takes this form (its fan-out has no tuple/select! shape).
    if (
      (propName === "all" || propName === "allSettled") &&
      arg0 &&
      arg0.type === "CallExpression" &&
      (arg0 as CallExpression).callee.type === "MemberExpression" &&
      ((arg0 as CallExpression).callee as MemberExpression).property.type ===
        "Identifier" &&
      (((arg0 as CallExpression).callee as MemberExpression).property as Identifier)
        .name === "map"
    ) {
      return lowerDynamicFanOut(
        arg0 as CallExpression,
        propName as "all" | "allSettled",
        analysis,
      );
    }

    // `allSettled` accepts ONLY the `arr.map(f)` fan-out (051b); an array-literal
    // form is not modeled here — fall through to the fail-loud below.
    if (propName === "allSettled" || !arg0 || arg0.type !== "ArrayExpression") {
      throw new UnsupportedError({
        type: "Promise.all/allSettled argument must be an array literal or arr.map(f)",
      });
    }
    const elements = (arg0 as ArrayExpression).elements;
    const calls = elements.map((el) => {
      if (!el || el.type !== "CallExpression") {
        throw new UnsupportedError({
          type: "Promise.all/race element must be a call to an async function",
        });
      }
      return el as CallExpression;
    });
    const futures = calls.map((el) => lowerCall(el, analysis, true));

    if (propName === "all") {
      const anyFallible = calls.some(
        (el) =>
          el.callee.type === "Identifier" &&
          analysis.fallible.has((el.callee as Identifier).name),
      );
      return anyFallible
        ? { kind: "try", expr: { kind: "tryJoin", futures } }
        : { kind: "join", futures };
    }

    // `race` — every element's output type must unify to one `T` (select! arms).
    const itemTypes = calls.map((el) => asyncCallItemType(el, analysis));
    const first = JSON.stringify(itemTypes[0]);
    if (itemTypes.some((t) => JSON.stringify(t) !== first)) {
      throw new UnsupportedError({
        type: "heterogeneous Promise.race (select! arms must unify to one type)",
      });
    }
    return { kind: "select", futures };
  }

  return null;
}

/**
 * Lower a dynamic async fan-out (series 051b): `Promise.all(arr.map(f))` or
 * `Promise.allSettled(arr.map(f))`, where `arr` is a homogeneous array and `f`
 * is a `.map` callback in EITHER accepted form:
 *
 *   1. **inline** — `id => fetchRow(id)` (a non-async arrow whose body is a call
 *      to an async fn, i.e. it *returns* a future). Emits an inline closure
 *      `|id| fetch_row(id)`; Rust infers the future type — no lift, no typer.
 *   2. **lifted** — `async id => await fetchRow(id)` (an async arrow awaiting an
 *      async call). Lifts to `async fn __cb_map_<n>(id: T) -> R { return
 *      fetch_row(id).await; }`, emitting `.map(__cb_map_n)`.
 *
 * Both drive `arr.into_iter().map(<closure|cb>)` through `join_all`
 * (infallible / allSettled) or `try_join_all` (`?`-propagated, fallible `all`):
 *
 *   - `Promise.all` + infallible → `join_all(...).await` → `Vec<T>`.
 *   - `Promise.all` + fallible  → `try_join_all(...).await?` (short-circuit).
 *   - `Promise.allSettled`      → `join_all(...).await` → `Vec<Result<T, String>>`
 *     (each fallible element's output is already `Result<T, String>`; never
 *     short-circuits).
 */
function lowerDynamicFanOut(
  mapCall: CallExpression,
  propName: "all" | "allSettled",
  analysis: ModuleAnalysis,
): HirExpr {
  const mapCallee = mapCall.callee as MemberExpression;
  const arr = mapCallee.object as Expression;
  const f = mapCall.arguments[0];
  if (!f || f.type !== "ArrowFunctionExpression") {
    throw new UnsupportedError({
      type: "dynamic fan-out `arr.map(f)` callback must be an arrow function",
    });
  }
  const arrow = f as ArrowFunctionExpression;
  if (arrow.params.length !== 1) {
    throw new UnsupportedError({
      type: "dynamic fan-out callback must take exactly one parameter",
    });
  }
  const paramName = arrow.params[0]?.name;
  if (!paramName) {
    throw new UnsupportedError({
      type: "dynamic fan-out callback parameter binding",
    });
  }

  // Locate the inner async call and whether its callee is fallible.
  let innerCall: CallExpression;
  if (arrow.async) {
    // Lifted form: `async id => await fetchRow(id)` — body is an `await` of a call.
    const body = arrow.expression
      ? (arrow.body as Expression)
      : null;
    const awaitExpr =
      body?.type === "AwaitExpression" ? (body as AwaitExpression) : null;
    if (!awaitExpr || awaitExpr.argument.type !== "CallExpression") {
      throw new UnsupportedError({
        type: "lifted fan-out callback must be `async x => await asyncFn(x)`",
      });
    }
    innerCall = awaitExpr.argument as CallExpression;
  } else {
    // Inline form: `id => fetchRow(id)` — body is directly a call.
    const body = arrow.expression ? (arrow.body as Expression) : null;
    if (!body || body.type !== "CallExpression") {
      throw new UnsupportedError({
        type: "inline fan-out callback must be `x => asyncFn(x)`",
      });
    }
    innerCall = body as CallExpression;
  }
  const innerCallee = innerCall.callee;
  if (
    innerCallee.type !== "Identifier" ||
    !analysis.asyncFns.has((innerCallee as Identifier).name)
  ) {
    throw new UnsupportedError({
      type: "dynamic fan-out callback body must call an async function",
    });
  }
  const innerName = (innerCallee as Identifier).name;
  const itemType = asyncCallItemType(innerCall, analysis);
  const fallible = analysis.fallible.has(innerName);

  // The `.map` argument: an inline closure or a bare path to a lifted async fn.
  let mapArg: HirExpr;
  if (arrow.async) {
    // Lift to `async fn __cb_map_<n>(paramName: T_param) -> itemType`. The param
    // type is the map element type: prefer `arr`'s Vec element type, else fall
    // back to the arrow param annotation, else fail-loud.
    const paramType = fanOutParamType(arr, arrow, analysis);
    const cbName = `__cb_map_${++analysis.liftCounter}`;
    analysis.liftedFns.push({
      kind: "fn",
      name: cbName,
      isAsync: true,
      params: [{ name: paramName, ty: paramType }],
      ret: itemType,
      body: [
        {
          kind: "return",
          value: {
            kind: "await",
            expr: lowerCall(innerCall, analysis, true),
          },
        },
      ],
    });
    mapArg = { kind: "ident", name: cbName };
  } else {
    // Inline closure `|paramName| <bare async call>`.
    mapArg = {
      kind: "closure",
      params: [paramName],
      body: lowerCall(innerCall, analysis, true),
    };
  }

  // `arr.into_iter().map(<mapArg>)`.
  const iter: HirExpr = {
    kind: "method",
    receiver: {
      kind: "method",
      receiver: lowerExpr(arr, analysis),
      name: "into_iter",
      args: [],
    },
    name: "map",
    args: [mapArg],
  };

  if (propName === "allSettled") {
    // Each element's output is `Result<T, String>`; Rust infers `Vec<Result<…>>`.
    return { kind: "joinAll", iter };
  }
  // `Promise.all`: fallible → `try_join_all(...)?`; infallible → `join_all(...)`.
  return fallible
    ? { kind: "try", expr: { kind: "tryJoinAll", iter } }
    : { kind: "joinAll", iter };
}

/**
 * The map element type for a lifted async fan-out callback (series 051b): the
 * element type of `arr` (a known `Vec<E>` binding or an array literal), else the
 * arrow param's own type annotation, else fail-loud with a clear message.
 */
function fanOutParamType(
  arr: Expression,
  arrow: ArrowFunctionExpression,
  analysis: ModuleAnalysis,
): RustType {
  // Prefer the array's element type (`elementTypeOf` handles Vec bindings and
  // array literals). If it cannot resolve, fall back to the arrow param annotation.
  try {
    return elementTypeOf(arr, analysis);
  } catch {
    const param = arrow.params[0];
    const ann = param?.typeAnnotation?.typeAnnotation;
    if (ann) return lowerType(ann as TSType, analysis.structs);
    throw new UnsupportedError({
      type: "cannot resolve lifted fan-out callback parameter type (annotate the array or the callback parameter)",
    });
  }
}

/**
 * Does a lowered expression produce a `join!`/`try_join!` tuple (series 051a)?
 * A `Promise.all` lowers to `{kind:"join"}` (infallible) or `{kind:"try", expr:
 * {kind:"tryJoin"}}` (fallible → `?`-propagated). Only these bind as a Rust
 * tuple destructure `let (a, b) = …`.
 */
function isJoinTuple(expr: HirExpr): boolean {
  if (expr.kind === "join") return true;
  if (expr.kind === "try" && expr.expr.kind === "tryJoin") return true;
  return false;
}

/**
 * The resolved value type `T` of a call to an async fn returning `Promise<T>`,
 * read from the callee's stored return annotation (`FnInfo.retAnn`). Fail-loud
 * when the callee is not a known identifier, is unannotated, or its annotation
 * is not `Promise<T>` (series 051a).
 */
function asyncCallItemType(
  call: CallExpression,
  analysis: ModuleAnalysis,
): RustType {
  const callee = call.callee;
  if (callee.type !== "Identifier") throw new UnsupportedError(call);
  const info = analysis.fns.get((callee as Identifier).name);
  const ann = info?.retAnn ?? null;
  // `Promise<T>` is a `TSTypeReference` named "Promise" with one type argument.
  if (
    !ann ||
    ann.type !== "TSTypeReference" ||
    (ann as Extract<TSType, { type: "TSTypeReference" }>).typeName.name !== "Promise"
  ) {
    throw new UnsupportedError({
      type: "async combinator element callee must return `Promise<T>`",
    });
  }
  const inner = (ann as Extract<TSType, { type: "TSTypeReference" }>).typeArguments
    ?.params?.[0];
  if (!inner) throw new UnsupportedError(call);
  return lowerType(inner, analysis.structs);
}

/**
 * Conservatism guard for `tokio::spawn` (series 051c increment 1). The spawned
 * future is `Send + 'static`, so every argument is *moved* into the task. We
 * admit only args that are provably safe to move here: literals and `Copy`
 * locals (moving a `Copy` value leaves the original live). A bare identifier of
 * a **non-`Copy`** (owning) type, or of unknown type, is fail-loud — it is the
 * shared-capture / task-escape case increment 2 (`Arc`/`Arc<Mutex>`) handles.
 * We NEVER emit a `spawn` we can't prove satisfies `Send + 'static`.
 *
 * This is deliberately conservative (it rejects a non-`Copy` arg even when it
 * happens not to be reused) — always sound, per the fail-loud contract.
 */
function assertSpawnArgsSafe(call: CallExpression, analysis: ModuleAnalysis): void {
  for (const arg of call.arguments) {
    // A bare local. A provably-`Copy` local moves into the task leaving the
    // original live (increment 1). A non-`Copy` local of a *wrappable* shape (a
    // named struct, or a `String`/scalar) is deferred to the inter-procedural
    // task-escape pass (`refineTaskEscape`, increment 2): it either stays a plain
    // move (one spawn, never reused) or is wrapped in `Arc`/`Arc<Mutex>`. The
    // pass proves soundness or fails loud — so we admit it into the HIR here and
    // let that pass adjudicate. A local of *unknown* type stays fail-loud (the
    // pass cannot classify what it cannot type).
    if (arg.type === "Identifier") {
      const name = (arg as Identifier).name;
      const ty = analysis.bindingTypes.get(name);
      if (ty && isCopyRustType(ty)) continue;
      if (ty && isTaskWrappableType(ty)) continue;
      throw new UnsupportedError({
        type: "value captured by a spawned task has a shape the task-escape pass cannot wrap in Arc/Arc<Mutex> — not provably safe to spawn",
      });
    }
    // A literal (number/bool/string-literal) or other non-identifier arg carries
    // no shared aliasing — a string literal is a fresh `String`, a number is
    // `Copy`. These move into the task with nothing left behind.
    if (arg.type === "Literal") continue;
    // Anything else (a member access, a nested call, arithmetic, …) may capture
    // a shared local transitively — the task-escape pass cannot reduce it to a
    // single wrapped binding, so reject conservatively (fail-loud contract).
    throw new UnsupportedError({
      type: "value captured by a spawned task has a shape the task-escape pass cannot wrap in Arc/Arc<Mutex> — not provably safe to spawn",
    });
  }
}

/**
 * A shared capture the task-escape pass (`refineTaskEscape`, series 051c
 * increment 2) can wrap in `Arc<T>` / `Arc<Mutex<T>>`: a named `struct` (the
 * common shared-object shape), or a `String`/scalar whole value. A borrowed,
 * `Option`, collection, `Rc`, or trait-object type is *not* wrappable by the
 * increment-2 pass — those stay fail-loud at the spawn site.
 */
function isTaskWrappableType(ty: RustType): boolean {
  return (
    ty.kind === "struct" ||
    ty.kind === "String" ||
    ty.kind === "f64" ||
    ty.kind === "usize" ||
    ty.kind === "i64" ||
    ty.kind === "bool"
  );
}

/**
 * `setTimeout(fn, ms)` → `tokio::spawn(async move { sleep(ms).await; <fn>; })`
 * — a fire-and-forget delayed task (series 051c increment 1). The delayed body
 * is the existing `sleep` node (series 051b) awaited, followed by `fn`'s work:
 *   - an inline non-async arrow → its body inlined (a block body's statements,
 *     or an expression body as one expr statement);
 *   - a bare identifier naming a top-level fn → a call to it.
 * `ms` is any expression (typically a `number` literal). A captured non-Copy
 * local inside `fn` that is shared stays fail-loud (increment 2).
 */
function lowerSetTimeout(call: CallExpression, analysis: ModuleAnalysis): HirExpr {
  if (call.arguments.length !== 2) {
    throw new UnsupportedError({
      type: "setTimeout expects exactly (fn, ms)",
    });
  }
  const [fn, msArg] = call.arguments;
  if (!fn || !msArg) throw new UnsupportedError(call);

  // The awaited-sleep prelude of the delayed task.
  const sleepStmt: HirStmt = {
    kind: "expr",
    expr: { kind: "await", expr: { kind: "sleep", ms: lowerExpr(msArg, analysis) } },
  };

  let bodyStmts: HirStmt[];
  if (fn.type === "ArrowFunctionExpression" || fn.type === "FunctionExpression") {
    const arrow = fn as ArrowFunctionExpression;
    if (arrow.async) {
      throw new UnsupportedError({ type: "setTimeout with an async callback" });
    }
    if (arrow.params.length !== 0) {
      throw new UnsupportedError({
        type: "setTimeout callback takes no arguments",
      });
    }
    if (arrow.body.type === "BlockStatement") {
      bodyStmts = lowerStatements(
        (arrow.body as BlockStatement).body,
        analysis,
        SCRIPT_SCOPE,
      );
    } else {
      bodyStmts = [
        { kind: "expr", expr: lowerExpr(arrow.body as Expression, analysis) },
      ];
    }
  } else if (fn.type === "Identifier") {
    // A bare fn name → a call statement `named();`.
    bodyStmts = [
      {
        kind: "expr",
        expr: { kind: "call", callee: (fn as Identifier).name, args: [] },
      },
    ];
  } else {
    throw new UnsupportedError({
      type: "setTimeout callback must be an inline arrow or a bare fn name",
    });
  }

  return {
    kind: "spawn",
    expr: { kind: "asyncMove", stmts: [sleepStmt, ...bodyStmts] },
  };
}

function lowerCall(
  call: CallExpression,
  analysis: ModuleAnalysis,
  awaited = false,
): HirExpr {
  // `setTimeout(fn, ms)` — a fire-and-forget delayed task (series 051c
  // increment 1) → `tokio::spawn(async move { sleep(ms).await; <fn body>; })`.
  // `fn` is an inline non-async arrow (its body is inlined) or a bare
  // top-level fn name (called); `ms` a number. Handled before the generic call
  // paths so it is not treated as an ordinary user call.
  if (
    call.callee.type === "Identifier" &&
    (call.callee as Identifier).name === "setTimeout" &&
    !analysis.fns.has("setTimeout")
  ) {
    return lowerSetTimeout(call, analysis);
  }
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
        // An un-awaited async **free** call → `tokio::spawn(f(args))`, an
        // eagerly-scheduled task returning a `JoinHandle<T>` (series 051c
        // increment 1). Reverses the 014 fail-loud. Applies to a bare
        // fire-and-forget statement and to a `const h = doWork()` handle
        // binding (which `lowerVarDecl` records in `joinHandleBindings`).
        //
        // Conservatism: the spawned future is `Send + 'static`, so its args
        // are moved in. Increment 1 admits Copy args and a single owned
        // move-in; an arg that is a non-Copy local *used again after the
        // spawn* is the shared-capture case → fail-loud (increment 2 adds the
        // `Arc`/`Arc<Mutex>` task-escape pass). See `spawnArgsSafe`.
        assertSpawnArgsSafe(call, analysis);
        return { kind: "spawn", expr: callExpr };
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
    // Class inheritance (series 053a): `super.m(args)` in a subclass method →
    // `self.base.m(args)` (dispatch the base's method on the embedded base). The
    // base's method is a trait default carrying its real body, so this composes
    // with an override calling `super`.
    if (m.object.type === "Super") {
      return {
        kind: "method",
        receiver: { kind: "field", object: { kind: "ident", name: "self" }, name: "base" },
        name: methodName,
        args: call.arguments.map((a) => lowerExpr(a, analysis)),
      };
    }
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
    // An `async` method (series 054a) is only valid `await`ed — a bare call is an
    // un-polled future that never runs (un-awaited-call → spawn is 051c). When
    // awaited, return the bare method expr; `lowerAwait` adds `.await` and, for a
    // fallible async method, the `?` (so we do *not* `try`-wrap here — that would
    // put the `?` before the `.await`). Mirrors the free async-fn Identifier path.
    if (analysis.asyncMethods.has(methodName)) {
      if (!awaited) {
        throw new UnsupportedError({
          type: "call to an async method not directly awaited (an un-polled future never runs)",
        });
      }
      return {
        kind: "method",
        receiver: lowerExpr(m.object, analysis),
        name: methodName,
        args: call.arguments.map((a) => lowerExpr(a, analysis)),
      };
    }
    // Async callback in an adapter (series 054c): the lift machinery can produce
    // an `async fn __cb_*`, but driving the resulting `Vec<Future>` to values is
    // `Promise.all(arr.map(f))` → `join_all`, which lands in series 051b. Reject
    // an async callback here (before it is lifted) — the accepted half-wired seam.
    if (!isUserMethod && LIFT_ADAPTERS.has(methodName)) {
      const a0 = call.arguments[0];
      if (
        a0?.type === "ArrowFunctionExpression" &&
        (a0 as ArrowFunctionExpression).async
      ) {
        throw new UnsupportedError({
          type: `async callback in '.${methodName}' — dynamic async fan-out (Promise.all(arr.map(f)) → join_all) lands in series 051`,
        });
      }
    }
    // Value-position closures over arrays (series 048): `xs.map/filter(arrow)` →
    // an iterator chain whose callback body is *lifted* to a top-level `__cb_*`
    // fn + a forwarding shim. `forEach` is a statement kept as a for-loop (see
    // `tryForEach`) — it is deliberately *not* lifted (decision 2026-07-08).
    if (
      !isUserMethod &&
      (methodName === "map" || methodName === "filter") &&
      call.arguments.length === 1 &&
      call.arguments[0]?.type === "ArrowFunctionExpression"
    ) {
      const elemType = elementTypeOf(m.object, analysis);
      const lifted = liftCallback(
        call.arguments[0] as ArrowFunctionExpression,
        analysis,
        methodName,
        elemType,
        1,
      );
      const receiver = lowerExpr(m.object, analysis);
      const shared = {
        receiver,
        cbName: lifted.cbName,
        elemParam: lifted.paramNames[0] as string,
        forwarded: lifted.forwarded,
      };
      return methodName === "map"
        ? { kind: "iterMap", ...shared }
        : { kind: "iterFilter", ...shared };
    }
    // `some`/`every` → `.iter().any()`/`.all()` (series 048); same single-param
    // predicate shape as `filter`, its lifted `fn` returning `bool`.
    if (
      !isUserMethod &&
      (methodName === "some" || methodName === "every") &&
      call.arguments.length === 1 &&
      call.arguments[0]?.type === "ArrowFunctionExpression"
    ) {
      const elemType = elementTypeOf(m.object, analysis);
      const lifted = liftCallback(
        call.arguments[0] as ArrowFunctionExpression,
        analysis,
        methodName,
        elemType,
        1,
      );
      const receiver = lowerExpr(m.object, analysis);
      const shared = {
        receiver,
        cbName: lifted.cbName,
        elemParam: lifted.paramNames[0] as string,
        forwarded: lifted.forwarded,
      };
      return methodName === "some"
        ? { kind: "iterAny", ...shared }
        : { kind: "iterAll", ...shared };
    }
    // `find` → `.iter().find(|x| cb(**x)).copied()` → `Option<T>` (series 048).
    if (
      !isUserMethod &&
      methodName === "find" &&
      call.arguments.length === 1 &&
      call.arguments[0]?.type === "ArrowFunctionExpression"
    ) {
      const elemType = elementTypeOf(m.object, analysis);
      const lifted = liftCallback(
        call.arguments[0] as ArrowFunctionExpression,
        analysis,
        "find",
        elemType,
        1,
      );
      return {
        kind: "iterFind",
        receiver: lowerExpr(m.object, analysis),
        cbName: lifted.cbName,
        elemParam: lifted.paramNames[0] as string,
        forwarded: lifted.forwarded,
      };
    }
    // `reduce((acc, x) => e, init)` → `.iter().fold(init, |acc, x| cb(acc, *x))`
    // (series 048). The two-param callback is lifted; `acc`'s param type is the
    // `init` type. A no-init `reduce` is `Option`-typed (fail-loud, a later slice).
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
      const elemType = elementTypeOf(m.object, analysis);
      const accType = initType(call.arguments[1], analysis);
      const lifted = liftCallback(
        call.arguments[0] as ArrowFunctionExpression,
        analysis,
        "reduce",
        elemType,
        2,
        accType,
      );
      const receiver = lowerExpr(m.object, analysis);
      const init = lowerExpr(call.arguments[1], analysis);
      return {
        kind: "iterReduce",
        receiver,
        cbName: lifted.cbName,
        acc: lifted.paramNames[0] as string,
        elem: lifted.paramNames[1] as string,
        forwarded: lifted.forwarded,
        init,
      };
    }
    // `sort` → `tslib` (040): default (0 args) is a lexicographic string compare;
    // a comparator arrow lifts its two-param body (series 048). A non-arrow `sort`
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
        const elemType = elementTypeOf(m.object, analysis);
        const lifted = liftCallback(
          call.arguments[0] as ArrowFunctionExpression,
          analysis,
          "sort",
          elemType,
          2,
        );
        return {
          kind: "iterSortBy",
          receiver: lowerExpr(m.object, analysis),
          cbName: lifted.cbName,
          a: lifted.paramNames[0] as string,
          b: lifted.paramNames[1] as string,
          forwarded: lifted.forwarded,
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

// ── Callback lifting (series 048) ─────────────────────────────────────────────

/**
 * Array adapter methods whose arrow callback is lifted to a `__cb_*` fn (series
 * 048). An `async` callback in one of these is fail-loud until series 051b wires
 * the `join_all` consumer (series 054c guard).
 */
const LIFT_ADAPTERS = new Set([
  "map",
  "filter",
  "find",
  "some",
  "every",
  "reduce",
  "sort",
]);

/** JS globals a callback body may read without them being *free variables*. */
const CB_GLOBALS = new Set([
  "console",
  "JSON",
  "Math",
  "Object",
  "undefined",
  "NaN",
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
): { params: string[]; bodyExpr: Expression } {
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
  return { params: params as string[], bodyExpr };
}

/**
 * The read-only free variables of a callback body, in first-occurrence order: the
 * `Identifier`s it reads that are not its own params, a top-level fn name, a
 * declared nominal type, a member-access property, or a known global. A free var
 * that is *assigned* (an `=` LHS, or a `++`/`--` target) is a mutable capture —
 * fail-loud (series 048; the user lifts it to a named fn taking the state).
 */
function freeVarsOf(
  body: Expression,
  params: Set<string>,
  analysis: ModuleAnalysis,
): string[] {
  const excluded = (name: string): boolean =>
    params.has(name) ||
    analysis.fns.has(name) ||
    analysis.structs.has(name) ||
    CB_GLOBALS.has(name);
  const seen = new Set<string>();
  const order: string[] = [];
  const mutableCapture = (): never => {
    throw new UnsupportedError({
      type: "mutable capture in a callback (lift to a named fn taking the state as an explicit param)",
    });
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isAstNode(node)) return;
    switch (node.type) {
      case "Identifier": {
        const name = node.name as string;
        if (!excluded(name) && !seen.has(name)) {
          seen.add(name);
          order.push(name);
        }
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
      default: {
        for (const key in node) {
          if (key === "type") continue;
          visit(node[key]);
        }
      }
    }
  };
  visit(body);
  return order;
}

/** Is a `RustType` a `Copy` scalar (forwardable by value into a lifted fn)? */
function isCopyRustType(ty: RustType): boolean {
  return (
    ty.kind === "f64" ||
    ty.kind === "usize" ||
    ty.kind === "i64" ||
    ty.kind === "bool" ||
    ty.kind === "fnPtr"
  );
}

/**
 * The bounded expression typer (series 048): types a lifted callback body over
 * the numeric surface — arithmetic → `f64`, comparison/logical → `bool`, `!` →
 * `bool`, `-x` → the operand type, a literal by its kind, an identifier by `ctx`
 * (the param + free-var types). Anything else fails loud (numeric arrays first).
 */
function typeCbBody(e: HirExpr, ctx: Map<string, RustType>): RustType {
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
function liftCallback(
  arrow: ArrowFunctionExpression,
  analysis: ModuleAnalysis,
  method: string,
  elemType: RustType,
  arity: number,
  accType?: RustType,
): { cbName: string; paramNames: string[]; forwarded: HirExpr[] } {
  const { params, bodyExpr } = arrowShape(arrow, arity);
  const paramSet = new Set(params);
  const freeNames = freeVarsOf(bodyExpr, paramSet, analysis);

  // Param types: own params first, then each free var (Copy scalars only).
  const ctx = new Map<string, RustType>();
  const ownParams: HirParam[] =
    arity === 2 && accType
      ? [
          { name: params[0] as string, ty: accType },
          { name: params[1] as string, ty: elemType },
        ]
      : params.map((p) => ({ name: p, ty: elemType }));
  for (const p of ownParams) ctx.set(p.name, p.ty);

  const freeParams: HirParam[] = [];
  const forwarded: HirExpr[] = [];
  for (const name of freeNames) {
    const t = analysis.bindingTypes.get(name);
    if (!t) {
      throw new UnsupportedError({
        type: `cannot lift callback: free variable '${name}' has unknown type`,
      });
    }
    if (!isCopyRustType(t)) {
      throw new UnsupportedError({
        type: `cannot lift callback: free variable '${name}' is not a Copy scalar (only read-only scalars forward)`,
      });
    }
    ctx.set(name, t);
    freeParams.push({ name, ty: t });
    forwarded.push({ kind: "ident", name });
  }

  const body = lowerExpr(bodyExpr, analysis);
  const ret = typeCbBody(body, ctx);
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
    body: [{ kind: "return", value: body }],
  });
  return { cbName, paramNames: params, forwarded };
}

/**
 * The element type of an adapter receiver (series 048): a receiver identifier of
 * a known `Vec<E>` yields `E`; an array literal yields its first element's scalar
 * type. Anything else (a chained call, an unknown binding) is fail-loud.
 */
function elementTypeOf(objExpr: Expression, analysis: ModuleAnalysis): RustType {
  if (objExpr.type === "Identifier") {
    const t = analysis.bindingTypes.get((objExpr as Identifier).name);
    if (t && t.kind === "vec") return t.elem;
    throw new UnsupportedError({
      type: `cannot lift callback: receiver '${(objExpr as Identifier).name}' is not a known array`,
    });
  }
  if (objExpr.type === "ArrayExpression") {
    const first = (objExpr as ArrayExpression).elements[0];
    if (first) return scalarLiteralType(first as Expression);
    throw new UnsupportedError({
      type: "cannot lift callback over an empty array literal",
    });
  }
  throw new UnsupportedError({
    type: "cannot lift callback: receiver element type unknown",
  });
}

/** The scalar `RustType` of a literal expression (f64/String/bool), else fail-loud. */
function scalarLiteralType(e: Expression): RustType {
  if (e.type === "Literal") {
    const v = (e as Literal).value;
    if (typeof v === "number") return { kind: "f64" };
    if (typeof v === "string") return { kind: "String" };
    if (typeof v === "boolean") return { kind: "bool" };
  }
  throw new UnsupportedError({
    type: "cannot lift callback: element type is not a scalar literal",
  });
}

/** The `RustType` of a `reduce` initial value (a literal, or a known binding). */
function initType(e: Expression, analysis: ModuleAnalysis): RustType {
  if (e.type === "Literal") return scalarLiteralType(e);
  if (e.type === "Identifier") {
    const t = analysis.bindingTypes.get((e as Identifier).name);
    if (t) return t;
  }
  throw new UnsupportedError({
    type: "cannot lift reduce: initial value type unknown (numeric surface only)",
  });
}

/**
 * Resolve every `const`/`let`/`var` and function param to a `RustType` (series
 * 048), name-based and last-write-wins. Annotated bindings/params use `lowerType`;
 * an unannotated binding is typed from a scalar/array literal initializer. A type
 * that fails to lower is skipped (best-effort) — the lift site fails loud if it
 * later needs a missing entry.
 */
function collectBindingTypes(
  program: Program,
  structs: Set<string>,
): Map<string, RustType> {
  const out = new Map<string, RustType>();
  const typeFrom = (
    annotation: unknown,
    init: Expression | null,
  ): RustType | null => {
    if (isAstNode(annotation)) {
      const inner = (annotation as { typeAnnotation?: unknown }).typeAnnotation;
      if (isAstNode(inner)) {
        try {
          return lowerType(inner as unknown as TSType, structs);
        } catch {
          return null;
        }
      }
    }
    return init ? inferInitType(init) : null;
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isAstNode(node)) return;
    if (node.type === "VariableDeclarator") {
      const id = node.id;
      if (isAstNode(id) && id.type === "Identifier") {
        const ty = typeFrom(
          (id as { typeAnnotation?: unknown }).typeAnnotation,
          (node.init as Expression | null) ?? null,
        );
        if (ty) out.set(id.name as string, ty);
      }
    }
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      for (const p of (node.params as unknown[]) ?? []) {
        if (isAstNode(p) && p.type === "Identifier") {
          const ty = typeFrom(
            (p as { typeAnnotation?: unknown }).typeAnnotation,
            null,
          );
          if (ty) out.set(p.name as string, ty);
        }
      }
    }
    for (const key in node) {
      if (key === "type") continue;
      visit(node[key]);
    }
  };
  visit(program.body);
  return out;
}

/** Infer a `RustType` from a scalar/array-literal initializer (best-effort, series 048). */
function inferInitType(init: Expression): RustType | null {
  if (init.type === "Literal") {
    const v = (init as Literal).value;
    if (typeof v === "number") return { kind: "f64" };
    if (typeof v === "string") return { kind: "String" };
    if (typeof v === "boolean") return { kind: "bool" };
    return null;
  }
  if (init.type === "ArrayExpression") {
    const first = (init as ArrayExpression).elements[0];
    if (!first) return null;
    const elem = inferInitType(first as Expression);
    return elem ? { kind: "vec", elem } : null;
  }
  return null;
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
    // Class inheritance (series 053c): a field read through a `dyn IA` element
    // (a `Box<dyn IA>`/`&dyn IA` binding) routes through a trait accessor
    // `a.x()` — a trait holds no data. A field the base does not declare is
    // subclass-only → a downcast, fail-loud (deferred to #17).
    const dynBase = dynBaseOf(member.object, analysis);
    if (dynBase) {
      const root = dynBaseRoot(dynBase, analysis);
      if (!fieldOwner(dynBase, prop, analysis)) {
        throw new UnsupportedError({
          type: `field '${prop}' read through a 'dyn ${traitNameOf(root)}' is not a shared/base field (downcast — deferred to #17)`,
        });
      }
      recordDynFieldRead(root, prop, analysis);
      return {
        kind: "method",
        receiver: lowerExpr(member.object, analysis),
        name: prop,
        args: [],
      };
    }
    // Otherwise classify the field read own-vs-inherited (053a): `this` → the
    // class under lowering; an identifier binding → its `bindingTypes` struct.
    // An inherited field hops through `.base`.
    const cls = receiverClass(member.object, analysis);
    if (cls) {
      const hops = baseHopsToField(cls, prop, analysis);
      if (hops > 0) {
        let object: HirExpr = lowerExpr(member.object, analysis);
        for (let i = 0; i < hops; i++) {
          object = { kind: "field", object, name: "base" };
        }
        return { kind: "field", object, name: prop };
      }
    }
    return {
      kind: "field",
      object: lowerExpr(member.object, analysis),
      name: prop,
    };
  }
  throw new UnsupportedError(member);
}

/**
 * The class of a member-access receiver, or null (series 053). `this` resolves
 * to the class under lowering; an identifier binding resolves via
 * `bindingTypes` (a `struct` type that names a declared class).
 */
function receiverClass(
  object: Expression,
  analysis: ModuleAnalysis,
): string | null {
  if (object.type === "ThisExpression") return analysis.currentClass ?? null;
  if (object.type === "Identifier") {
    const t = analysis.bindingTypes.get((object as Identifier).name);
    if (t && t.kind === "struct" && analysis.classes.has(t.name)) return t.name;
  }
  return null;
}

/** The base (trait-owning) class a `dyn`/`Box<dyn>` binding element carries, or null. */
function dynBaseOf(object: Expression, analysis: ModuleAnalysis): string | null {
  if (object.type === "Identifier") {
    return analysis.dynBindings.get((object as Identifier).name) ?? null;
  }
  return null;
}

/** The root (trait-owning) base of a class chain (itself if none) — 053c accessors. */
function dynBaseRoot(name: string, analysis: ModuleAnalysis): string {
  return rootBaseOf(name, analysis);
}

/**
 * Number of `.base` hops from a class to the ancestor that *declares* `field`
 * (series 053a): 0 if the field is the class's own, else the depth of the
 * declaring ancestor. Undeclared fields hop 0 (a plain read — cargo catches a
 * genuine typo).
 */
function baseHopsToField(
  cls: string,
  field: string,
  analysis: ModuleAnalysis,
): number {
  const inherited = analysis.inheritedFields.get(cls);
  if (!inherited || !inherited.has(field)) return 0;
  let hops = 0;
  let cur: string | undefined = cls;
  while (cur) {
    const own = analysis.ownClassFields.get(cur);
    if (own?.has(field)) return hops;
    cur = analysis.superclass.get(cur);
    hops++;
  }
  return hops;
}

/** The ancestor (self or above) that declares `field`, or null (053c gating). */
function fieldOwner(
  cls: string,
  field: string,
  analysis: ModuleAnalysis,
): string | null {
  let cur: string | undefined = cls;
  while (cur) {
    if (analysis.ownClassFields.get(cur)?.has(field)) return cur;
    cur = analysis.superclass.get(cur);
  }
  return null;
}

/** Record a base-field read through a `dyn` (gates accessor synthesis, 053c). */
function recordDynFieldRead(
  base: string,
  field: string,
  analysis: ModuleAnalysis,
): void {
  let set = analysis.dynFieldReads.get(base);
  if (!set) {
    set = new Set();
    analysis.dynFieldReads.set(base, set);
  }
  set.add(field);
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
    case "TSFunctionType": {
      // A function-type annotation `(a: A, b: B) => R` → a bare `fn`-pointer
      // `fn(A, B) -> R` (series 048). oxc's TSFunctionType carries `params`
      // (each an `Identifier` with its own `typeAnnotation`) and a `returnType`
      // wrapped in a `TSTypeAnnotation`.
      const f = ty as unknown as {
        params: { typeAnnotation?: { typeAnnotation: TSType } | null }[];
        returnType?: { typeAnnotation: TSType } | null;
      };
      const params = f.params.map((p) => {
        const inner = p.typeAnnotation?.typeAnnotation;
        if (!inner) throw new UnsupportedError(ty);
        return lowerType(inner, structs);
      });
      const ret = f.returnType
        ? lowerType(f.returnType.typeAnnotation, structs)
        : UNIT;
      return { kind: "fnPtr", params, ret };
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
