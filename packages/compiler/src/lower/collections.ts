/**
 * Lowering: JS collection & date construction — `new Map`/`new Set`/`new Date`,
 * the generic `new` dispatch, and `Object.keys`/`values` statics (series 041,
 * 060/061 Map/Set, 102 Date). Extracted from the lowering monolith (series 109);
 * the core lowerers and key helpers are imported from `./index`.
 */

import type { ModuleAnalysis } from "../analysis";
import type {
  ArrayExpression,
  CallExpression,
  Expression,
  Identifier,
  Literal,
  MemberExpression,
  NewExpression,
  ObjectExpression,
  TSType,
} from "../ast";
import { UnsupportedError } from "../errors";
import type { HirArg, HirExpr, MapBuildPart, RustType } from "../hir";
import {
  lowerExpr,
  lowerKey,
  lowerMapKeyType,
  lowerType,
  retargetStructKey,
  wrapKey,
} from "./index";
import { lowerRegexValue, regexLiteralInfo } from "./regex";
import { rustStrLit } from "./utils";

/**
 * Lower a static call on the global `Object` (series 041). `keys`/`values` map
 * to a native iteration of the `IndexMap`-backed record (insertion order matches
 * JS); everything else — `entries` (needs pair-array access) and `assign` (merge
 * + variadic sources) included — is fail-loud, a tracked residual.
 */
export function lowerObjectStatic(
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
export function mapBuildParts(
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

/**
 * The `RustType` of a scalar literal in a key/element position (series 072). A
 * `number` in a `Map`/`Set` *key* is `OrderedFloat`; a value `number` is `f64`
 * (via `asKey`). Mirrors the 061 key policy so a literal-inferred type agrees with
 * an explicit `<K,V>`. Non-scalar-literal elements (a nested struct literal, a
 * call, …) are un-inferable here → fail-loud (write explicit type args).
 */
export function scalarKeyElemType(e: Expression, asKey: boolean): RustType {
  if (e.type === "Literal") {
    const v = (e as Literal).value;
    if (typeof v === "string") return { kind: "String" };
    if (typeof v === "boolean") return { kind: "bool" };
    if (typeof v === "number") return asKey ? { kind: "orderedFloat" } : { kind: "f64" };
  }
  throw new UnsupportedError({
    type: "new Map/Set initializer element type is not a scalar literal (write explicit `<K, V>` / `<T>`)",
  });
}

/**
 * Lower `new Map()` / `new Map<K,V>()` / `new Map([...])` / `new Map(entries)`
 * (series 061 empty + series 072 non-empty). Explicit `<K,V>` is honored; an
 * un-annotated non-empty literal infers key/value from its first pair (Fork B).
 * A literal array of `[k, v]` pairs emits `IndexMap::<K,V>::from([...])` with each
 * key `wrapKey`-wrapped inline; an `Array<T>`-typed variable emits an
 * `.into_iter()…collect()` (Fork A2). A tuple-array variable (`Array<[K,V]>`) is
 * fail-loud — `TSTupleType` is outside the accepted dialect surface.
 */
export function lowerMapNew(expr: NewExpression, analysis: ModuleAnalysis): HirExpr {
  const targs = (expr as { typeArguments?: { params?: TSType[] } })
    .typeArguments?.params;
  const arg = expr.arguments[0] as Expression | undefined;

  // Empty construction (series 061): explicit `<K,V>` required.
  if (arg === undefined) {
    const [k, v] = targs ?? [];
    if (!k || !v) {
      throw new UnsupportedError({
        type: "new Map() without explicit type arguments (write `new Map<K, V>()`)",
      });
    }
    const map: HirExpr = {
      kind: "mapNew",
      key: lowerMapKeyType(k, analysis.structs),
      value: lowerType(v, analysis.structs),
    };
    // An f64-bearing struct key (series 074) keys on its `<Struct>Key` newtype.
    retargetStructKey(map, analysis.structKeyStructs);
    return map;
  }

  // Literal path: `new Map([[k, v], …])`. Key/value from `<K,V>` if written, else
  // inferred from the first pair. Keys are wrapped inline (061 policy).
  if (arg.type === "ArrayExpression") {
    const pairs = (arg as ArrayExpression).elements;
    let key: RustType;
    let value: RustType;
    if (targs?.[0] && targs?.[1]) {
      key = lowerMapKeyType(targs[0], analysis.structs);
      value = lowerType(targs[1], analysis.structs);
    } else {
      const first = pairs[0];
      if (!first || first.type !== "ArrayExpression") {
        throw new UnsupportedError({
          type: "new Map([]) without explicit type arguments (element type un-inferable — write `new Map<K, V>()`)",
        });
      }
      const [fk, fv] = (first as ArrayExpression).elements;
      if (!fk || !fv) {
        throw new UnsupportedError({
          type: "new Map([...]) initializer pair is not a `[key, value]` literal",
        });
      }
      key = scalarKeyElemType(fk as Expression, true);
      value = scalarKeyElemType(fv as Expression, false);
    }
    const entries = pairs.map((p) => {
      if (!p || p.type !== "ArrayExpression") {
        throw new UnsupportedError({
          type: "new Map([...]) initializer element is not a `[key, value]` pair literal",
        });
      }
      const [k, v] = (p as ArrayExpression).elements;
      if (!k || !v) {
        throw new UnsupportedError({
          type: "new Map([...]) initializer pair is not a `[key, value]` literal",
        });
      }
      return {
        key: wrapKey(lowerExpr(k as Expression, analysis), key),
        value: lowerExpr(v as Expression, analysis),
      };
    });
    const map: HirExpr = {
      kind: "mapNew",
      key,
      value,
      init: { kind: "literal", entries },
    };
    retargetStructKey(map, analysis.structKeyStructs);
    return map;
  }

  // The Map variable path needs `Array<[K,V]>` element typing; `TSTupleType` is
  // unmodeled dialect surface, so a variable/expression Map initializer stays
  // fail-loud (the Set `Array<T>` variable path below succeeds). Also catches a
  // non-array arg (another `Map`, `Object.entries()`, an iterator).
  throw new UnsupportedError({
    type: "new Map(<expr>) with a non-array-literal initializer (only `new Map([...])` is modeled; a tuple-array variable rides #37's open detail)",
  });
}

/**
 * Lower `new Set()` / `new Set<T>()` / `new Set([...])` / `new Set(items)` (series
 * 061 empty + series 072 non-empty). Mirrors `lowerMapNew`: explicit `<T>` or
 * first-element inference; a literal emits `IndexSet::<T>::from([...])` (elems
 * `wrapKey`-wrapped inline); an `Array<T>`-typed variable emits
 * `.into_iter()[.map(wrap)].collect::<IndexSet<T>>()`.
 */
export function lowerSetNew(expr: NewExpression, analysis: ModuleAnalysis): HirExpr {
  const targs = (expr as { typeArguments?: { params?: TSType[] } })
    .typeArguments?.params;
  const arg = expr.arguments[0] as Expression | undefined;

  // Empty construction (series 061): explicit `<T>` required.
  if (arg === undefined) {
    const [e] = targs ?? [];
    if (!e) {
      throw new UnsupportedError({
        type: "new Set() without an explicit type argument (write `new Set<T>()`)",
      });
    }
    const set: HirExpr = { kind: "setNew", elem: lowerMapKeyType(e, analysis.structs) };
    retargetStructKey(set, analysis.structKeyStructs);
    return set;
  }

  // Literal path: `new Set([x, …])`. Element from `<T>` if written, else inferred
  // from the first element; each element wrapped inline (061 policy).
  if (arg.type === "ArrayExpression") {
    const els = (arg as ArrayExpression).elements;
    let elem: RustType;
    if (targs?.[0]) {
      elem = lowerMapKeyType(targs[0], analysis.structs);
    } else {
      const first = els[0];
      if (!first) {
        throw new UnsupportedError({
          type: "new Set([]) without an explicit type argument (element type un-inferable — write `new Set<T>()`)",
        });
      }
      elem = scalarKeyElemType(first as Expression, true);
    }
    const elems = els.map((x) => {
      if (!x) {
        throw new UnsupportedError({ type: "new Set([...]) with a hole element" });
      }
      return wrapKey(lowerExpr(x as Expression, analysis), elem);
    });
    const set: HirExpr = {
      kind: "setNew",
      elem,
      init: { kind: "literal", elems },
    };
    retargetStructKey(set, analysis.structKeyStructs);
    return set;
  }

  // Variable/array-expression path (Fork A2): `new Set(items)` where `items` is an
  // `Array<T>` binding — `bindingTypes` types it as a `vec`, whose `elem` seeds the
  // `IndexSet<T>`. A scalar-number elem is `OrderedFloat`-wrapped in a `.map`
  // closure; every other elem collects directly. A non-array binding is fail-loud.
  if (arg.type === "Identifier") {
    const bound = analysis.bindingTypes.get((arg as Identifier).name);
    if (bound?.kind === "vec") {
      const elem = keyElemFromVecElem(bound.elem);
      const set: HirExpr = {
        kind: "setNew",
        elem,
        init: {
          kind: "iter",
          source: lowerExpr(arg, analysis),
          wrapElem: elem.kind === "orderedFloat",
        },
      };
      retargetStructKey(set, analysis.structKeyStructs);
      return set;
    }
  }
  throw new UnsupportedError({
    type: "new Set(<expr>) with a non-array-literal / non-`Array<T>`-variable initializer",
  });
}

/**
 * A `Vec` element type reinterpreted as a `Set` element (series 072): a `Vec`
 * value-position `f64` is a hashable-position `OrderedFloat` (the 061 key policy).
 * Every other element type carries through unchanged.
 */
export function keyElemFromVecElem(vecElem: RustType): RustType {
  return vecElem.kind === "f64" ? { kind: "orderedFloat" } : vecElem;
}

/**
 * JS `Date` accessor → the `tslib::date::Date` snake_case method (series 102).
 * The short local accessors alias their `getUTC*` twin (UTC-normalized). All are
 * `&self` and take no args; `toJSON` aliases `toISOString`.
 */
export const DATE_METHODS: Record<string, string> = {
  getTime: "get_time",
  getFullYear: "get_full_year",
  getUTCFullYear: "get_full_year",
  getMonth: "get_month",
  getUTCMonth: "get_month",
  getDate: "get_date",
  getUTCDate: "get_date",
  getDay: "get_day",
  getUTCDay: "get_day",
  getHours: "get_hours",
  getUTCHours: "get_hours",
  getMinutes: "get_minutes",
  getUTCMinutes: "get_minutes",
  getSeconds: "get_seconds",
  getUTCSeconds: "get_seconds",
  getMilliseconds: "get_milliseconds",
  getUTCMilliseconds: "get_milliseconds",
  getTimezoneOffset: "get_timezone_offset",
  toISOString: "to_iso_string",
  toJSON: "to_iso_string",
  toDateString: "to_date_string",
};

/** The strict ISO-8601 forms `new Date(str)` accepts — else fail-loud (series 102). */
export const STRICT_ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z)?$/;

/**
 * A `clock(epochMs)` handle expression (series 102): a `clockBindings` identifier
 * or a direct `clock(...)` std-shim call (recognized by specifier, so an aliased
 * import routes too). Used to type a `.date()` bridge + route handle methods.
 */
export function isClockExpr(
  expr: Expression | null,
  analysis: ModuleAnalysis,
): boolean {
  if (!expr) return false;
  if (expr.type === "Identifier") {
    return analysis.clockBindings.has((expr as Identifier).name);
  }
  if (expr.type === "CallExpression") {
    const callee = (expr as CallExpression).callee;
    return (
      callee.type === "Identifier" &&
      analysis.stdShim.get((callee as Identifier).name) === "clock"
    );
  }
  return false;
}

/**
 * A `Date`-typed expression (series 102): a `new Date(...)`, a `dateBindings`
 * identifier, or a `clock(...).date()` bridge. Date methods route by the receiver
 * satisfying this, so both the direct `new Date(x).getTime()` and the bound
 * `const d = new Date(x); d.getTime()` forms work.
 */
export function isDateExpr(
  expr: Expression | null,
  analysis: ModuleAnalysis,
): boolean {
  if (!expr) return false;
  if (expr.type === "NewExpression") {
    const c = (expr as NewExpression).callee;
    return c.type === "Identifier" && (c as Identifier).name === "Date";
  }
  if (expr.type === "Identifier") {
    return analysis.dateBindings.has((expr as Identifier).name);
  }
  if (expr.type === "CallExpression") {
    const callee = (expr as CallExpression).callee;
    return (
      callee.type === "MemberExpression" &&
      !(callee as MemberExpression).computed &&
      (callee as MemberExpression).property.type === "Identifier" &&
      ((callee as MemberExpression).property as Identifier).name === "date" &&
      isClockExpr((callee as MemberExpression).object, analysis)
    );
  }
  return false;
}

/**
 * `new Date(...)` (series 102) → the `tslib::date::Date` constructor, routed by
 * arg count/shape: no-arg (ambient wall-clock read) → fail-loud, redirect to
 * `clock`; one `string`-literal → `parse_iso` (a non-strict-ISO literal is
 * fail-loud); one `number` (or any non-string-literal expr) → `from_epoch_ms`;
 * ≥2 → the 0-based-month calendar `from_parts` (JS defaults: day=1, rest 0).
 */
export function lowerDateNew(expr: NewExpression, analysis: ModuleAnalysis): HirExpr {
  const args = expr.arguments;
  if (args.length === 0) {
    throw new UnsupportedError({
      type: 'no-arg `new Date()` reads the host wall-clock (non-differential) — import `clock` from "@ttr/std" and call `clock(epochMs)` for an explicit, differential-stable instant',
    });
  }
  if (args.length === 1) {
    const a0 = args[0] as Expression;
    if (a0.type === "Literal" && typeof (a0 as Literal).value === "string") {
      const s = (a0 as Literal).value as string;
      if (!STRICT_ISO.test(s)) {
        throw new UnsupportedError({
          type: `\`new Date(${JSON.stringify(s)})\` is a loose date string — only strict RFC3339 (\`YYYY-MM-DDTHH:mm:ss.sssZ\`) or \`YYYY-MM-DD\` are accepted (JS \`Date.parse\` loose forms are implementation-defined and not modeled)`,
        });
      }
      return {
        kind: "call",
        callee: "tslib::date::Date::parse_iso",
        args: [{ borrow: "owned", expr: { kind: "raw", text: rustStrLit(s) } }],
      };
    }
    return {
      kind: "call",
      callee: "tslib::date::Date::from_epoch_ms",
      args: [{ borrow: "owned", expr: lowerExpr(a0, analysis) }],
    };
  }
  // ≥2 args → the calendar-field constructor. JS defaults: day=1, the rest 0.
  const defaults = ["0f64", "0f64", "1f64", "0f64", "0f64", "0f64", "0f64"];
  const parts: HirArg[] = [];
  for (let i = 0; i < 7; i++) {
    const argI = args[i];
    const e: HirExpr = argI
      ? lowerExpr(argI, analysis)
      : { kind: "raw", text: defaults[i] ?? "0f64" };
    parts.push({ borrow: "owned", expr: e });
  }
  return { kind: "call", callee: "tslib::date::Date::from_parts", args: parts };
}

/** `new C(args)` → `C::new(args)`. Constructor params are owned (args by value). */
export function lowerNew(expr: NewExpression, analysis: ModuleAnalysis): HirExpr {
  if (expr.callee.type !== "Identifier") {
    throw new UnsupportedError({ type: "new with a non-identifier callee" });
  }
  const className = (expr.callee as Identifier).name;
  // `new RegExp(pat[, flags])` (series 101) — a **string-literal** `pat` is
  // translated + validated at transpile time (same as a `/…/` literal); a
  // non-literal `pat` cannot be vetted against the Rust `regex` engine and is
  // fail-loud (sub-decision RE-PORT: never emit an un-vetted pattern).
  if (className === "RegExp") {
    const info = regexLiteralInfo(expr);
    if (info) return lowerRegexValue(info);
    throw new UnsupportedError({
      type: "a `RegExp` built from a non-literal pattern cannot be validated against the Rust `regex` engine — inline the pattern as a literal (`/…/`) so backreferences/lookaround are rejected at transpile time",
    });
  }
  // `new Date(...)` (series 102) — the deterministic instant algebra. No-arg /
  // loose-string forms fail loud inside `lowerDateNew`.
  if (className === "Date") return lowerDateNew(expr, analysis);
  // Explicit call-site type arguments `new Box<string>(x)` (series 081) — the
  // dialect is inference-only (rustc infers `T` from the ctor arg), so an explicit
  // arg is fail-loud. (`Map`/`Set` carry their own turbofish path below and are
  // excluded — their type args drive the collection element type, not a generic.)
  if (
    className !== "Map" &&
    className !== "Set" &&
    (expr as { typeArguments?: unknown }).typeArguments
  ) {
    throw new UnsupportedError({
      type: `explicit type arguments on \`new ${className}<…>(…)\` (construction is inference-only — drop the \`<…>\`; rustc infers T from the argument)`,
    });
  }
  // `new Map<K, V>()` / `new Set<T>()` (series 061) → an empty `IndexMap`/`IndexSet`
  // with a turbofish so an un-annotated binding still infers. A non-empty
  // initializer (`new Map([...])` / `new Set(items)`, series 072) carries an
  // `init` that emits `::from([...])` (literal) or `.into_iter()…collect()` (variable).
  if (className === "Map") return lowerMapNew(expr, analysis);
  if (className === "Set") return lowerSetNew(expr, analysis);
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
