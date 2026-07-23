/**
 * The "light typer": the shared expression-typing predicates the lowering pass
 * leans on to answer "what Rust type / shape is this expression?" without a full
 * type checker. `receiverTypeOf` (expr → `RustType`) is the core; hanging off it are
 * `optionExprType`, `structTypeOfOperand`, `paramTypeOfOperand`, the string-ness
 * predicates (`isStringExpr` / `isStringConcat` / `flattenConcat`), the truthiness
 * helpers (`truthyCond` / `needsTruthy`), operator-bound registration
 * (`registerOpBound` + the `JS_OP_TRAIT` table), and the string-method catalogs
 * (`STRING_METHOD_DEFERRED` / …). Imported by `expressions`, `statements`, `types`,
 * `method-routing`, and `closures`.
 *
 * Split out of `statements.ts` (series 109 Phase-2 / #94): these are expression
 * *typing*, not statement lowering — `statements.ts` only hosted them because the
 * Phase-1 cut kept them adjacent. Pure motion — byte-identical. The hubs they call
 * back into (`lowerExpr` / `elementTypeOf` from `./expressions`) arrive by the
 * established call-time cycle; regex-result typing from `./regex`, `peelNonNull`
 * from `./utils`.
 */

import type { ModuleAnalysis } from "../analysis";
import type {
  CallExpression,
  Expression,
  Identifier,
  Literal,
  MemberExpression,
} from "../ast";
import type { HirExpr, RustType } from "../hir";
import { elementTypeOf, lowerExpr } from "./expressions";
import { matchBindingName, regexResultTypeAst } from "./regex";
import { peelNonNull } from "./utils";

/**
 * The struct `RustType` of a comparison operand when it is a struct-typed binding
 * (series 047c) — resolved from `analysis.bindingTypes` (the 046/048 binding→type
 * pre-pass). Used only to upgrade a non-`PartialEq` struct `===` to a clean
 * `UnsupportedError`; a non-ident or non-struct operand returns null (default path).
 */
export function structTypeOfOperand(
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

/**
 * The named-struct type name of a destructuring source expression (series 067),
 * or null when the source is not a known named struct. An identifier resolves
 * through the 046/048 `bindingTypes` table (a `struct` present in `structFields`);
 * anything else (a call, member access, anonymous shape) returns null → fail-loud
 * at the caller. Mirrors the "named/statically-shaped only" boundary of 058/064.
 */
export function sourceStructName(
  e: Expression,
  analysis: ModuleAnalysis,
): string | null {
  if (e.type === "Identifier") {
    const t = analysis.bindingTypes.get((e as Identifier).name);
    if (t && t.kind === "struct" && analysis.structFields.has(t.name)) {
      return t.name;
    }
  }
  return null;
}

/**
 * The `Option<T>` type of an expression when it is provably optional (series 066),
 * else null. Resolves an identifier binding, an optional struct field, and the
 * `?? ` / narrowing sites keep the inner `T`. Used to (a) render an `Option` print
 * as `undefined`/`v`, (b) treat absence as falsy in truthiness, and (c) fail-loud
 * on an un-narrowed optional in a value position. A non-provable operand returns
 * null (the caller's default path), never a guess.
 */
export function optionExprType(
  e: Expression,
  analysis: ModuleAnalysis,
): Extract<RustType, { kind: "option" }> | null {
  // A first-match group access (series 101) → `Option<String>` (checked before the
  // generic MemberExpression block, which returns null for a computed / non-struct
  // member): a positional `m![i]` and a named `m!.groups!.name` both render via
  // `fmt_opt` and narrow through the 066 `=== undefined` machinery.
  if (e.type === "MemberExpression") {
    const me = e as MemberExpression;
    if (me.computed && matchBindingName(me.object, analysis)) {
      return { kind: "option", inner: { kind: "String" } };
    }
    if (!me.computed) {
      const groupsMember = peelNonNull(me.object);
      if (
        groupsMember.type === "MemberExpression" &&
        !(groupsMember as MemberExpression).computed &&
        (groupsMember as MemberExpression).property.type === "Identifier" &&
        ((groupsMember as MemberExpression).property as Identifier).name ===
          "groups" &&
        matchBindingName((groupsMember as MemberExpression).object, analysis)
      ) {
        return { kind: "option", inner: { kind: "String" } };
      }
    }
  }
  if (e.type === "Identifier") {
    const name = (e as Identifier).name;
    // A name narrowed in an enclosing `if let Some(name)` block is a plain `T` here.
    if (analysis.narrowedOptions.has(name)) return null;
    const t = analysis.bindingTypes.get(name);
    if (t?.kind === "option") return t;
    return null;
  }
  if (e.type === "MemberExpression") {
    const m = e as MemberExpression;
    if (m.computed) return null;
    const owner = memberOwnerStruct(m.object, analysis);
    if (!owner) return null;
    const field = (m.property as Identifier).name;
    const fty = analysis.structFields
      .get(owner)
      ?.find((f) => f.name === field)?.ty;
    return fty?.kind === "option" ? fty : null;
  }
  // A string `.at(i)` call → `Option<String>` (series 098), so a direct
  // `console.log(s.at(i))` renders via `fmt_opt` (`None` → `undefined`).
  if (e.type === "CallExpression" && isStringAtCall(e, analysis)) {
    return { kind: "option", inner: { kind: "String" } };
  }
  return null;
}

/**
 * Is `init` a string `.at(i)` call (series 098)? Typed by construction as
 * `Option<String>` — drives both the untyped-binding exemption and the binding-type
 * registration in `lowerVarDecl`, and the `optionExprType` recognizer.
 */
export function isStringAtCall(
  init: Expression | null,
  analysis: ModuleAnalysis,
): boolean {
  if (!init || init.type !== "CallExpression") return false;
  const callee = (init as CallExpression).callee;
  if (callee.type !== "MemberExpression" || (callee as MemberExpression).computed)
    return false;
  const cm = callee as MemberExpression;
  if (cm.property.type !== "Identifier" || (cm.property as Identifier).name !== "at")
    return false;
  if ((init as CallExpression).arguments.length !== 1) return false;
  return receiverTypeOf(cm.object as Expression, analysis)?.kind === "String";
}

/**
 * The generic-type-parameter type of an operand expression when it is provably a
 * bare `T` (series 081), else null. An identifier resolves through `bindingTypes`
 * (a method/fn param typed `T`, recorded `{kind:"param"}` by the scope-aware
 * `collectBindingTypes`). Drives the operator-on-`T` fail-loud guard. A non-`param`
 * operand returns null (the caller's default path), never a guess.
 */
export function paramTypeOfOperand(
  e: Expression,
  analysis: ModuleAnalysis,
): Extract<RustType, { kind: "param" }> | null {
  if (e.type === "Identifier") {
    const t = analysis.bindingTypes.get((e as Identifier).name);
    if (t?.kind === "param") return t;
    return null;
  }
  // A `this.<field>` (or `struct.<field>`) whose field is typed `T` (series 088):
  // the emission case `this.v + o` has a `param`-typed member operand.
  if (e.type === "MemberExpression") {
    const t = memberFieldType(e as MemberExpression, analysis);
    if (t?.kind === "param") return t;
  }
  return null;
}

/**
 * The tslib JS-operator trait + method for a binary operator over a same-`T` pair
 * (series 088), or null when the operator has no trait mapping (logical/bitwise/
 * compound — stays fail-loud). Arithmetic → `Js*`/`js_*`; ordering → `JsOrd`;
 * equality → `JsEq`. The trait path is fully-qualified (the emitted-Rust tslib
 * convention, `tslib::<module>::<item>`).
 */
export const JS_OP_TRAIT: Record<string, { trait: string; method: string } | undefined> =
  {
    "+": { trait: "tslib::ops::JsAdd", method: "js_add" },
    "-": { trait: "tslib::ops::JsSub", method: "js_sub" },
    "*": { trait: "tslib::ops::JsMul", method: "js_mul" },
    "/": { trait: "tslib::ops::JsDiv", method: "js_div" },
    "%": { trait: "tslib::ops::JsRem", method: "js_rem" },
    "<": { trait: "tslib::ops::JsOrd", method: "js_lt" },
    "<=": { trait: "tslib::ops::JsOrd", method: "js_le" },
    ">": { trait: "tslib::ops::JsOrd", method: "js_gt" },
    ">=": { trait: "tslib::ops::JsOrd", method: "js_ge" },
    "===": { trait: "tslib::ops::JsEq", method: "js_eq" },
    "!==": { trait: "tslib::ops::JsEq", method: "js_ne" },
  };

/**
 * Register a JS-operator trait bound on a class-level generic param (series 088):
 * `analysis.opBounds[name]` gains `trait`, merged onto the class's `GenericParam[]`
 * in `lowerClassBody`. Only class-level params carry an operator-bound slot.
 */
export function registerOpBound(
  analysis: ModuleAnalysis,
  name: string,
  trait: string,
): void {
  let set = analysis.opBounds.get(name);
  if (!set) {
    set = new Set();
    analysis.opBounds.set(name, set);
  }
  set.add(trait);
}

/**
 * The scalar `RustType` kind of an operand when statically known (series 066):
 * `bool` (literal / boolean binding), `f64`, `String`, or `option`. Null when the
 * kind can't be resolved. Drives the truthiness decision — a `bool` operand stays
 * native, a non-`bool` (or an `Option`) routes through `is_truthy`.
 */
function scalarKindOf(
  e: Expression,
  analysis: ModuleAnalysis,
): RustType["kind"] | null {
  switch (e.type) {
    case "Literal": {
      const v = (e as Literal).value;
      if (typeof v === "boolean") return "bool";
      if (typeof v === "number") return "f64";
      if (typeof v === "string") return "String";
      return null;
    }
    case "TemplateLiteral":
      return "String";
    case "Identifier":
      return analysis.bindingTypes.get((e as Identifier).name)?.kind ?? null;
    case "MemberExpression": {
      const opt = optionExprType(e, analysis);
      if (opt) return "option";
      if (isStringExpr(e, analysis)) return "String";
      return null;
    }
    case "BinaryExpression": {
      const op = (e as unknown as { operator: string }).operator;
      if (["===", "!==", "==", "!=", "<", ">", "<=", ">=", "in"].includes(op))
        return "bool";
      if (op === "+" && isStringExpr(e, analysis)) return "String";
      if (["-", "*", "/", "%"].includes(op)) return "f64";
      return null;
    }
    case "LogicalExpression":
      return null;
    case "UnaryExpression":
      return (e as unknown as { operator: string }).operator === "!"
        ? "bool"
        : "f64";
    default:
      return null;
  }
}

/**
 * Does an operand need the JS-truthiness helper at a `bool` position (series 066)?
 * A `bool`-typed operand stays native; a non-`bool` scalar / `Option` (a number,
 * string, or optional in an `if`/`!`/`||`/`&&` position) routes through
 * `is_truthy`. An *unknown* kind conservatively stays native (Rust will reject a
 * genuine non-`bool` at cargo — fail-loud, never a silent miscompile).
 */
export function needsTruthy(e: Expression, analysis: ModuleAnalysis): boolean {
  const k = scalarKindOf(e, analysis);
  return k !== null && k !== "bool";
}

/** Wrap a lowered condition operand in `is_truthy` when its source is non-`bool` (066). */
export function truthyCond(e: Expression, analysis: ModuleAnalysis): HirExpr {
  const lowered = lowerExpr(e, analysis);
  return needsTruthy(e, analysis) ? { kind: "isTruthy", value: lowered } : lowered;
}

/**
 * Is `e` provably a string (series 080)? Used to detect a string `+` concat. Only
 * returns true when the type is known to be `String`; an unknown operand (e.g. a
 * method call — no return-type table) returns false, so a numeric `+` is never
 * misclassified. `string + anything` concatenates in JS, so one provable-string
 * operand is sufficient to classify the whole `+`.
 */
/**
 * The `RustType` of a `this.field` / `local.field` non-computed member access via
 * `structFields`, or null (series 083, factored out of `isStringExpr`'s member
 * case). No oracle — that is `receiverTypeOf`'s Tier-3.
 */
function memberFieldType(
  m: MemberExpression,
  analysis: ModuleAnalysis,
): RustType | null {
  if (m.computed || m.property.type !== "Identifier") return null;
  const field = (m.property as Identifier).name;
  const owner = memberOwnerStruct(m.object, analysis);
  if (!owner) return null;
  return (
    analysis.structFields.get(owner)?.find((f) => f.name === field)?.ty ?? null
  );
}

/**
 * The `RustType` of an arbitrary receiver expression, or null — the **single**
 * receiver-type resolver (series 083, unifying the scattered lookups). Three
 * tiers, cheapest first; the oracle is consulted only when the hand-rolled tables
 * miss, so every receiver they already resolve keeps its exact current path
 * (byte-for-byte, no oracle drift) and the oracle only ever turns a
 * previously-null answer into a resolution.
 */
export function receiverTypeOf(
  expr: Expression,
  analysis: ModuleAnalysis,
): RustType | null {
  // An rng handle `.shuffle(arr)` (series 089) returns a fresh `Vec<T>` whose `T`
  // is the source array's element type — so a chained `.join(",")` routes through
  // the `vec` gate (the `noLib` oracle can't type a built-in method's return, so
  // this is resolved structurally, like the String-returning-method cases below).
  if (
    expr.type === "CallExpression" &&
    (expr as CallExpression).callee.type === "MemberExpression"
  ) {
    const cm = (expr as CallExpression).callee as MemberExpression;
    if (
      cm.object.type === "Identifier" &&
      analysis.rngBindings.has((cm.object as Identifier).name) &&
      cm.property.type === "Identifier" &&
      (cm.property as Identifier).name === "shuffle"
    ) {
      const arg = (expr as CallExpression).arguments[0];
      if (arg) {
        return { kind: "vec", elem: elementTypeOf(arg as Expression, analysis) };
      }
    }
  }
  // `@ttr/std` I/O intrinsics returning `Vec<String>` (series 100): a chained
  // `.join(",")` on `args()` / `readDir(p)` routes through the `vec` gate (the
  // oracle can't type the shim return, so it is resolved structurally here).
  if (
    expr.type === "CallExpression" &&
    (expr as CallExpression).callee.type === "Identifier"
  ) {
    const intr = analysis.stdShim.get(
      ((expr as CallExpression).callee as Identifier).name,
    );
    if (intr === "args" || intr === "readDir") {
      return { kind: "vec", elem: { kind: "String" } };
    }
  }
  // A non-null assertion `x!` (series 066/101): its type is the unwrapped inner of
  // an `Option<T>` binding — so `all!.join(",")` / `all!.length` (the `Option<Vec>`
  // from `s.match(/…/g)`) route through the `vec` gate. Only the identifier-binding
  // case is resolved here (structurally, no oracle needed).
  if (expr.type === "TSNonNullExpression") {
    const inner = (expr as unknown as { expression: Expression }).expression;
    if (inner.type === "Identifier") {
      const t = analysis.bindingTypes.get((inner as Identifier).name);
      if (t?.kind === "option") return t.inner;
    }
    // An inline `s.match(re)!` (series 101) — unwrap the `Option<Vec<String>>` so
    // a chained `.join(",")` routes through the `vec` gate to `tslib::array::join`.
    const rt = regexResultTypeAst(inner, analysis);
    if (rt?.kind === "option") return rt.inner;
  }
  // Tier 1 — bare identifier → bindingTypes (the fast, pre-082 path).
  if (expr.type === "Identifier") {
    const name = (expr as Identifier).name;
    const t = analysis.bindingTypes.get(name);
    if (t) {
      // A binding narrowed inside an `if let Some(x)` block is its inner `T` here
      // (series 098) — so a method call on the narrowed value routes by the
      // unwrapped type (`last.toUpperCase()` sees `String`, not `Option<String>`).
      if (t.kind === "option" && analysis.narrowedOptions.has(name)) return t.inner;
      return t;
    }
  }
  // Tier 2 — `this.field` / `local.field` → structFields (no oracle needed).
  if (expr.type === "MemberExpression") {
    const t = memberFieldType(expr as MemberExpression, analysis);
    if (t) return t;
  }
  // Tier 3 — any shape (getX(), a.b.c, index chains) → the 082 oracle. Slice 3
  // lifts the annotation-only restriction here: the classifier still maps only to
  // modeled types, so an unmodeled receiver stays null → fail-loud.
  const span = expr as unknown as { start?: number; end?: number };
  if (
    analysis.typeOracle &&
    span.start !== undefined &&
    span.end !== undefined
  ) {
    return analysis.typeOracle.typeAtSpan_rustType(span.start, span.end);
  }
  return null;
}

function isStringExpr(e: Expression, analysis: ModuleAnalysis): boolean {
  switch (e.type) {
    case "Literal":
      return typeof (e as Literal).value === "string";
    case "TemplateLiteral":
      return true;
    case "BinaryExpression": {
      const b = e as { operator: string; left: Expression; right: Expression };
      return (
        b.operator === "+" &&
        (isStringExpr(b.left, analysis) || isStringExpr(b.right, analysis))
      );
    }
    // A call to a modeled String-returning method on a String receiver (series
    // 083) — `s.toUpperCase()`, `s.trim()`, `s.slice(..)` — is a string, so
    // `a.toUpperCase() + b.toUpperCase()` is detected as concat (#48). The oracle
    // is `noLib` and can't type a built-in method's *return*, so this is resolved
    // structurally here rather than via Tier-3.
    case "CallExpression": {
      const call = e as CallExpression;
      const callee = call.callee;
      if (callee.type === "MemberExpression" && !(callee as MemberExpression).computed) {
        const cm = callee as MemberExpression;
        if (cm.property.type === "Identifier") {
          const method = (cm.property as Identifier).name;
          if (
            STRING_RETURNING_STRING_METHODS.has(method) &&
            receiverTypeOf(cm.object as Expression, analysis)?.kind === "String"
          ) {
            return true;
          }
          // `n.toString()` / `n.toFixed(..)` on a number → a String too.
          if (
            NUMBER_RETURNING_STRING_METHODS.has(method) &&
            receiverTypeOf(cm.object as Expression, analysis)?.kind === "f64"
          ) {
            return true;
          }
        }
      }
      return receiverTypeOf(e, analysis)?.kind === "String";
    }
    // Identifier + member cases delegate to the unified `receiverTypeOf`, which
    // adds the oracle tier for free (so `getName().toUpperCase()` sees a string).
    default:
      return receiverTypeOf(e, analysis)?.kind === "String";
  }
}

/** String methods (series 083) whose Rust target returns a `String`. */
const STRING_RETURNING_STRING_METHODS = new Set([
  "toString",
  "toUpperCase",
  "toLowerCase",
  "trim",
  "trimStart",
  "trimEnd",
  "repeat",
  "replace",
  "replaceAll",
  "slice",
  "substring",
  "charAt",
  // series 098
  "substr",
  "concat",
  "padStart",
  "padEnd",
]);

/**
 * Deferred `String.prototype` surface (series 098) — for a `String` receiver
 * these throw a clean transpiler fail-loud (with the reason) instead of falling
 * through to a native `s.method(...)` emit rustc then rejects. The UTF-16 fork
 * (`charCodeAt`/`codePointAt`) is deferred per the campaign's "non-index-first"
 * direction; RegExp and locale ops are Tier-3 / unmodeled.
 */
export const STRING_METHOD_DEFERRED: Record<string, string | undefined> = {
  charCodeAt:
    "`.charCodeAt` uses UTF-16 code units (deferred) — use `.charAt(i)` / `.at(i)` for a character",
  codePointAt:
    "`.codePointAt` uses UTF-16 code points (deferred) — use `.charAt(i)` / `.at(i)` for a character",
  match: "`.match` needs RegExp (deferred, Tier 3)",
  matchAll: "`.matchAll` needs RegExp (deferred, Tier 3)",
  search: "`.search` needs RegExp (deferred, Tier 3)",
  localeCompare:
    "`.localeCompare` — locale-aware string ordering is not modeled",
  normalize: "`.normalize` — Unicode normalization is not modeled",
  toLocaleUpperCase:
    "`.toLocaleUpperCase` — locale-aware casing is not modeled (use `.toUpperCase`)",
  toLocaleLowerCase:
    "`.toLocaleLowerCase` — locale-aware casing is not modeled (use `.toLowerCase`)",
};

/** Number methods (series 083) whose Rust target returns a `String`. */
const NUMBER_RETURNING_STRING_METHODS = new Set([
  "toString",
  "toFixed",
]);

/** The struct name owning a member receiver: `this` → current class; a named binding → its struct type (series 080). */
function memberOwnerStruct(
  object: Expression,
  analysis: ModuleAnalysis,
): string | null {
  if (object.type === "ThisExpression") return analysis.currentClass ?? null;
  if (object.type === "Identifier") {
    const t = analysis.bindingTypes.get((object as Identifier).name);
    if (t?.kind === "struct" && analysis.structFields.has(t.name)) return t.name;
  }
  return null;
}

/** A `+` BinaryExpression that is a string concatenation (series 080). */
export function isStringConcat(
  b: { operator: string; left: Expression; right: Expression },
  analysis: ModuleAnalysis,
): boolean {
  return isStringExpr(b.left, analysis) || isStringExpr(b.right, analysis);
}

/**
 * Flatten a string-concat `+` into ordered operand expressions (series 080).
 * Descends only into `+` children that are *themselves* string concats, so a
 * parenthesized numeric subtree (`"x" + (a + b)`) stays a single arithmetic part.
 */
export function flattenConcat(e: Expression, analysis: ModuleAnalysis): Expression[] {
  if (e.type === "BinaryExpression") {
    const b = e as unknown as {
      operator: string;
      left: Expression;
      right: Expression;
    };
    if (b.operator === "+" && isStringConcat(b, analysis)) {
      return [
        ...flattenConcat(b.left, analysis),
        ...flattenConcat(b.right, analysis),
      ];
    }
  }
  return [e];
}
