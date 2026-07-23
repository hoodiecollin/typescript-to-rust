/**
 * Lowering: fallibility — `throw`, custom `Error` classes, and `try`/`catch`
 * (series 022/028/029/037). Throws erase to `return Err(<value>)`; a custom
 * error class becomes an `AppError::<Class>` variant; `try`/`catch` lowers to a
 * `?`-carrier rewrite (the catch arm recognizes an `instanceof` discriminant and
 * binds destructured error fields), with the control-flow plumbing —
 * break/continue retargeting through the carrier, closure-escape detection, and
 * `Ok`-wrapping of a now-fallible body (`makeFallible`). Extracted from the
 * lowering monolith (series 109); the core lowerers are imported from `./index`.
 */

import type { ModuleAnalysis } from "../analysis";
import type {
  AssignmentExpression,
  CallExpression,
  ClassDeclaration,
  Expression,
  ExpressionStatement,
  Identifier,
  IfStatement,
  Literal,
  MemberExpression,
  MethodDefinition,
  NewExpression,
  PropertyDefinition,
  Statement,
  ThrowStatement,
  TryStatement,
} from "../ast";
import { UnsupportedError } from "../errors";
import type { HirCatchArm, HirExpr, HirStmt, RustType } from "../hir";
import { UNIT } from "./constants";
import {
  lowerBlock,
  lowerExpr,
  lowerStatements,
  lowerType,
  programErrType,
} from "./index";
import { isAstNode } from "./utils";

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
export function lowerThrow(
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
export function lowerErrorClass(
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
export function lowerTry(
  stmt: TryStatement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt {
  const rawTry = lowerStatements(stmt.block.body, analysis, scope);
  const finallyBody = stmt.finalizer
    ? lowerStatements(stmt.finalizer.body, analysis, scope)
    : null;
  const errTy = programErrType(analysis);

  // A `try` body that `await`s (e.g. `try { await fsAsync.readFile(p) } catch`)
  // is fail-loud: recovery lowers to a **sync** `Result`-returning IIFE closure,
  // which cannot host an `.await`. Async error-recovery (an `async` recovery
  // closure) is a separate slice — reject rather than emit a closure that will
  // not compile. The sync fallible catch (IO7) is unaffected.
  if (hirHasAwait(rawTry)) {
    throw new UnsupportedError({
      type: "await inside a try/catch is not yet supported (async error recovery is a later slice — await outside the try, or handle the error via the propagated Result)",
    });
  }

  // `try`/`finally` with no `catch` handler (series 063, graduated): a labeled
  // block captures the `Result`, `finally` runs on both paths, then an error
  // propagates. `finally` + an escaping jump stays fail-loud (carrier-enum
  // follow-on). A bare `try` (no catch, no finally) is meaningless → fail-loud.
  if (!stmt.handler) {
    if (!finallyBody) {
      throw new UnsupportedError({ type: "try without a catch or finally" });
    }
    if (escapesClosure(rawTry, false)) {
      // series 073: a `finally` combined with an escaping jump lowers to a control
      // carrier — the `finally` runs before the escape is replayed.
      return buildCarrierTry(
        rawTry,
        null,
        null,
        finallyBody,
        analysis,
        scope,
        errTy,
      );
    }
    if (!analysis.fallible.has(scope)) {
      throw new UnsupportedError({
        type: "try/finally in a non-fallible scope (nothing to recover — a later slice)",
      });
    }
    const label = `try_${analysis.tryCounter++}`;
    return {
      kind: "tryBlock",
      label,
      tryBody: rewriteTryBreaks(rawTry.map(wrapReturns), label),
      catchParam: null,
      catchBody: null,
      finallyBody,
      errTy,
    };
  }

  const catchBody = lowerStatements(stmt.handler.body.body, analysis, scope);
  // A `try`/`catch` whose `try` or `catch` natively `return`s / `break`s /
  // `continue`s (value-yielding / escaping, series 063) → a labeled-block lowering
  // (native escapes work; the IIFE closure would swallow them). `finally` + escape
  // is fail-loud (carrier-enum follow-on).
  const catchParamName = stmt.handler.param ? stmt.handler.param.name : null;
  if (escapesClosure(rawTry, false) || escapesClosure(catchBody, false)) {
    if (finallyBody) {
      // series 073: finally + an escaping jump in try/catch → the control carrier
      // (the `finally` runs once, before the escape is replayed).
      return buildCarrierTry(
        rawTry,
        catchParamName,
        catchBody,
        finallyBody,
        analysis,
        scope,
        errTy,
        stmt.handler.body.body,
      );
    }
    // A `catch` that fully handles the error may leave the fn *non*-fallible (the
    // error never propagates), so returns are `Ok`-wrapped only when the enclosing
    // scope is fallible. The labeled block still carries `Result<(), E>` internally.
    const wrap = analysis.fallible.has(scope)
      ? (ss: HirStmt[]) => ss.map(wrapReturns)
      : (ss: HirStmt[]) => ss;
    const label = `try_${analysis.tryCounter++}`;
    // A discriminating `instanceof` ladder catch (049c) → native `match` arms over
    // the owned error, with each arm's returns `Ok`-wrapped iff the scope is
    // fallible (series 063 extends the ladder to escaping/value-yielding catches).
    const discriminant =
      catchParamName && analysis.errorClasses.size > 0
        ? recognizeDiscriminant(
            stmt.handler.body.body,
            catchParamName,
            analysis,
            scope,
          )
        : undefined;
    const wrappedDiscriminant = discriminant?.map((arm) => ({
      ...arm,
      body: wrap(arm.body),
    }));
    return {
      kind: "tryBlock",
      label,
      tryBody: rewriteTryBreaks(wrap(rawTry), label),
      catchParam: catchParamName,
      catchBody: wrap(catchBody),
      finallyBody: null,
      errTy,
      discriminant: wrappedDiscriminant,
      // When the try body always diverges (value-yield: it `return`s on the
      // success path), the `Ok(_)` match arm is unreachable → `unreachable!()`.
      okUnreachable: divergesFully(rawTry),
    };
  }
  if (finallyBody && hirHasThrowOrTry(catchBody)) {
    throw new UnsupportedError({
      type: "re-throw inside catch alongside a finally (deferred)",
    });
  }
  // Series 049c: recognize an `instanceof` ladder catch body → a native `match`
  // over the owned bound error (no `downcast_ref`). Non-ladder catches keep the
  // opaque bind. The `escapesClosure` gate above already rejected a per-branch
  // `return` (the #16 boundary), so a recognized ladder is statement-level only.
  const discriminant =
    catchParamName && analysis.errorClasses.size > 0
      ? recognizeDiscriminant(
          stmt.handler.body.body,
          catchParamName,
          analysis,
          scope,
        )
      : undefined;
  return {
    kind: "tryCatch",
    tryBody: makeFallible(rawTry, UNIT),
    catchParam: catchParamName,
    catchBody,
    finallyBody,
    errTy,
    discriminant,
  };
}

/**
 * Build a 073 `carrierTry` node for a `finally` combined with an escaping jump.
 * The `try` (and `catch`) arms are rewritten so each escape records its intent and
 * breaks to the wrapper label (`return v` → `Ctrl::Return(v)`, `break L`/`continue
 * L` → `Ctrl::Break/Continue(target)`, `throw`/`?` → `Ctrl::Err`); the `finally`
 * runs natively before the dispatch replays the recorded escape. `catchAst` is the
 * raw catch handler body (for `instanceof`-ladder recognition), `null` for a
 * `try`/`finally` with no handler.
 */
function buildCarrierTry(
  rawTry: HirStmt[],
  catchParamName: string | null,
  catchBody: HirStmt[] | null,
  finallyBody: HirStmt[],
  analysis: ModuleAnalysis,
  scope: string,
  errTy: RustType,
  catchAst?: Statement[],
): HirStmt {
  const label = `ctrl_${analysis.tryCounter++}`;
  const fallible = analysis.fallible.has(scope);
  const retTy = carrierReturnType(analysis, scope);

  const collector: CarrierEscapes = {
    hasReturn: false,
    hasCarrierErr: false,
    breakTargets: [],
    continueTargets: [],
  };
  // The `try` arm's escapes always feed the carrier (`'<label>`). Its `?`/`throw`
  // feed the carrier `Err` directly when there is *no* handler; with a handler,
  // they route to an inner `'try_N` block (bare `Err`) so the `catch` sees them.
  const innerTryLabel =
    catchBody === null ? null : `try_${analysis.tryCounter++}`;
  const tryErrLabel = innerTryLabel ?? label;
  const tryBody = rewriteCarrierArm(rawTry, {
    carrierLabel: label,
    errLabel: tryErrLabel,
    carrierErr: innerTryLabel === null,
    insideLoop: false,
    esc: collector,
  });
  // The `catch` arm's escapes *and* its `?`/`throw` (a rethrow alongside finally)
  // both feed the carrier.
  const catchOpts = {
    carrierLabel: label,
    errLabel: label,
    carrierErr: true,
    insideLoop: false,
    esc: collector,
  } as const;
  const loweredCatch =
    catchBody === null ? null : rewriteCarrierArm(catchBody, catchOpts);

  // A discriminating `instanceof` ladder catch (049c) lowers to native `match`
  // arms; its arm bodies carry escapes too, so rewrite them into the carrier.
  const discriminant =
    catchAst && catchParamName && analysis.errorClasses.size > 0
      ? recognizeDiscriminant(catchAst, catchParamName, analysis, scope)?.map(
          (arm) => ({
            ...arm,
            body: rewriteCarrierArm(arm.body, catchOpts),
          }),
        )
      : undefined;

  return {
    kind: "carrierTry",
    label,
    innerTryLabel,
    tryBody,
    catchParam: catchParamName,
    catchBody: loweredCatch,
    finallyBody,
    errTy,
    retTy,
    fallible,
    hasReturn: collector.hasReturn,
    // The `Ctrl::Err` variant / dispatch arm exists only when an error escapes the
    // whole construct to the fn's `Result` — a carrier-level error in a *fallible*
    // scope. A `catch` that fully handles the error leaves the scope non-fallible,
    // so no `Err` propagates (and `return Err(..)` would not type-check).
    hasErr: fallible && collector.hasCarrierErr,
    breakTargets: collector.breakTargets,
    continueTargets: collector.continueTargets,
    // The wrapper falls through to `Ctrl::Normal` when a path can complete normally:
    // the `try` completes (no handler / Ok path) or the `catch`/ladder arm does. If
    // every path escapes, the fall-through is unreachable and `Normal` is elided.
    tryFallsThrough:
      !divergesFully(tryBody) ||
      (loweredCatch !== null && !divergesFully(loweredCatch)) ||
      (discriminant?.some((arm) => !divergesFully(arm.body)) ?? false),
    // When the `finally` body itself unconditionally escapes, the native `finally`
    // pre-empts the carrier and the dispatch is dead code — suppress it.
    dispatchDead: divergesFully(finallyBody),
    discriminant,
  };
}

/** The enclosing fn's return **inner** type (the `Ctrl::Return(V)` payload). */
function carrierReturnType(analysis: ModuleAnalysis, scope: string): RustType {
  const retAnn = analysis.fns.get(scope)?.retAnn;
  if (!retAnn) {
    throw new UnsupportedError({
      type: "finally + escape in a scope without a return-type annotation (carrier needs the return type)",
    });
  }
  return lowerType(retAnn, analysis.structs);
}

/** Distinct escape targets accumulated while rewriting the carrier arms. */
interface CarrierEscapes {
  hasReturn: boolean;
  /** A carrier-level error (`Ctrl::Err`) can escape the whole construct. */
  hasCarrierErr: boolean;
  breakTargets: (string | null)[];
  continueTargets: (string | null)[];
}

/**
 * Options for rewriting one carrier arm. `carrierLabel` is the wrapper block an
 * escape (`return`/`break`/`continue`) records into; `errLabel` is the block a
 * `?`/`throw` breaks (the carrier itself for the no-handler / catch arms →
 * `Ctrl::Err`; or an inner `'try` block for a `try` arm *with* a handler →
 * bare `Err`, so the `catch` sees it), selected by `carrierErr`.
 */
interface CarrierOpts {
  carrierLabel: string;
  errLabel: string;
  carrierErr: boolean;
  insideLoop: boolean;
  esc: CarrierEscapes;
}

/**
 * Rewrite one carrier arm (`try` or `catch`) so each escape that would leave the
 * `try`/`catch` records its intent into the carrier and breaks to the wrapper:
 *   - `return v` → `break '<carrier> Ctrl::Return(v)` (`return;` carries `null`);
 *   - `break L`/`continue L` (not bound by a loop nested *inside* the arm) →
 *     `break '<carrier> Ctrl::Break/Continue(target)`, `target` the label or `null`
 *     for the nearest enclosing loop;
 *   - `throw e`/`?` → `errLabel` (carrier `Err`, or the inner `'try` bare `Err`).
 * A `break`/`continue` under a nested loop is that loop's own concern — left
 * native (mirrors `escapesClosure`'s `insideLoop`). Descent stops at a nested
 * `carrierTry`/`tryBlock`/`tryCatch`/`closure`/generator boundary.
 */
function rewriteCarrierArm(stmts: HirStmt[], opts: CarrierOpts): HirStmt[] {
  return stmts.map((s) => rewriteCarrierStmt(s, opts));
}

function rewriteCarrierStmt(s: HirStmt, opts: CarrierOpts): HirStmt {
  const { carrierLabel: label, errLabel, carrierErr, insideLoop, esc } = opts;
  const inner = (loop: boolean): CarrierOpts =>
    loop === insideLoop ? opts : { ...opts, insideLoop: loop };
  switch (s.kind) {
    case "return":
      esc.hasReturn = true;
      // A fallible call in the returned value (`return f()` where `f` throws) must
      // record the error into the carrier (running `finally`), not `?`-propagate
      // past it — retarget its `?`/`throw` before wrapping in `Ctrl::Return`.
      if (carrierErr && s.value && hirHasThrowOrTry(s.value))
        esc.hasCarrierErr = true;
      return {
        kind: "carrierBreak",
        label,
        ctrl: "Return",
        value: s.value ? rewriteTryBreaks(s.value, errLabel, carrierErr) : null,
      };
    case "break":
      if (insideLoop) return s; // bound by a loop nested in the arm — native
      addTarget(esc.breakTargets, s.label ?? null);
      return { kind: "carrierBreak", label, ctrl: "Break", target: s.label ?? null };
    case "continue":
      if (insideLoop) return s;
      addTarget(esc.continueTargets, s.label ?? null);
      return {
        kind: "carrierBreak",
        label,
        ctrl: "Continue",
        target: s.label ?? null,
      };
    case "throw":
      // A non-panic `throw` records the error (carrier `Err`, or the inner `'try`
      // bare `Err`); a `"use panic"` throw is a real abort (untouched).
      if (s.panic) return s;
      if (carrierErr) esc.hasCarrierErr = true; // an error escapes → Ctrl::Err
      return carrierErr
        ? { kind: "carrierErr", label: errLabel, value: s.value }
        : { kind: "breakTry", label: errLabel, value: s.value };
    case "if":
      return {
        kind: "if",
        cond: s.cond,
        conseq: rewriteCarrierArm(s.conseq, opts),
        alt: s.alt ? rewriteCarrierArm(s.alt, opts) : null,
      };
    case "block":
      return { ...s, body: rewriteCarrierArm(s.body, opts) };
    case "match":
      return {
        kind: "match",
        disc: s.disc,
        arms: s.arms.map((a) => ({ ...a, body: rewriteCarrierArm(a.body, opts) })),
      };
    case "while":
    case "forIn":
    case "forRange":
      return { ...s, body: rewriteCarrierArm(s.body, inner(true)) };
    case "ifLet":
      return {
        ...s,
        someBody: rewriteCarrierArm(s.someBody, opts),
        noneBody: s.noneBody ? rewriteCarrierArm(s.noneBody, opts) : null,
      };
    case "carrierTry": {
      // A nested carrier (series 073): its dispatch replays escapes into *this*
      // (outer) carrier so the outer `finally` runs. Redirect its dispatch to the
      // outer wrapper and fold its escape targets into the outer collector. Its own
      // arms already carrier-encode against its own label — untouched. A nested
      // break/continue under a loop nested in this arm stays that loop's concern.
      if (s.hasReturn) esc.hasReturn = true;
      // An inner carrier whose dispatch can re-record `Ctrl::Err` into this outer
      // carrier needs the outer `Err` variant too.
      if (s.hasErr) esc.hasCarrierErr = true;
      if (!insideLoop) {
        s.breakTargets.forEach((t) => addTarget(esc.breakTargets, t));
        s.continueTargets.forEach((t) => addTarget(esc.continueTargets, t));
      }
      // The nested `finally` runs natively and may itself escape — carrier-encode it.
      return {
        ...s,
        outerLabel: label,
        finallyBody: rewriteCarrierArm(s.finallyBody, opts),
      };
    }
    default:
      // `let`/`expr`/`?`/nested try/closure/generator — the `?`/`throw` inside are
      // retargeted (carrier `Err` or inner `'try` bare `Err`) by `rewriteTryBreaks`;
      // a nested try/closure boundary is left to itself there. `carrierBreak`
      // can't appear yet (rewrite runs once).
      if (carrierErr && hirHasThrowOrTry(s)) esc.hasCarrierErr = true;
      return rewriteTryBreaks(s, errLabel, carrierErr);
  }
}

/** Add a distinct escape target (label string, or `null` for the nearest loop). */
function addTarget(targets: (string | null)[], target: string | null): void {
  if (!targets.some((t) => t === target)) targets.push(target);
}

/**
 * Rewrite a `tryBlock`'s `try` body (series 063): each `?` (`{kind:"try"}`) becomes
 * a `tryBreak` (`match … Err => break '<label>`), and each non-panic `throw` becomes
 * a `breakTry` (`break '<label> Err(…)`). Native `return`/`break`/`continue` are
 * left untouched — a labeled block is not a function boundary, so they escape the
 * enclosing fn/loop. Descent stops at a nested `tryCatch`/`tryBlock` (its `?`/throw
 * belong to its own label) and at an inline `closure` (its own boundary).
 *
 * `carrier` (series 073) retargets the error break to `Ctrl::Err(…)` — the `?`
 * becomes `tryBreak{carrier}` and the `throw` becomes `carrierErr` — so a carrier
 * arm's fallible ops feed the control carrier instead of a bare `Err`.
 */
function rewriteTryBreaks<T>(node: T, label: string, carrier = false): T {
  if (Array.isArray(node)) {
    return node.map((n) => rewriteTryBreaks(n, label, carrier)) as unknown as T;
  }
  if (node && typeof node === "object") {
    const kind = (node as { kind?: string }).kind;
    if (
      kind === "tryCatch" ||
      kind === "tryBlock" ||
      kind === "carrierTry" ||
      kind === "closure"
    ) {
      return node;
    }
    if (kind === "try") {
      return {
        kind: "tryBreak",
        label,
        expr: rewriteTryBreaks(
          (node as unknown as { expr: unknown }).expr,
          label,
          carrier,
        ),
        ...(carrier ? { carrier: true } : {}),
      } as unknown as T;
    }
    if (kind === "throw" && !(node as { panic?: boolean }).panic) {
      const value = rewriteTryBreaks(
        (node as unknown as { value: unknown }).value,
        label,
        carrier,
      );
      return (
        carrier
          ? { kind: "carrierErr", label, value }
          : { kind: "breakTry", label, value }
      ) as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const key in node) {
      out[key] = rewriteTryBreaks(
        (node as Record<string, unknown>)[key],
        label,
        carrier,
      );
    }
    return out as unknown as T;
  }
  return node;
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
export function rewriteFieldReads<T>(node: T, catchParam: string, binds: string[]): T {
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
      case "carrierTry":
        // A nested 073 carrier's dispatch replays its escape *in this context* — a
        // `Return` re-escapes, and a `Break`/`Continue` re-escapes unless bound by a
        // loop nested here. Its `finally` runs natively too, so a self-escaping
        // `finally` escapes as well.
        if (s.hasReturn) return true;
        if (!insideLoop && (s.breakTargets.length > 0 || s.continueTargets.length > 0))
          return true;
        if (escapesClosure(s.finallyBody, insideLoop)) return true;
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
export function makeFallible(stmts: HirStmt[], okTy: RustType): HirStmt[] {
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
  // series 073: a `carrierTry` whose dispatch always escapes (`return`/`throw` or a
  // self-escaping `finally`) diverges — no fall-through past it.
  if (last.kind === "carrierTry") return last.dispatchDead || !last.tryFallsThrough;
  if (last.kind === "if" && last.alt) {
    return diverges(last.conseq) && diverges(last.alt);
  }
  if (last.kind === "block") return diverges(last.body);
  return false;
}

/**
 * Does a statement list always diverge (its last statement `return`s / `throw`s /
 * `break`s / `continue`s on every path)? A superset of `diverges` used to decide
 * whether a `tryBlock`'s normal-completion `Ok(_)` arm is reachable (series 063).
 */
function divergesFully(stmts: HirStmt[]): boolean {
  const last = stmts[stmts.length - 1];
  if (!last) return false;
  if (
    last.kind === "return" ||
    last.kind === "throw" ||
    last.kind === "break" ||
    last.kind === "continue" ||
    last.kind === "breakTry" ||
    // series 073: a carrier escape (`break '<label> Ctrl::…`) diverges the block.
    last.kind === "carrierBreak" ||
    last.kind === "carrierErr"
  ) {
    return true;
  }
  // series 073: a whole `carrierTry` diverges when its dispatch always escapes —
  // the `try` can't fall through (no `Ctrl::Normal` arm) or a self-escaping
  // `finally` pre-empted the dispatch entirely.
  if (last.kind === "carrierTry") return last.dispatchDead || !last.tryFallsThrough;
  if (last.kind === "if" && last.alt) {
    return divergesFully(last.conseq) && divergesFully(last.alt);
  }
  if (last.kind === "block") return divergesFully(last.body);
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
export function hirHasAwait(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hirHasAwait);
  if (node === null || typeof node !== "object") return false;
  if ((node as { kind?: string }).kind === "await") return true;
  return Object.values(node).some(hirHasAwait);
}
