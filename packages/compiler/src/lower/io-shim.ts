/**
 * Lowering: std-I/O + `@ttr/std` shim + JSON/RNG boundary call lowering
 * (epics #52/#53/#54, series 084/100/101). Recognizes the blessed `@ttr/std`
 * intrinsics and JsonValue/RNG boundary shapes and lowers them to their `tslib`
 * targets. Extracted from the lowering monolith (series 109); the core lowerers
 * (`lowerExpr` from `./expressions`, `lowerTyped` from `./statements`, `lowerType`
 * from `./types`) come straight from the sibling hubs.
 */

import type { ModuleAnalysis } from "../analysis";
import type {
  CallExpression,
  Expression,
  Identifier,
  MemberExpression,
  TSType,
} from "../ast";
import { UnsupportedError } from "../errors";
import type { HirArg, HirExpr, RustType } from "../hir";
import type { StdShimName } from "../std-shim";
import { lowerExpr } from "./expressions";
import { lowerTyped } from "./statements";
import { lowerType } from "./types";

/**
 * Lower a recognized `@ttr/std` std-shim call (series 084).
 *
 * - `stringifyJson(v)` → the shipped 045 `tslib::json::stringify` writer (JS
 *   number fidelity, insertion-ordered keys). Reuses the `jsonStringify` HIR.
 * - `parseJson<T>(s)` → `tslib::json::ParseResult::<T>::parse(&s)`. `T` is the
 *   explicit call type argument (`parseJson<Point>(s)`) and must be a modeled
 *   struct/enum (or a primitive / `Array` / `Record` of them). A bare/unmodeled
 *   `T` is fail-loud. The result binding's inner `T` is recorded in
 *   `parseResultBindings` by `lowerVarDecl` so `.ok`/`.value`/`.error` resolve.
 */
/**
 * The flat sync `@ttr/std` I/O intrinsics (series 100) → their `tslib::io` /
 * `std` targets. `fallible` ones thread `?` (the containing fn is `Result` via
 * the seeded fallibility fixpoint); `refArgs` passes string args by `&` (→ `&str`
 * via deref coercion). Zero-arg intrinsics (`args`/`readStdin`/`readLine`/
 * `stdout`/`stderr`) simply supply no args.
 */
export const STD_IO_TARGETS: Record<
  string,
  { path: string; fallible: boolean; refArgs: boolean }
> = {
  readFile: { path: "tslib::io::read_file", fallible: true, refArgs: true },
  writeFile: { path: "tslib::io::write_file", fallible: true, refArgs: true },
  appendFile: { path: "tslib::io::append_file", fallible: true, refArgs: true },
  exists: { path: "tslib::io::exists", fallible: false, refArgs: true },
  removeFile: { path: "tslib::io::remove_file", fallible: true, refArgs: true },
  readDir: { path: "tslib::io::read_dir", fallible: true, refArgs: true },
  mkdir: { path: "tslib::io::mkdir", fallible: true, refArgs: true },
  removeDir: { path: "tslib::io::remove_dir", fallible: true, refArgs: true },
  env: { path: "tslib::io::env", fallible: false, refArgs: true },
  args: { path: "tslib::io::args", fallible: false, refArgs: true },
  exit: { path: "tslib::io::exit", fallible: false, refArgs: false },
  readStdin: { path: "tslib::io::read_stdin", fallible: true, refArgs: true },
  readLine: { path: "tslib::io::read_line", fallible: true, refArgs: true },
  stdout: { path: "tslib::io::stdout", fallible: false, refArgs: false },
  stderr: { path: "tslib::io::stderr", fallible: false, refArgs: false },
};

/**
 * Lower a flat sync `@ttr/std` I/O intrinsic call (series 100). Returns `null`
 * for a non-I/O shim name (the JSON/rng intrinsics handled by the caller). The
 * `fsAsync`/`http` namespace objects and the `Writer`/`HttpResponse` types are
 * not directly callable — a direct call is fail-loud.
 */
export function lowerStdIoCall(
  shim: StdShimName,
  call: CallExpression,
  analysis: ModuleAnalysis,
): HirExpr | null {
  const t = STD_IO_TARGETS[shim];
  if (!t) {
    if (
      shim === "fsAsync" ||
      shim === "http" ||
      shim === "Writer" ||
      shim === "HttpResponse"
    ) {
      throw new UnsupportedError({
        type: `\`${shim}\` from "@ttr/std" is not directly callable (use its members${
          shim === "fsAsync" || shim === "http" ? `, e.g. \`${shim}.…\`` : ""
        })`,
      });
    }
    return null;
  }
  const args: HirArg[] = call.arguments.map((a) => ({
    borrow: t.refArgs ? "ref" : "owned",
    expr: lowerExpr(a as Expression, analysis),
  }));
  const callExpr: HirExpr = { kind: "call", callee: t.path, args };
  return t.fallible ? { kind: "try", expr: callExpr } : callExpr;
}

/**
 * The async-I/O namespace targets (series 100): `fsAsync.<m>` → a `tslib::io`
 * async fn, `http.<m>` → a `tslib::http` fn. Each is fallible + awaited, lowered
 * to `<path>(&args).await?` by `lowerIoAsyncCall`.
 */
export const IO_ASYNC_TARGETS: Record<string, Record<string, string>> = {
  fsAsync: {
    readFile: "tslib::io::read_file_async",
    writeFile: "tslib::io::write_file_async",
    readDir: "tslib::io::read_dir_async",
    removeFile: "tslib::io::remove_file_async",
    mkdir: "tslib::io::mkdir_async",
  },
  http: {
    get: "tslib::http::get",
    post: "tslib::http::post",
  },
};

/**
 * Lower an **awaited** async-I/O namespace call — `await fsAsync.readFile(p)` /
 * `await http.get(u)` (series 100) → `<path>(&args).await?`. The `?` rides the
 * 049/051 fallibility model (the awaited-fallible rule); the enclosing async fn
 * is `Result` via the `bodyUsesAsyncIo` seed. An unknown member on the namespace
 * is fail-loud. Called from `lowerAwait` (the non-awaited case is rejected in
 * `lowerCall`).
 */
export function lowerIoAsyncCall(
  ns: "fsAsync" | "http",
  call: CallExpression,
  analysis: ModuleAnalysis,
): HirExpr {
  const member = call.callee as MemberExpression;
  const method =
    member.property.type === "Identifier"
      ? (member.property as Identifier).name
      : null;
  const path = method ? IO_ASYNC_TARGETS[ns]?.[method] : undefined;
  if (!path) {
    const avail = Object.keys(IO_ASYNC_TARGETS[ns] ?? {}).join("/");
    throw new UnsupportedError({
      type: `\`.${method ?? "?"}\` on \`${ns}\` — only ${avail} ${
        ns === "http" ? "of text bodies are" : "are"
      } available`,
    });
  }
  const args: HirArg[] = call.arguments.map((a) => ({
    borrow: "ref",
    expr: lowerExpr(a as Expression, analysis),
  }));
  return {
    kind: "try",
    expr: { kind: "await", expr: { kind: "call", callee: path, args } },
  };
}

export function lowerStdShimCall(
  shim: StdShimName,
  call: CallExpression,
  analysis: ModuleAnalysis,
): HirExpr {
  // I/O intrinsics (series 100) — the flat sync fs / env / process / stdin
  // calls. Handled first (some take zero args, unlike the one-arg JSON/rng
  // intrinsics below). Returns `null` for a non-I/O intrinsic → falls through.
  const io = lowerStdIoCall(shim, call, analysis);
  if (io) return io;
  const arg = call.arguments[0];
  if (!arg) {
    throw new UnsupportedError({
      type: `\`${shim}\` from "@ttr/std" takes exactly one argument`,
    });
  }
  if (shim === "stringifyJson") {
    return { kind: "jsonStringify", value: lowerExpr(arg, analysis) };
  }
  // `rng(seed)` (series 089) → a `tslib::rng::Rng` handle. Exactly one argument
  // (a `number` seed); no type argument. The binding-recording in `lowerVarDecl`
  // marks `const r = rng(…)` in `rngBindings` so `.next()/.int()/.pick()/.shuffle()`
  // route to the handle surface (before the generator `.next()` protocol).
  if (shim === "rng") {
    return { kind: "rngNew", seed: lowerExpr(arg, analysis) };
  }
  // `clock(epochMs)` (series 102) → a `tslib::date::Clock` handle. Exactly one
  // argument (a `number` epoch-ms seed). The binding-recording in `lowerVarDecl`
  // marks `const c = clock(…)` in `clockBindings` (emitted `let mut`) so
  // `.now()/.date()/.tick(ms)` route to the handle surface. Structural twin of
  // `rng` — composes from the existing `call` HIR (no new HIR/emitter case).
  if (shim === "clock") {
    return {
      kind: "call",
      callee: "tslib::date::Clock::new",
      args: [{ borrow: "owned", expr: lowerExpr(arg, analysis) }],
    };
  }
  // `parseJsonValue(s)` (series 090) → the dynamic parse. Reuses the 084 parse
  // node with a `jsonValue` target, so `const r = parseJsonValue(s)` records a
  // `ParseResult<JsonValue>` binding (its `.value` accessor yields a JsonValue).
  // No type argument — the shape is dynamic.
  if (shim === "parseJsonValue") {
    return {
      kind: "parseJson",
      source: lowerExpr(arg, analysis),
      target: { kind: "jsonValue" },
    };
  }
  // `fromJsonValue<T>(v)` (series 090) — dynamic → static. `<T>` is required and
  // modeled; the result is a `ParseResult<T>` (recorded in `lowerVarDecl`).
  if (shim === "fromJsonValue") {
    const ftargs = (call as { typeArguments?: { params?: TSType[] } })
      .typeArguments?.params;
    const fArg = ftargs?.[0];
    if (!fArg) {
      throw new UnsupportedError({
        type: '`fromJsonValue<T>` needs an explicit modeled type argument (`fromJsonValue<Point>(v)`) — an unconstrained `T` cannot be deserialized',
      });
    }
    const ftarget = lowerType(fArg, analysis.structs);
    assertModeledParseTarget(ftarget, analysis);
    return { kind: "fromJsonValue", value: lowerExpr(arg, analysis), target: ftarget };
  }
  // `toJsonValue<T>(x)` (series 090) — static → dynamic. The `<T>` types the
  // source so an object literal (`{ x: 1 }`) lowers as its struct literal; absent,
  // the arg is lowered by inference (a bare identifier/typed expr).
  if (shim === "toJsonValue") {
    const ttargs = (call as { typeArguments?: { params?: TSType[] } })
      .typeArguments?.params;
    const tArg2 = ttargs?.[0];
    const ttarget = tArg2 ? lowerType(tArg2, analysis.structs) : null;
    return {
      kind: "toJsonValue",
      value: ttarget
        ? lowerTyped(arg as Expression, ttarget, analysis)
        : lowerExpr(arg, analysis),
    };
  }
  // parseJson<T>(s): the type argument is required and must be modeled.
  const targs = (call as { typeArguments?: { params?: TSType[] } })
    .typeArguments?.params;
  const tArg = targs?.[0];
  if (!tArg) {
    throw new UnsupportedError({
      type: '`parseJson<T>` needs an explicit modeled type argument (`parseJson<Point>(s)`) — an unconstrained `T` cannot be deserialized',
    });
  }
  const target = lowerType(tArg, analysis.structs);
  assertModeledParseTarget(target, analysis);
  return { kind: "parseJson", source: lowerExpr(arg, analysis), target };
}

/**
 * `parseJson<T>` requires a *modeled* target: a struct/enum, a primitive, or an
 * `Array`/`Record`/`Option` recursively of one. An unresolved nominal type (a
 * `T` the module never declared) is fail-loud — serde has no shape to validate
 * against. Mirrors the "T must be a modeled struct/enum" dialect rule.
 */
export function assertModeledParseTarget(ty: RustType, analysis: ModuleAnalysis): void {
  switch (ty.kind) {
    case "f64":
    case "i64":
    case "usize":
    case "String":
    case "bool":
      return;
    case "vec":
      return assertModeledParseTarget(ty.elem, analysis);
    case "option":
      return assertModeledParseTarget(ty.inner, analysis);
    case "hashmap":
      return assertModeledParseTarget(ty.value, analysis);
    case "jsonValue":
      // A dynamic value is serde-deserializable (`serde_json::Value`), so it is a
      // legal `from_value`/`parseJson` target (series 090).
      return;
    case "struct":
      if (analysis.structs.has(ty.name)) return;
      throw new UnsupportedError({
        type: `\`parseJson<${ty.name}>\` — '${ty.name}' is not a modeled struct/enum (declare it as an \`interface\`/\`class\`/\`enum\`)`,
      });
    default:
      throw new UnsupportedError({
        type: "`parseJson<T>` needs a modeled struct/enum type argument (`parseJson<Point>(s)`)",
      });
  }
}

/**
 * Fail loud on a bare `JSON.parse(...)` / `JSON.stringify(...)`, redirecting to
 * the `@ttr/std` shim (series 084). Bare-JSON calls in expression position are
 * already caught by `lowerCall`; this covers the *binding-init* gate, which runs
 * before the init is lowered (so a `const v = JSON.parse(s)` gets the redirect
 * message, not "binding without a type annotation").
 */
export function redirectBareJson(e: Expression): void {
  if (e.type !== "CallExpression") return;
  const callee = (e as CallExpression).callee;
  if (callee.type !== "MemberExpression") return;
  const m = callee as MemberExpression;
  if (
    m.object.type !== "Identifier" ||
    (m.object as Identifier).name !== "JSON" ||
    m.property.type !== "Identifier"
  ) {
    return;
  }
  const method = (m.property as Identifier).name;
  if (method === "parse") {
    throw new UnsupportedError({
      type: '`JSON.parse` is not accepted — import from "@ttr/std": `parseJson<T>(s)` for a modeled shape, or `parseJsonValue(s)` for a dynamic `JsonValue` (series 090)',
    });
  }
  if (method === "stringify") {
    throw new UnsupportedError({
      type: '`JSON.stringify` is not accepted — import `stringifyJson` from "@ttr/std" and call `stringifyJson(v)`',
    });
  }
}

/**
 * Fail loud on a bare `Math.random` (called `Math.random()` or uncalled as a
 * value), redirecting to the `@ttr/std` `rng(seed)` shim (series 089). Covers the
 * binding-init gate, which runs before the init is lowered — so a
 * `const f = Math.random` / `const x = Math.random()` gets the redirect message,
 * not "binding without a type annotation". The expression-position forms are also
 * caught by `lowerNumberStatic` / `lowerMember`.
 */
export function redirectBareMathRandom(e: Expression): void {
  let member: Expression | null = null;
  if (e.type === "MemberExpression") {
    member = e;
  } else if (
    e.type === "CallExpression" &&
    (e as CallExpression).callee.type === "MemberExpression"
  ) {
    member = (e as CallExpression).callee as Expression;
  }
  if (!member || member.type !== "MemberExpression") return;
  const m = member as MemberExpression;
  if (
    m.object.type === "Identifier" &&
    (m.object as Identifier).name === "Math" &&
    m.property.type === "Identifier" &&
    (m.property as Identifier).name === "random"
  ) {
    throw new UnsupportedError({
      type: '`Math.random` is not accepted — import `rng` from "@ttr/std" and call `rng(seed)` (an explicit seed makes the stream differential-stable)',
    });
  }
}

/** Is `e` a call to the `@ttr/std` `parseJson<T>` intrinsic (series 084)? Keyed
 * off the local alias recorded from the reserved-specifier import. */
export function isParseJsonShimCall(e: Expression, analysis: ModuleAnalysis): boolean {
  if (e.type !== "CallExpression") return false;
  const callee = (e as CallExpression).callee;
  return (
    callee.type === "Identifier" &&
    analysis.stdShim.get((callee as Identifier).name) === "parseJson"
  );
}

/** Is `e` a call to the `@ttr/std` `rng(seed)` intrinsic (series 089)? Keyed off
 * the local alias recorded from the reserved-specifier import. */
export function isRngShimCall(e: Expression, analysis: ModuleAnalysis): boolean {
  if (e.type !== "CallExpression") return false;
  const callee = (e as CallExpression).callee;
  return (
    callee.type === "Identifier" &&
    analysis.stdShim.get((callee as Identifier).name) === "rng"
  );
}

/**
 * The `JsonValue` accessor surface (series 090): TS accessor name → its Rust
 * inherent-method name. `rid` only escapes keywords (no snake_case), so the
 * snake_case Rust name is carried on the HIR `method` node from here. `length`
 * is a TS **property** (lowered from a member access) but a Rust method.
 */
export const JSON_VALUE_METHODS = new Map<string, string>([
  ["get", "get"],
  ["at", "at"],
  ["asNumber", "as_number"],
  ["asString", "as_string"],
  ["asBool", "as_bool"],
  ["isNull", "is_null"],
  ["isNumber", "is_number"],
  ["isString", "is_string"],
  ["isBool", "is_bool"],
  ["isArray", "is_array"],
  ["isObject", "is_object"],
  ["length", "length"],
]);

/** Is `e` a call to one of the `@ttr/std` JSON-boundary intrinsics
 * (`parseJsonValue`/`fromJsonValue`/`toJsonValue`, series 090)? Each is typed by
 * construction (a `ParseResult<…>` or a `JsonValue`), so it is exempt from the
 * binding-annotation gate. Keyed off the reserved-specifier import alias. */
export function isJsonBoundaryShimCall(e: Expression, analysis: ModuleAnalysis): boolean {
  if (e.type !== "CallExpression") return false;
  const callee = (e as CallExpression).callee;
  if (callee.type !== "Identifier") return false;
  const shim = analysis.stdShim.get((callee as Identifier).name);
  return (
    shim === "parseJsonValue" ||
    shim === "fromJsonValue" ||
    shim === "toJsonValue"
  );
}

/**
 * Is `e` statically a `JsonValue` (series 090)? Recognizes the three shapes an
 * accessor-bearing dynamic value takes, recursively so chains flow:
 *  - an identifier recorded in `jsonValueBindings`;
 *  - `<r>.value` where `r` is a `ParseResult<JsonValue>` binding;
 *  - a `.get(…)` / `.at(…)` call whose receiver is itself a `JsonValue` (both
 *    accessors return an owned `JsonValue`, so `r.value.get("a").get("b")` chains).
 * Drives both the binding-annotation exemption and the accessor-method routing.
 */
export function isJsonValueExpr(e: Expression, analysis: ModuleAnalysis): boolean {
  if (e.type === "Identifier") {
    return analysis.jsonValueBindings.has((e as Identifier).name);
  }
  if (e.type === "MemberExpression") {
    const m = e as MemberExpression;
    return (
      !m.computed &&
      m.property.type === "Identifier" &&
      (m.property as Identifier).name === "value" &&
      m.object.type === "Identifier" &&
      analysis.parseResultBindings.get((m.object as Identifier).name)?.kind ===
        "jsonValue"
    );
  }
  if (e.type === "CallExpression") {
    const callee = (e as CallExpression).callee;
    if (
      callee.type === "MemberExpression" &&
      !(callee as MemberExpression).computed &&
      (callee as MemberExpression).property.type === "Identifier"
    ) {
      const mn = ((callee as MemberExpression).property as Identifier).name;
      return (
        (mn === "get" || mn === "at") &&
        isJsonValueExpr((callee as MemberExpression).object, analysis)
      );
    }
  }
  return false;
}

/** Is `e` a method call on a recorded rng handle (`r.next/int/pick/shuffle(...)`,
 * series 089)? Such an init is typed by construction (Rust infers the method's
 * return), so it is exempt from the binding-annotation gate. */
export function isRngMethodInit(e: Expression, analysis: ModuleAnalysis): boolean {
  if (e.type !== "CallExpression") return false;
  const callee = (e as CallExpression).callee;
  return (
    callee.type === "MemberExpression" &&
    (callee as MemberExpression).object.type === "Identifier" &&
    analysis.rngBindings.has(
      ((callee as MemberExpression).object as Identifier).name,
    )
  );
}

/**
 * The `RustType` an `@ttr/std` I/O intrinsic binding holds (series 100), peeling
 * the `try`/`await` wrappers off the lowered init: `readDir`/`args` →
 * `Vec<String>`, `env`/`readLine` → `Option<String>`, `readFile`/`readStdin` →
 * `String`. Returns `null` for a non-I/O (or void) init. Fed to `bindingTypes`
 * for method dispatch; the `let` type is still Rust-inferred.
 */
export function ioBindingRustType(init: HirExpr): RustType | null {
  let e: HirExpr = init;
  if (e.kind === "try") e = e.expr;
  if (e.kind === "await") e = e.expr;
  if (e.kind !== "call") return null;
  switch (e.callee) {
    case "tslib::io::read_dir":
    case "tslib::io::read_dir_async":
    case "tslib::io::args":
      return { kind: "vec", elem: { kind: "String" } };
    case "tslib::io::env":
    case "tslib::io::read_line":
      return { kind: "option", inner: { kind: "String" } };
    case "tslib::io::read_file":
    case "tslib::io::read_stdin":
    case "tslib::io::read_file_async":
      return { kind: "String" };
    default:
      return null;
  }
}

/** Is `e` a direct call to an `@ttr/std` I/O intrinsic that already returns an
 * `Option` (`env`/`readLine`, series 100)? Used to skip the Option re-wrap on a
 * reassignment (the value is Option by construction). */
export function isOptionReturningIoCall(e: Expression, analysis: ModuleAnalysis): boolean {
  if (e.type !== "CallExpression") return false;
  const callee = (e as CallExpression).callee;
  if (callee.type !== "Identifier") return false;
  const intr = analysis.stdShim.get((callee as Identifier).name);
  return intr === "env" || intr === "readLine";
}

/**
 * Is `obj` a `Writer` receiver (series 100) — a recorded `writerBindings` local
 * (`const w = stdout(); w.write(...)`) OR a direct `stdout()`/`stderr()` shim
 * call (the chained `stderr().writeLine(...)` form). Both route a `.write`/
 * `.writeLine`/`.flush` to the handle surface.
 */
export function isWriterReceiver(obj: Expression, analysis: ModuleAnalysis): boolean {
  if (
    obj.type === "Identifier" &&
    analysis.writerBindings.has((obj as Identifier).name)
  ) {
    return true;
  }
  if (obj.type === "CallExpression") {
    const callee = (obj as CallExpression).callee;
    if (callee.type === "Identifier") {
      const intr = analysis.stdShim.get((callee as Identifier).name);
      return intr === "stdout" || intr === "stderr";
    }
  }
  return false;
}

/**
 * Is `e` an `@ttr/std` I/O intrinsic init (series 100) — a flat sync I/O call
 * (`readFile(p)`, `env(n)`, `stdout()`, …) or an `await fsAsync.<m>(...)` /
 * `await http.<m>(...)`? Such a binding is typed by construction (the `tslib`
 * return type; Rust infers it — a `Writer`/`HttpResponse`/`String`/`Vec`/
 * `Option`), so it is exempt from the binding-annotation gate, like the rng /
 * parseJson exemptions.
 */
export function isStdIoInit(e: Expression, analysis: ModuleAnalysis): boolean {
  let node: Expression = e;
  if (node.type === "AwaitExpression") {
    node = (node as unknown as { argument: Expression }).argument;
  }
  if (!node || node.type !== "CallExpression") return false;
  const callee = (node as CallExpression).callee;
  if (callee.type === "MemberExpression") {
    const obj = (callee as MemberExpression).object;
    return (
      obj.type === "Identifier" &&
      analysis.ioAsyncNamespaces.has((obj as Identifier).name)
    );
  }
  if (callee.type === "Identifier") {
    const intr = analysis.stdShim.get((callee as Identifier).name);
    return intr !== undefined && STD_IO_TARGETS[intr] !== undefined;
  }
  return false;
}
