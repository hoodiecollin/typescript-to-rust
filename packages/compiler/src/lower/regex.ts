/**
 * RegExp dispatch (series 101, epic #56): recognizing statically-known regex
 * values, typing their results by construction, and routing the regex-taking
 * string/RegExp methods to `tslib::regex`. Extracted from the lowering monolith
 * (series 109); `lowerExpr` is imported back from the orchestrator.
 */

import type { ModuleAnalysis } from "../analysis";
import type {
  CallExpression,
  Expression,
  Identifier,
  Literal,
  MemberExpression,
  NewExpression,
} from "../ast";
import { UnsupportedError } from "../errors";
import type { HirExpr, RustType } from "../hir";
import { translateRegex, translateReplacement } from "../regex-translate";
import { lowerExpr } from "./expressions";
import { peelNonNull, refExpr, rustStrLit } from "./utils";

/**
 * The `{pattern, flags}` of a **statically-known** regex value — a `/pat/flags`
 * literal, or `new RegExp("lit"[, "flags"])` with a string-literal pattern. `null`
 * for a non-regex expression (a `new RegExp(runtimeVar)` is handled in `lowerNew`).
 */
export function regexLiteralInfo(
  e: Expression,
): { pattern: string; flags: string } | null {
  if (e.type === "Literal" && (e as Literal).regex) {
    return (e as Literal).regex ?? null;
  }
  if (e.type === "NewExpression") {
    const n = e as NewExpression;
    if (
      n.callee.type === "Identifier" &&
      (n.callee as Identifier).name === "RegExp"
    ) {
      const p = n.arguments[0];
      if (p && p.type === "Literal" && typeof (p as Literal).value === "string") {
        const f = n.arguments[1];
        const flags =
          f && f.type === "Literal" && typeof (f as Literal).value === "string"
            ? ((f as Literal).value as string)
            : "";
        return { pattern: (p as Literal).value as string, flags };
      }
    }
  }
  return null;
}

/** Lower a statically-known regex value to `tslib::regex::Regex::new_lit(pat, g)`. */
export function lowerRegexValue(info: { pattern: string; flags: string }): HirExpr {
  const t = translateRegex(info.pattern, info.flags);
  return {
    kind: "call",
    callee: "tslib::regex::Regex::new_lit",
    args: [
      { borrow: "owned", expr: { kind: "raw", text: rustStrLit(t.rustPattern) } },
      { borrow: "owned", expr: { kind: "bool", value: t.global } },
    ],
  };
}

/**
 * The JS `g` (global) flag of a regex-valued expression — a `/…/` literal, a
 * `new RegExp(...)`, or an identifier bound to a regex (`regexBindings`). `null`
 * when the expression is **not** a regex value (so a `.split`/`.replace` with a
 * string argument falls through to the plain string-method path).
 */
export function regexArgGlobal(e: Expression, analysis: ModuleAnalysis): boolean | null {
  const info = regexLiteralInfo(e);
  if (info) return info.flags.includes("g");
  if (
    e.type === "Identifier" &&
    analysis.regexBindings.has((e as Identifier).name)
  ) {
    return analysis.regexBindings.get((e as Identifier).name)?.global ?? false;
  }
  return null;
}

/** Is `e` a regex value (literal, `new RegExp`, or a `regexBindings` identifier)? */
export function isRegexValueExpr(e: Expression, analysis: ModuleAnalysis): boolean {
  return regexArgGlobal(e, analysis) !== null;
}

/** Lower a regex value to the Rust **receiver** of a `tslib::regex::Regex` method
 *  — a literal/`new` inlines its `new_lit(...)`; a binding lowers to its name. */
export function lowerRegexReceiver(e: Expression, analysis: ModuleAnalysis): HirExpr {
  const info = regexLiteralInfo(e);
  if (info) return lowerRegexValue(info);
  return lowerExpr(e, analysis);
}

/** The Rust `Match` struct type (first-match result); an `Option<Match>` binding. */
export const REGEX_MATCH_TYPE: RustType = { kind: "struct", name: "tslib::regex::Match" };

/**
 * The by-construction `RustType` of a regex string/`exec` result (series 101),
 * gated on a genuine regex receiver/arg — used both to exempt the binding from the
 * annotation gate and to record its type (so `m![i]` / `all!.join` / the for-of
 * over `matchAll` route correctly). `null` for a non-regex call.
 */
export function regexResultTypeAst(
  e: Expression,
  analysis: ModuleAnalysis,
): RustType | null {
  if (e.type !== "CallExpression") return null;
  const callee = (e as CallExpression).callee;
  if (callee.type !== "MemberExpression") return null;
  const cm = callee as MemberExpression;
  if (cm.property.type !== "Identifier") return null;
  const method = (cm.property as Identifier).name;
  // `re.exec(s)` — receiver is a regex value → `Option<Match>`.
  if (method === "exec" && isRegexValueExpr(cm.object as Expression, analysis)) {
    return { kind: "option", inner: REGEX_MATCH_TYPE };
  }
  // `s.match/matchAll/split(re)` — string receiver, regex first argument.
  const reArg = (e as CallExpression).arguments[0] as Expression | undefined;
  if (!reArg) return null;
  const g = regexArgGlobal(reArg, analysis);
  if (g === null) return null;
  if (method === "match") {
    return g
      ? { kind: "option", inner: { kind: "vec", elem: { kind: "String" } } }
      : { kind: "option", inner: REGEX_MATCH_TYPE };
  }
  if (method === "split") return { kind: "vec", elem: { kind: "String" } };
  if (method === "matchAll") {
    return { kind: "vec", elem: { kind: "vec", elem: { kind: "String" } } };
  }
  return null;
}

/**
 * A regex-init binding (series 101) is typed by construction — no annotation
 * required (like `.find`/`.at`): a regex value itself, a match/`exec`/`split`
 * result, or a `test`/`search`/`replace` scalar result.
 */
export function isRegexInit(e: Expression | null, analysis: ModuleAnalysis): boolean {
  if (!e) return false;
  // `const all = s.match(/…/g)!` unwraps at the binding — peel the `!` so the
  // regex result is still recognized (typed `Vec<String>` by construction).
  const peeled = peelNonNull(e);
  if (isRegexValueExpr(peeled, analysis)) return true;
  if (regexResultTypeAst(peeled, analysis)) return true;
  if (peeled.type === "CallExpression") {
    const callee = (peeled as CallExpression).callee;
    if (
      callee.type === "MemberExpression" &&
      (callee as MemberExpression).property.type === "Identifier"
    ) {
      const cm = callee as MemberExpression;
      const method = (cm.property as Identifier).name;
      if (method === "test" && isRegexValueExpr(cm.object as Expression, analysis)) {
        return true;
      }
      const reArg = (peeled as CallExpression).arguments[0] as
        | Expression
        | undefined;
      if (
        reArg &&
        regexArgGlobal(reArg, analysis) !== null &&
        (method === "search" || method === "replace" || method === "replaceAll")
      ) {
        return true;
      }
    }
  }
  return false;
}

/** The bound name if `e` (through an optional `!`) is a first-match `matchBindings`
 *  identifier (an `Option<Match>` binding); else null. */
export function matchBindingName(e: Expression, analysis: ModuleAnalysis): string | null {
  const inner = peelNonNull(e);
  if (
    inner.type === "Identifier" &&
    analysis.matchBindings.has((inner as Identifier).name)
  ) {
    return (inner as Identifier).name;
  }
  return null;
}

/** `<name>.as_ref().unwrap()` — a **borrowing** unwrap of an `Option<Match>`
 *  binding, so repeated `m![i]` / `m!.groups!.n` access does not move `m`
 *  (`Match::get`/`group` take `&self`). */
export function matchBorrowUnwrap(name: string): HirExpr {
  return {
    kind: "method",
    receiver: {
      kind: "method",
      receiver: { kind: "ident", name },
      name: "as_ref",
      args: [],
    },
    name: "unwrap",
    args: [],
  };
}

/** The translated replacement arg of a regex `.replace`/`.replaceAll` — a string
 *  literal (so `$`-templates translate); a function replacer / non-literal is
 *  fail-loud (sub-decisions RE-FNREPL / literal-only). A raw `&str` HirExpr. */
export function regexReplArg(replExpr: Expression): HirExpr {
  if (
    replExpr.type === "ArrowFunctionExpression" ||
    replExpr.type === "FunctionExpression"
  ) {
    throw new UnsupportedError({
      type: "a function replacer in `.replace` is not modeled (v1) — use a string replacement template (`$1`, `$<name>`, `$&`)",
    });
  }
  if (
    replExpr.type !== "Literal" ||
    typeof (replExpr as Literal).value !== "string"
  ) {
    throw new UnsupportedError({
      type: "a regex `.replace` replacement must be a string literal so its `$`-templates translate at transpile time",
    });
  }
  const translated = translateReplacement((replExpr as Literal).value as string);
  return { kind: "raw", text: rustStrLit(translated) };
}

/**
 * Route a regex method call (series 101), or return `null` to fall through:
 *   - **receiver is a regex** → `re.test(s)` → `is_match`; `re.exec(s)` → `exec`.
 *   - **string receiver + regex argument** → the regex-taking string methods,
 *     with the receiver/argument **flipped** (`s.match(re)` → `re.captures(&s)`).
 * The regex is the Rust receiver; the string is passed by `&`. Called from
 * `lowerCall` before `tryPrimitiveMethod` so a regex arg wins over string routing.
 */
export function tryRegexMethod(
  methodName: string,
  m: MemberExpression,
  call: CallExpression,
  analysis: ModuleAnalysis,
): HirExpr | null {
  // Case A — the receiver is a regex value: `re.test` / `re.exec`.
  if (isRegexValueExpr(m.object as Expression, analysis)) {
    const receiver = lowerRegexReceiver(m.object as Expression, analysis);
    const arg = call.arguments[0] as Expression | undefined;
    if (methodName === "test" && arg) {
      return {
        kind: "method",
        receiver,
        name: "is_match",
        args: [refExpr(lowerExpr(arg, analysis))],
      };
    }
    if (methodName === "exec" && arg) {
      return {
        kind: "method",
        receiver,
        name: "exec",
        args: [refExpr(lowerExpr(arg, analysis))],
      };
    }
    throw new UnsupportedError({
      type: `\`.${methodName}\` on a RegExp — only \`.test(s)\` and a single \`.exec(s)\` are modeled (a stateful \`exec\` loop / \`.lastIndex\` is not — use \`s.matchAll(re)\`)`,
    });
  }
  // Case B — a string receiver with a regex first argument.
  const reArg = call.arguments[0] as Expression | undefined;
  if (!reArg) return null;
  const global = regexArgGlobal(reArg, analysis);
  if (global === null) return null; // not a regex arg → plain string method
  const receiver = lowerRegexReceiver(reArg, analysis);
  const strArg = refExpr(lowerExpr(m.object as Expression, analysis));
  const method = (name: string, extra: HirExpr[] = []): HirExpr => ({
    kind: "method",
    receiver,
    name,
    args: [strArg, ...extra],
  });
  switch (methodName) {
    case "match":
      // `g` → full matches (`find_all`, `Option<Vec<String>>`); no `g` → the
      // capture array (`captures`, `Option<Match>`).
      return method(global ? "find_all" : "captures");
    case "matchAll":
      // JS `matchAll` requires the `g` flag (TypeError otherwise) — mirror it.
      if (!global) {
        throw new UnsupportedError({
          type: "`s.matchAll(re)` requires the `g` flag on the regex (as in JS)",
        });
      }
      return method("captures_all");
    case "search":
      return method("search");
    case "split":
      return method("split");
    case "replace": {
      const repl = call.arguments[1] as Expression | undefined;
      if (!repl) return null;
      // `s.replace(re/g, r)` replaces all; a non-`g` regex replaces the first.
      return method(global ? "replace_all" : "replace_first", [regexReplArg(repl)]);
    }
    case "replaceAll": {
      const repl = call.arguments[1] as Expression | undefined;
      if (!repl) return null;
      // JS `replaceAll` requires the `g` flag on a regex arg (TypeError otherwise).
      if (!global) {
        throw new UnsupportedError({
          type: "`s.replaceAll(re, …)` requires the `g` flag on the regex (as in JS)",
        });
      }
      return method("replace_all", [regexReplArg(repl)]);
    }
    default:
      return null;
  }
}
