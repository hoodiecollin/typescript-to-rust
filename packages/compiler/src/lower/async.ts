/**
 * Lowering: async-lowering cluster (series 051a/051b/051c, 055, 100).
 *
 * The `await`/concurrency-combinator run split out of the lowering monolith:
 * `lowerAwait` and its combinator/fan-out/spawn helpers. Pure relocation —
 * imports the still-in-`index.ts` orchestrator helpers (`lowerCall`,
 * `lowerIoAsyncCall`, `liftCallback`, `elementTypeOf`, `lowerStatements`, plus
 * the exported `lowerExpr`/`lowerType`) from `./index`.
 */

import { SCRIPT_SCOPE } from "../analysis";
import type { ModuleAnalysis } from "../analysis";
import type {
  ArrayExpression,
  ArrowFunctionExpression,
  AwaitExpression,
  BlockStatement,
  CallExpression,
  Expression,
  Identifier,
  MemberExpression,
  TSType,
} from "../ast";
import { UnsupportedError } from "../errors";
import type { HirExpr, HirStmt, RustType } from "../hir";
import { liftCallback } from "./closures";
import {
  elementTypeOf,
  lowerCall,
  lowerExpr,
  lowerStatements,
  lowerType,
} from "./index";
import { lowerIoAsyncCall } from "./io-shim";
import { isCopyRustType } from "./utils";

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
export function lowerAwait(expr: AwaitExpression, analysis: ModuleAnalysis): HirExpr {
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
  // `await <non-call>` (a plain value, member access, literal, …) — awaiting a
  // non-thenable in JS just yields the value on the next microtask tick (#13,
  // series 055, "broad" policy). There is no future here, so drop the `await`
  // and lower the operand as an ordinary expression. (A spawned-handle
  // identifier was already peeled off above and keeps its real `.await`.)
  if (arg.type !== "CallExpression") {
    return lowerExpr(arg, analysis);
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

  // `await fsAsync.<m>(...)` / `await http.<m>(...)` (series 100) — an async-I/O
  // namespace call → `<tslib target>(&args).await?`. Handled here (before the
  // generic async-method path) since the `fsAsync`/`http` methods are not in
  // `asyncMethods`; the fallibility rides the `bodyUsesAsyncIo` seed.
  if (callee.type === "MemberExpression") {
    const obj = (callee as MemberExpression).object;
    const ns =
      obj.type === "Identifier"
        ? analysis.ioAsyncNamespaces.get((obj as Identifier).name)
        : undefined;
    if (ns) return lowerIoAsyncCall(ns, call, analysis);
  }

  // `await obj.m(...)` — an async method call (series 054a). The method must be
  // in `analysis.asyncMethods`; the receiver + args lower via `lowerCall`'s method
  // branch (with `awaited=true`, which returns the bare method expr). A fallible
  // async method `?`-propagates by wrapping the `await` in `try` → `.await?`.
  if (callee.type === "MemberExpression") {
    const prop = (callee as MemberExpression).property;
    const methodName = prop.type === "Identifier" ? (prop as Identifier).name : null;
    // `await obj.m(...)` where `m` is **not** async — a sync method returns a
    // plain value, so awaiting it is a no-op (#13, series 055). Drop the
    // `await`; `lowerCall` (via `lowerExpr`) still applies `?` for a fallible
    // sync method.
    if (!methodName || !analysis.asyncMethods.has(methodName)) {
      return lowerExpr(arg, analysis);
    }
    const awaited: HirExpr = {
      kind: "await",
      expr: lowerCall(call, analysis, true),
    };
    return analysis.fallibleMethods.has(methodName)
      ? { kind: "try", expr: awaited }
      : awaited;
  }
  // `await syncFn(...)` where `syncFn` is a declared non-async free fn (or any
  // non-Identifier callee that is not a modeled future) — a sync call is not a
  // future, so awaiting it just yields its value (#13, series 055). Drop the
  // `await`; `lowerCall` still wraps a fallible sync fn in `?`.
  if (
    callee.type !== "Identifier" ||
    !analysis.asyncFns.has((callee as Identifier).name)
  ) {
    return lowerExpr(arg, analysis);
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
export function lowerAwaitCombinator(
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
export function lowerDynamicFanOut(
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
export function fanOutParamType(
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
export function isJoinTuple(expr: HirExpr): boolean {
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
export function asyncCallItemType(
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
export function assertSpawnArgsSafe(call: CallExpression, analysis: ModuleAnalysis): void {
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
export function isTaskWrappableType(ty: RustType): boolean {
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
export function lowerSetTimeout(call: CallExpression, analysis: ModuleAnalysis): HirExpr {
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
