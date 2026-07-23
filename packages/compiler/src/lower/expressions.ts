/**
 * Expression lowering: the `lowerExpr` dispatch hub (the busiest lowerer — reached
 * by every sibling), the ~835-LOC `lowerCall` call hub, `lowerMember` member/method
 * dispatch, and the expression-level inference helpers that hang off them
 * (element/init/binding type inference, the generator-`next()` resolution machinery,
 * dynamic-field bookkeeping).
 *
 * Extracted from the `lower.ts` monolith (series 109, Phase 1) verbatim — no logic
 * change; the byte-identical corpus gate proves it. Shared statement-level lowerers
 * and typing predicates it leans on (`lowerStatements`, `lowerTyped`,
 * `receiverTypeOf`, `optionExprType`, …) come from `./statements`; `lowerType`/
 * `lowerCond` from `./types`; the orchestrator-owned helpers (`collectionOf`/
 * `wrapKey`/`tryHashMapInsert`) from `./index`.
 */

import type { ModuleAnalysis } from "../analysis";
import type {
  ArrayExpression,
  ArrowFunctionExpression,
  AwaitExpression,
  BlockStatement,
  CallExpression,
  Expression,
  Identifier,
  Literal,
  MemberExpression,
  NewExpression,
  Program,
  TSType,
} from "../ast";
import { isTypePartialEq } from "../derives";
import { UnsupportedError } from "../errors";
import type { Borrow, HirArg, HirExpr, HirStmt, RustType } from "../hir";
import { assertSpawnArgsSafe, lowerAwait, lowerSetTimeout } from "./async";
import { rootBaseOf, traitNameOf } from "./classes";
import { LIFT_ADAPTERS, liftCallback } from "./closures";
import {
  DATE_METHODS,
  isClockExpr,
  isDateExpr,
  lowerNew,
  lowerObjectStatic,
} from "./collections";
import { EMPTY_TYPE_PARAMS } from "./constants";
import {
  isJsonValueExpr,
  isOptionReturningIoCall,
  isWriterReceiver,
  JSON_VALUE_METHODS,
  lowerStdShimCall,
} from "./io-shim";
import {
  collectionOf,
  tryHashMapInsert,
  tryMapSetMethod,
  wrapKey,
} from "./index";
import {
  checkReadonlyAssign,
  flattenConcat,
  isStringConcat,
  JS_OP_TRAIT,
  lowerStatements,
  lowerTyped,
  needsTruthy,
  optionExprType,
  paramTypeOfOperand,
  receiverTypeOf,
  registerOpBound,
  structTypeOfOperand,
} from "./statements";
import { lowerCond, lowerMapKeyType, lowerType } from "./types";
import {
  lowerNumberStatic,
  tryPrimitiveMethod,
  tryTslibMethod,
} from "./method-routing";
import {
  lowerRegexValue,
  matchBindingName,
  matchBorrowUnwrap,
  regexLiteralInfo,
  tryRegexMethod,
} from "./regex";
import { coerceLiteralToUnion, unionTypeOfOperand } from "./unions";
import {
  isAstNode,
  isNullishExpr,
  peelNonNull,
  refExpr,
  rustStrLit,
} from "./utils";


export function lowerExpr(expr: Expression, analysis: ModuleAnalysis): HirExpr {
  switch (expr.type) {
    case "ParenthesizedExpression":
      // Source parens are structural only — the grouping is already encoded in
      // the tree. Unwrap; the emitter re-parenthesizes from precedence (026).
      return lowerExpr(
        (expr as unknown as { expression: Expression }).expression,
        analysis,
      );
    case "Literal": {
      // A regex literal `/pat/flags` (series 101) → the compiled `tslib::regex`
      // value, translated + validated at transpile time.
      const reInfo = regexLiteralInfo(expr as Literal);
      if (reInfo) return lowerRegexValue(reInfo);
      return lowerLiteral(expr as Literal);
    }
    case "Identifier": {
      const name = (expr as Identifier).name;
      // `undefined` is an identifier in ESTree (not a literal); it is the absent
      // optional (series 042).
      if (name === "undefined") return { kind: "none" };
      // `NaN` / `Infinity` are ESTree globals, not literals — map to the `f64`
      // associated constants (series 061; a `NaN` `Map`/`Set` key is faithful).
      if (name === "NaN") return { kind: "path", segments: ["f64", "NAN"] };
      if (name === "Infinity")
        return { kind: "path", segments: ["f64", "INFINITY"] };
      // A cross-module value-`export default` import (#70) binds a `LazyLock`
      // static — deref the cell to its payload. Auto-deref then carries method /
      // field access through, and the ownership pass clones the `Rc` on an owned
      // use (a non-scalar); a scalar payload is `Copy`, so `*def` is a plain read.
      if (analysis.lazyDefaultLocals.has(name)) {
        return { kind: "deref", expr: { kind: "ident", name } };
      }
      return { kind: "ident", name };
    }
    case "ChainExpression":
      return lowerChain(
        (expr as unknown as { expression: Expression }).expression,
        analysis,
      );
    case "TemplateLiteral":
      // A template literal `` `a${x}b` `` (series 095) → a `strConcat` (`format!`)
      // with JS-faithful interpolation. A typed position reaches here via
      // `lowerTyped`'s fallthrough (a template is a `String`).
      return lowerTemplate(
        expr as unknown as {
          quasis: { value: { cooked?: string; raw: string } }[];
          expressions: Expression[];
        },
        analysis,
      );
    case "UpdateExpression":
      // `++`/`--` in a *value* position (series 096) — `const y = x++`, `arr[i++]`,
      // `while (n-- > 0)`. Statement position is intercepted earlier (the
      // `ExpressionStatement` case and the `for` update slot) and lowers to a bare
      // `x += 1`; only value uses reach here → the block-temp `update` node.
      return lowerUpdateValue(
        expr as unknown as {
          operator: string;
          prefix: boolean;
          argument: Expression;
        },
        analysis,
      );
    case "ConditionalExpression":
      // Ternary in an *untyped* value position (series 094) — `console.log(c ? … :
      // …)`, an operand. A typed context routes through `lowerTyped` instead (each
      // arm coerces to the target). `lowerCond` handles homogeneous arms and the
      // heterogeneous auto-synthesized-union policy.
      return lowerCond(
        expr as unknown as {
          test: Expression;
          consequent: Expression;
          alternate: Expression;
        },
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
      // `k in obj` (series 061) → `obj.contains_key(&k)` for a `Map`/`Record`,
      // `obj.contains(&k)` for a `Set` — routed by the right operand's type.
      if (b.operator === "in") {
        const ty = collectionOf(b.right, analysis);
        if (ty?.kind === "hashmap") {
          return {
            kind: "method",
            receiver: lowerExpr(b.right, analysis),
            name: "contains_key",
            args: [refExpr(wrapKey(lowerExpr(b.left, analysis), ty.key, true))],
          };
        }
        if (ty?.kind === "set") {
          return {
            kind: "method",
            receiver: lowerExpr(b.right, analysis),
            name: "contains",
            args: [refExpr(wrapKey(lowerExpr(b.left, analysis), ty.elem, true))],
          };
        }
        throw new UnsupportedError({
          type: "`in` on a receiver that is not a Map/Record/Set binding",
        });
      }
      // String concatenation (series 080): a `+` with a provably-string operand
      // is JS string concat (`string + anything` concatenates), lowered to
      // `format!("{}{}…", …)`. Flattened over nested string-concat `+` so a chain
      // is a single flat `format!`; a parenthesized numeric subtree stays one part.
      if (b.operator === "+" && isStringConcat(b, analysis)) {
        return {
          kind: "strConcat",
          parts: flattenConcat(expr, analysis).map((p) =>
            lowerExpr(p, analysis),
          ),
        };
      }
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
        // Union-enum operand vs a literal (series 093): `d === "north"` →
        // `d == Dir::North` (the literal side coerces to its variant).
        const leftUnion = unionTypeOfOperand(b.left, analysis);
        const un = leftUnion ?? unionTypeOfOperand(b.right, analysis);
        if (un) {
          const enumSide = leftUnion ? b.left : b.right;
          const litSide = leftUnion ? b.right : b.left;
          const variant = coerceLiteralToUnion(litSide, un, analysis);
          if (variant) {
            return {
              kind: "binary",
              op: b.operator === "===" ? "==" : "!=",
              left: lowerExpr(enumSide, analysis),
              right: variant,
            };
          }
        }
      }
      // Fail-loud (series 066, design F): an un-narrowed `Option<T>` in an
      // arithmetic position (`optNum + 1`, `-`, `*`, `/`, `%`) has no `Add`/etc.
      // impl — JS's `undefined + 1 == NaN` coercion is unreachable and not emitted.
      // Point the user at `??` / narrow / `!`. (Equality/`in` against `null` was
      // already handled above; string `+` concat took its own path.)
      if (["+", "-", "*", "/", "%"].includes(b.operator)) {
        for (const side of [b.left, b.right]) {
          if (optionExprType(side, analysis)) {
            throw new UnsupportedError({
              type: `arithmetic on an un-narrowed optional — narrow it (\`if (x !== undefined)\`) or coerce (\`x ?? d\` / \`x!\`) first`,
            });
          }
        }
      }
      // Operators over a generic `T` (series 088, graduates the 081 #44 wall).
      // A bare `T` is a JS value; when **both operands are the same `{kind:"param"}`
      // T**, the operator lowers to a tslib `ops` trait method (`self.v.js_add(&o)`)
      // and the operator's bound (`T: tslib::ops::JsAdd`) is unioned onto the scope's
      // generic clause. The trait bound IS the constraint (only `f64` implements
      // `JsSub`, so a `String`-`-` fails at the bound). Everything else stays loud.
      {
        const lp = paramTypeOfOperand(b.left, analysis);
        const rp = paramTypeOfOperand(b.right, analysis);
        const bothSameParam = lp && rp && lp.name === rp.name;
        if (bothSameParam) {
          const op = JS_OP_TRAIT[b.operator];
          // A same-`T` operator with a trait mapping routes to the trait layer —
          // but only when the param is **class-level** (a method's own `<U>` has no
          // operator-bound slot). Otherwise it stays fail-loud.
          if (op && analysis.classTypeParams.has(lp.name)) {
            registerOpBound(analysis, lp.name, op.trait);
            return {
              kind: "jsOp",
              method: op.method,
              receiver: lowerExpr(b.left, analysis),
              arg: lowerExpr(b.right, analysis),
            };
          }
          // Same-`T` but an out-of-scope operator (bitwise, or a non-class param) —
          // fail-loud (a later slice / the #44 wall for method-`<U>`).
          throw new UnsupportedError({
            type: `operator '${b.operator}' on a generic type parameter '${lp.name}' — only arithmetic (\`+ - * / %\`), ordering (\`< <= > >=\`), and equality (\`=== !==\`) over two same-'${lp.name}' operands lower to the JS-operator trait layer (a class-level type parameter); this operator does not.`,
          });
        }
        // Mixed operands — exactly one side is a bare `T` (`this.v + 1`, `t < 5`):
        // the JS coercion case (`"a"+1`→`"a1"`), out of scope → fail-loud.
        if (lp || rp) {
          const pname = (lp ?? rp)!.name;
          throw new UnsupportedError({
            type: `operator '${b.operator}' on a generic type parameter '${pname}' and a non-'${pname}' operand (a mixed-operand JS coercion, e.g. \`this.v + 1\` / \`t < 5\`) — only two same-'${pname}' operands lower to the JS-operator trait layer.`,
          });
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
      // Logical `&&`/`||` over a bare generic `T` (series 088) stays fail-loud —
      // truthiness of an opaque `T` isn't knowable at the definition site (a later
      // slice). Guard before the truthy routing, which would else miscompile.
      for (const side of [l.left, l.right]) {
        if (paramTypeOfOperand(side, analysis)) {
          throw new UnsupportedError({
            type: `logical operator '${l.operator}' on a generic type parameter — truthiness of an opaque 'T' isn't knowable at the definition site (only arithmetic / ordering / equality over a same-'T' pair lower; logical is a later slice).`,
          });
        }
      }
      // JS `||`/`&&` return the operand *value* under full falsy semantics (series
      // 066, design E): `x || d` yields `d` for a present falsy `x` (`0`/`""`/…),
      // not just for absence. When either operand is a non-`bool` scalar / `Option`,
      // route through the shared `is_truthy` helper (a value-returning block). Bare
      // boolean logic (both operands `bool` / unknown) stays a native short-circuit
      // `binary` — no helper, matching Rust's `&&`/`||`.
      if (
        needsTruthy(l.left, analysis) ||
        needsTruthy(l.right, analysis)
      ) {
        return {
          kind: "truthyLogical",
          op: l.operator,
          left: lowerExpr(l.left, analysis),
          right: lowerExpr(l.right, analysis),
        };
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
      // `delete obj[k]` (series 061) → `obj.shift_remove(&k)` (order-preserving)
      // for a `Map`/`Record` binding; anything else `delete`s fail loud.
      if (u.operator === "delete") {
        const arg = u.argument;
        if (arg.type === "MemberExpression" && (arg as MemberExpression).computed) {
          const mm = arg as MemberExpression;
          const ty = collectionOf(mm.object, analysis);
          if (ty?.kind === "hashmap") {
            return {
              kind: "method",
              receiver: lowerExpr(mm.object, analysis),
              name: "shift_remove",
              args: [refExpr(wrapKey(lowerExpr(mm.property, analysis), ty.key, true))],
            };
          }
        }
        throw new UnsupportedError({
          type: "delete of a member that is not a Map/Record element",
        });
      }
      // `-x` (negation) and `!x` (logical not) map directly; `~x` (bitwise NOT,
      // series 056) passes through as a `unary "~"` that `refineBitwise` rewrites
      // to `!` over an `i128`. `+x`, `typeof`/`void` fail loud.
      if (u.operator !== "-" && u.operator !== "!" && u.operator !== "~") {
        throw new UnsupportedError({ type: `unary operator '${u.operator}'` });
      }
      // `!x` on a non-`bool` operand (a number/string/`Option`, series 066) uses JS
      // truthiness: `!x` is `!is_truthy(&x)`. A `bool` operand stays native `!`.
      if (u.operator === "!" && needsTruthy(u.argument, analysis)) {
        return {
          kind: "unary",
          op: "!",
          operand: { kind: "isTruthy", value: lowerExpr(u.argument, analysis) },
        };
      }
      return {
        kind: "unary",
        op: u.operator,
        operand: lowerExpr(u.argument, analysis),
      };
    }
    case "TSNonNullExpression": {
      // `x!` (series 066, design D) — explicit non-null assertion → `.unwrap()`.
      // Panics on `None` a step earlier than JS's `TypeError` at the access; both
      // blow up, so it is a faithful-enough mapping. Only meaningful on an optional
      // receiver; a non-optional `x!` is a harmless no-op unwrap the type rejects.
      const inner = (expr as unknown as { expression: Expression }).expression;
      return { kind: "unwrapOpt", value: lowerExpr(inner, analysis) };
    }
    case "AssignmentExpression": {
      const a = expr as {
        operator: string;
        left: Expression;
        right: Expression;
      };
      // A write to a setter accessor `obj.s = v` (series 060) → `obj.set_s(v)`,
      // routed by the receiver's class carrying a setter named `s`.
      if (
        a.operator === "=" &&
        a.left.type === "MemberExpression" &&
        !(a.left as MemberExpression).computed &&
        (a.left as MemberExpression).property.type === "Identifier"
      ) {
        const ml = a.left as MemberExpression;
        const setterName = (ml.property as Identifier).name;
        const setterClass = receiverClass(ml.object, analysis);
        if (
          setterClass &&
          analysis.accessors.get(setterClass)?.setters.has(setterName)
        ) {
          return {
            kind: "method",
            receiver: lowerExpr(ml.object, analysis),
            name: `set_${setterName}`,
            args: [lowerExpr(a.right, analysis)],
          };
        }
      }
      // Assignment to a `readonly` field is rejected (series 059); construction
      // (a struct literal) is unaffected — this fires only on `s.f = …`.
      checkReadonlyAssign(a.left, analysis);
      // A `=` write to a *string-keyed* computed member is a HashMap insert, not
      // an index-assign — Rust's `Index` on `HashMap` is read-only (series 031,
      // gap E). A numeric index is a `Vec` write and stays an index-assign.
      const insert = tryHashMapInsert(a, analysis);
      if (insert) return insert;
      // Option coercion on reassignment (series 066): `x = v` where `x` is
      // `Option<T>` `Some`-wraps a present value (`undefined`/`null` → `None`), so
      // the slot stays `Option<T>`. Mirrors the let-init / field-init coercion.
      // Exception (series 100): a value that is *already* an `Option` by
      // construction — `readLine()`/`env(...)` — must NOT be re-wrapped (that
      // would double it to `Option<Option<T>>`); it reassigns naturally below.
      if (
        a.operator === "=" &&
        a.left.type === "Identifier" &&
        analysis.bindingTypes.get((a.left as Identifier).name)?.kind === "option" &&
        !analysis.narrowedOptions.has((a.left as Identifier).name) &&
        !isOptionReturningIoCall(a.right, analysis)
      ) {
        const value: HirExpr = isNullishExpr(a.right)
          ? { kind: "none" }
          : { kind: "some", value: lowerExpr(a.right, analysis) };
        return {
          kind: "assign",
          op: "=",
          target: lowerExpr(a.left, analysis),
          value,
        };
      }
      return {
        kind: "assign",
        op: a.operator,
        target: lowerExpr(a.left, analysis),
        value: lowerExpr(a.right, analysis),
      };
    }
    case "ArrayExpression": {
      const els = (expr as { elements: Expression[] }).elements;
      // A single-spread array over a *generator* `[...g()]` (series 065) →
      // `g().collect::<Vec<_>>()`. Array spread `[...a]` and other iterables stay
      // fail-loud (series 044's residual — not 065's generator-consumption scope).
      if (
        els.length === 1 &&
        els[0] &&
        (els[0] as { type?: string }).type === "SpreadElement"
      ) {
        const arg = (els[0] as unknown as { argument: Expression }).argument;
        if (isGeneratorCall(arg, analysis)) {
          return { kind: "collectVec", iter: lowerExpr(arg, analysis) };
        }
      }
      if (els.some((e) => (e as { type?: string })?.type === "SpreadElement")) {
        throw new UnsupportedError({
          type: "array spread of a non-generator (only `[...g()]` over a generator is modeled)",
        });
      }
      return {
        kind: "array",
        elements: els.map((e) => lowerExpr(e, analysis)),
      };
    }
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

export function lowerCall(
  call: CallExpression,
  analysis: ModuleAnalysis,
  awaited = false,
): HirExpr {
  // Explicit call-site type arguments `identity<number>(5)` (series 081) — the
  // dialect infers a generic fn's type params from its arguments (rustc does the
  // same), so an explicit source-level `<…>` on a *user* call is fail-loud. Checked
  // before any routing so the guard is uniform across free-fn / method calls. The
  // blessed `@ttr/std` shim generics are exempt: `parseJson<T>(s)` (series 084) is
  // *designed* around an explicit type argument (it has no argument to infer `T`
  // from), so a shim callee skips the guard and routes to `lowerStdShimCall`.
  if ((call as { typeArguments?: unknown }).typeArguments) {
    const isStdShim =
      call.callee.type === "Identifier" &&
      analysis.stdShim.has((call.callee as Identifier).name);
    if (!isStdShim) {
      throw new UnsupportedError({
        type: "explicit type arguments on a generic call `f<…>(…)` (calls are inference-only — drop the `<…>`; rustc infers the type parameter from the arguments)",
      });
    }
  }
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
  // console.log(...) → println!. An `Option<T>` argument (series 066) renders via
  // `fmt_opt` — `Some(v)` → the `v` render, `None` → the literal `undefined` — since
  // `Option` has no `Display`. Non-optional args pass through unchanged.
  if (isConsoleLog(call.callee)) {
    return {
      kind: "println",
      args: call.arguments.map((a) => {
        const lowered = lowerExpr(a, analysis);
        return optionExprType(a, analysis)
          ? { kind: "optDisplay", value: lowered }
          : lowered;
      }),
    };
  }

  // `@ttr/std` std-shim intrinsics (series 084) — recognized by the reserved
  // import specifier (the local alias is a key in `analysis.stdShim`). Routed
  // *before* the generic user-fn path so a shim call never falls through to a
  // plain `call`. A user's own `parseJson`/`stringifyJson` from elsewhere is not
  // in the map, so it is untouched.
  if (call.callee.type === "Identifier") {
    const shim = analysis.stdShim.get((call.callee as Identifier).name);
    if (shim) return lowerStdShimCall(shim, call, analysis);
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
      // Fail-loud (series 066, design F): an un-narrowed `Option<T>` flowing into a
      // `T`-expecting (non-optional) param has no coercion — narrow or default it
      // first. Only when the callee's param is a known non-optional `T`; an unknown
      // callee (no sig) takes the default path (cargo-loud if genuinely wrong).
      if (
        param &&
        !param.optional &&
        param.annotation &&
        lowerType(param.annotation, analysis.structs).kind !== "option" &&
        optionExprType(a, analysis)
      ) {
        throw new UnsupportedError({
          type: `an un-narrowed optional passed where '${name}' expects a concrete value — narrow it (\`if (x !== undefined)\`) or coerce (\`x ?? d\` / \`x!\`) first`,
        });
      }
      let borrow: Borrow = "owned";
      if (param && !param.isCopy) {
        if (param.ownership === "ref") borrow = "ref";
        else if (param.ownership === "refMut") borrow = "refMut";
      }
      // An object-literal argument lowers against the callee's declared param type
      // (series 059) — the 032 residual: `f({x:1, y:2})` → `f(Point { x, y })`. A
      // string/number literal likewise routes through `lowerTyped` so a union-typed
      // param coerces the literal to its variant (series 093); for a non-union param
      // `lowerTyped` falls straight through to `lowerExpr` (identical output). An
      // identifier / template into a *union* param also coerces (`f(c)` where
      // `c: Circle`, param `Shape` → `Shape::Circle(c)`; a value already of the union
      // type passes straight through).
      let expr: HirExpr;
      if (
        (a.type === "ObjectExpression" || a.type === "Literal") &&
        param?.annotation
      ) {
        // Object/literal arg lowers against the declared param type (series 059/093,
        // unchanged) — a union param coerces the literal/object to its variant.
        expr = lowerTyped(
          a,
          lowerType(param.annotation, analysis.structs),
          analysis,
        );
      } else if (
        (a.type === "Identifier" || a.type === "TemplateLiteral") &&
        param?.annotation
      ) {
        // An identifier / template into a *union* param coerces (`f(c)` where
        // `c: Circle`, param `Shape` → `Shape::Circle(c)`; a value already of the
        // union type passes through). `lowerType` throws on a bare generic `T` (no
        // `typeParams` here) — a failure just means "not a union param" → `lowerExpr`.
        let pTy: RustType | null = null;
        try {
          pTy = lowerType(param.annotation, analysis.structs);
        } catch {
          pTy = null;
        }
        expr =
          pTy?.kind === "struct" && analysis.unionEnums.has(pTy.name)
            ? lowerTyped(a, pTy, analysis)
            : lowerExpr(a, analysis);
      } else {
        expr = lowerExpr(a, analysis);
      }
      args.push({ borrow, expr });
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
    // A `fsAsync.<m>(...)` / `http.<m>(...)` call reaching `lowerCall` directly is
    // **not** awaited (`lowerAwait` intercepts the awaited form) — an un-polled
    // future that never runs (series 100 / the 051 rule). Fail-loud.
    if (
      m.object.type === "Identifier" &&
      analysis.ioAsyncNamespaces.has((m.object as Identifier).name)
    ) {
      throw new UnsupportedError({
        type: "call to an async method not directly awaited (an un-polled future never runs)",
      });
    }
    // `Writer` handle methods (series 100) — `w.write(s)/.writeLine(s)/.flush()`
    // where `w ∈ writerBindings`. Maps to the snake_case `tslib::io::Writer`
    // method (`rid` does not snake_case). The methods are **infallible** (they
    // `.expect()` internally — JS `process.stdout.write` doesn't throw either),
    // so no `?` and the stream stays out of the fallibility fixpoint. An unknown
    // method is fail-loud (the 089 handle-method pattern).
    if (isWriterReceiver(m.object, analysis)) {
      const WRITER_METHODS: Record<string, string> = {
        write: "write",
        writeLine: "write_line",
        flush: "flush",
      };
      const rustName = WRITER_METHODS[methodName];
      if (!rustName) {
        throw new UnsupportedError({
          type: `\`.${methodName}\` on a Writer — only \`write\`, \`writeLine\`, \`flush\` are available`,
        });
      }
      return {
        kind: "method",
        receiver: lowerExpr(m.object, analysis),
        name: rustName,
        // `write`/`writeLine` take `&str`; pass the `String` arg by `&` (deref-
        // coerces). `flush` takes none.
        args: call.arguments.map((a) =>
          refExpr(lowerExpr(a as Expression, analysis)),
        ),
      };
    }
    // `JsonValue` accessor methods (series 090) — `get`/`at`/`asNumber`/`asString`/
    // `asBool`/`isNull`/`isNumber`/`isString`/`isBool`/`isArray`/`isObject` on any
    // statically-`JsonValue` receiver (a binding, `r.value`, or a `.get(…).at(…)`
    // chain). Each maps to its snake_case Rust inherent method (`rid` does not
    // snake_case, so the Rust name is set here). An unknown accessor is fail-loud.
    if (isJsonValueExpr(m.object, analysis)) {
      const rustName = JSON_VALUE_METHODS.get(methodName);
      if (!rustName) {
        throw new UnsupportedError({
          type: `\`.${methodName}\` on a JsonValue — only \`get\`, \`at\`, \`asNumber\`, \`asString\`, \`asBool\`, \`isNull\`, \`isNumber\`, \`isString\`, \`isBool\`, \`isArray\`, \`isObject\`, \`length\` are available`,
        });
      }
      return {
        kind: "method",
        receiver: lowerExpr(m.object, analysis),
        name: rustName,
        args: call.arguments.map((a) => lowerExpr(a as Expression, analysis)),
      };
    }
    // `rng` handle methods (series 089) — `r.next()/.int()/.pick()/.shuffle()`
    // where `r ∈ rngBindings`. Checked FIRST so `.next()` on an rng handle wins
    // over the 052 generator `.next()` protocol. `pick`/`shuffle` pass the array
    // by reference (`&arr`); all four reuse the generic `method` emit. An unknown
    // method on an rng handle is fail-loud (only next/int/pick/shuffle exist).
    if (
      m.object.type === "Identifier" &&
      analysis.rngBindings.has((m.object as Identifier).name)
    ) {
      const RNG_METHODS = new Set(["next", "int", "pick", "shuffle"]);
      if (!RNG_METHODS.has(methodName)) {
        throw new UnsupportedError({
          type: `\`.${methodName}\` on an rng handle — only \`next\`, \`int\`, \`pick\`, \`shuffle\` are available`,
        });
      }
      const args = call.arguments.map((a) =>
        methodName === "pick" || methodName === "shuffle"
          ? refExpr(lowerExpr(a as Expression, analysis))
          : lowerExpr(a as Expression, analysis),
      );
      return {
        kind: "method",
        receiver: lowerExpr(m.object, analysis),
        name: methodName,
        args,
      };
    }
    // `Date` accessor methods (series 102) — routed by the RECEIVER being a Date
    // (`new Date(x)`, a `dateBindings` name, or a `clock(...).date()` bridge), so
    // both the direct and the bound forms work. A setter / locale formatter /
    // unknown method is fail-loud (the surface is read-only + UTC-normalized);
    // every accessor is `&self` and takes no args.
    if (isDateExpr(m.object, analysis)) {
      const rustName = DATE_METHODS[methodName];
      if (!rustName) {
        if (methodName.startsWith("set")) {
          throw new UnsupportedError({
            type: `\`.${methodName}\` — Date setters are not accepted (Date is immutable in this dialect; construct a new Date from ms)`,
          });
        }
        if (methodName.startsWith("toLocale")) {
          throw new UnsupportedError({
            type: `\`.${methodName}\` — locale formatting is non-portable and not modeled; use \`toISOString\`/\`toJSON\`/\`toDateString\``,
          });
        }
        throw new UnsupportedError({
          type: `\`.${methodName}\` on a Date — only the get*/getUTC* accessors, \`toISOString\`, \`toJSON\`, and \`toDateString\` are available`,
        });
      }
      return {
        kind: "method",
        receiver: lowerExpr(m.object, analysis),
        name: rustName,
        args: [],
      };
    }
    // `clock` handle methods (series 102) — `c.now()/.date()/.tick(ms)` where `c`
    // is a `clock(...)` handle. `tick` takes `&mut self` (binding is `let mut`).
    // An unknown method is fail-loud (only now/date/tick exist).
    if (isClockExpr(m.object, analysis)) {
      const CLOCK_METHODS = new Set(["now", "date", "tick"]);
      if (!CLOCK_METHODS.has(methodName)) {
        throw new UnsupportedError({
          type: `\`.${methodName}\` on a clock handle — only \`now\`, \`date\`, \`tick\` are available`,
        });
      }
      return {
        kind: "method",
        receiver: lowerExpr(m.object, analysis),
        name: methodName,
        args: call.arguments.map((a) => lowerExpr(a as Expression, analysis)),
      };
    }
    // Bare `Date.now()` / `Date.parse(...)` / `Date.UTC(...)` (series 102) — the
    // static entry points read the host clock or an implementation-defined parser
    // (non-differential). Fail loud; `Date.now` redirects to the seeded `clock`
    // (the `Math.random → rng` treatment applied to time).
    if (
      m.object.type === "Identifier" &&
      (m.object as Identifier).name === "Date" &&
      !analysis.classes.has("Date")
    ) {
      if (methodName === "now") {
        throw new UnsupportedError({
          type: '`Date.now()` reads the host wall-clock (non-differential) — import `clock` from "@ttr/std" and call `clock(epochMs).now()` (an explicit seed makes the instant differential-stable)',
        });
      }
      throw new UnsupportedError({
        type: `\`Date.${methodName}\` is not modeled — construct with \`new Date(ms | isoString | fields)\`, and use \`clock\` from "@ttr/std" for a seeded now`,
      });
    }
    // A static method call `Type.m(args)` off a class name (series 060) → the
    // associated-fn call `Type::m(args)`. Static-fallible `new`/method propagation
    // rides the same `fallibleMethods` path as instance methods below.
    if (
      m.object.type === "Identifier" &&
      analysis.classes.has((m.object as Identifier).name) &&
      !analysis.enums.has((m.object as Identifier).name)
    ) {
      const className = (m.object as Identifier).name;
      const callExpr: HirExpr = {
        kind: "call",
        callee: `${className}::${methodName}`,
        args: call.arguments.map((a) => ({
          borrow: "owned",
          expr: lowerExpr(a as Expression, analysis),
        })),
      };
      return analysis.fallibleMethods.has(methodName)
        ? { kind: "try", expr: callExpr }
        : callExpr;
    }
    // A namespace / import-alias member call `Foo.bar(args)` (series 050d, Axis 4)
    // → the module path call `Foo::bar(args)` — the member is a free fn living in
    // `mod Foo` (a namespace) or in the aliased module (`import * as ns`). A member
    // that throws is fallible by its own name (spliced as a top-level fn), so it
    // `?`-propagates the same way a bare free-fn call does.
    if (
      m.object.type === "Identifier" &&
      analysis.namespaces.has((m.object as Identifier).name)
    ) {
      const nsName = (m.object as Identifier).name;
      const callExpr: HirExpr = {
        kind: "call",
        callee: `${nsName}::${methodName}`,
        args: call.arguments.map((a) => ({
          borrow: "owned",
          expr: lowerExpr(a as Expression, analysis),
        })),
      };
      return analysis.fallible.has(methodName)
        ? { kind: "try", expr: callExpr }
        : callExpr;
    }
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
    // `Math.*` / `Number.parseInt|parseFloat` global statics (series 083). Native
    // where `f64` matches JS; `tslib` for the parse quirks; a `min!`/`max!` macro
    // for the variadic Math.min/max. Handled before value-method routing since the
    // receiver is the global object, not a value.
    if (
      m.object.type === "Identifier" &&
      ((m.object as Identifier).name === "Math" ||
        (m.object as Identifier).name === "Number")
    ) {
      const routed = lowerNumberStatic(
        (m.object as Identifier).name,
        methodName,
        call,
        analysis,
      );
      if (routed) return routed;
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
    // `String.fromCharCode(…)` / `String.fromCodePoint(…)` are UTF-16 statics on
    // the global `String` (series 098) — deferred (the "non-index-first" fork), so
    // fail loud clearly instead of emitting a broken native call. Gated on `String`
    // being the global (not a user binding).
    if (
      m.object.type === "Identifier" &&
      (m.object as Identifier).name === "String" &&
      !analysis.bindingTypes.has("String") &&
      (methodName === "fromCharCode" || methodName === "fromCodePoint")
    ) {
      throw new UnsupportedError({
        type: `\`String.${methodName}\` uses UTF-16 code units (deferred)`,
      });
    }
    // `Array.from(iter)` (series 065) → `iter.collect::<Vec<_>>()` — the eager
    // consumer of a generator's `impl Iterator`. The mapping overload
    // `Array.from(src, fn)` (series 075) reuses 057's callback-lift: it lowers to
    // `<src-iter>.map(__cb).collect::<Vec<_>>()`, with `.enumerate()` for the `(x,i)`
    // index overload. The source is widened to any array/iterable in the mapping
    // form (a generator uses its `impl Iterator`, an array its `.iter()`); the
    // no-mapping form keeps its 065 generator-only gate.
    if (
      m.object.type === "Identifier" &&
      (m.object as Identifier).name === "Array" &&
      methodName === "from"
    ) {
      const arg = call.arguments[0];
      const mapFn = call.arguments[1];
      if (!arg) {
        throw new UnsupportedError({ type: "Array.from with no source" });
      }
      if (!mapFn) {
        // No-mapping form (065): generator source only.
        if (!isGeneratorCall(arg, analysis)) {
          throw new UnsupportedError({
            type: "Array.from over a non-generator (only `Array.from(g())` over a generator is modeled)",
          });
        }
        return { kind: "collectVec", iter: lowerExpr(arg, analysis) };
      }
      // Mapping form (075): `Array.from(src, fn)`.
      if (mapFn.type !== "ArrowFunctionExpression") {
        throw new UnsupportedError({
          type: "Array.from mapping argument must be an arrow function",
        });
      }
      const fromGenerator = isGeneratorCall(arg, analysis);
      // The element type: a generator's `Item`, else the array source's element.
      const elemType = fromGenerator
        ? (analysis.generatorItemTypes.get(
            ((arg as CallExpression).callee as Identifier).name,
          ) ?? { kind: "f64" })
        : elementTypeOf(arg, analysis);
      const lifted = liftCallback(
        mapFn as ArrowFunctionExpression,
        analysis,
        "map",
        elemType,
        1,
        undefined,
        { indexAllowed: true },
      );
      return {
        kind: "arrayFromMap",
        source: lowerExpr(arg, analysis),
        fromIterator: fromGenerator,
        cbName: lifted.cbName,
        elemParam: lifted.paramNames[0] as string,
        indexParam: lifted.indexParam,
        forwarded: lifted.forwarded,
        elemMode: lifted.elemMode,
      };
    }
    // A bare `gen.next(v)` / `gen.next()` on a **bidirectional** generator (series
    // 076) — driven forward without reading the `{ value, done }` result (the common
    // "advance and discard" statement). Routes to `gen.resume(<sent>)`; a bare
    // `.next()` sends the `TNext` default. (The `{ value, done }`-destructured read
    // is handled in `lowerVarDecl` via `genStepTuple`.)
    if (methodName === "next") {
      const nx = resolveGeneratorNext(call, analysis);
      if (nx && analysis.bidirectionalGenerators.has(nx.genName)) {
        return {
          kind: "method",
          receiver: lowerExpr(nx.recvExpr, analysis),
          name: "resume",
          args: [
            nx.sent
              ? lowerExpr(nx.sent, analysis)
              : { kind: "raw", text: "Default::default()" },
          ],
        };
      }
    }
    // Manual `.next()` on a generator (series 065) → fail-loud: Rust's
    // `Iterator::next()` is pull-only (`Option<T>`, no `{value, done}`, no
    // resumed-in value). Use `for-of`, `[...g()]`, or `Array.from(g())`.
    if (
      methodName === "next" &&
      m.object.type === "CallExpression" &&
      (m.object as CallExpression).callee.type === "Identifier" &&
      analysis.generators.has(
        ((m.object as CallExpression).callee as Identifier).name,
      )
    ) {
      throw new UnsupportedError({
        type: "manual generator `.next()` (impl Iterator is pull-only — use for-of / spread / Array.from)",
      });
    }
    // Bare `JSON.stringify(v)` / `JSON.parse(s)` are fail-loud and **redirect** to
    // the `@ttr/std` shim (series 084). The type/fidelity policy moved to the
    // blessed call-site API: `parseJson<T>` gives the emitter a concrete
    // `from_str::<T>` target (no `any`); `stringifyJson` carries the JS number
    // fidelity. Recognition of the shim is by the reserved import specifier.
    if (
      m.object.type === "Identifier" &&
      (m.object as Identifier).name === "JSON"
    ) {
      if (methodName === "stringify") {
        throw new UnsupportedError({
          type: '`JSON.stringify` is not accepted — import `stringifyJson` from "@ttr/std" and call `stringifyJson(v)`',
        });
      }
      if (methodName === "parse") {
        throw new UnsupportedError({
          type: '`JSON.parse` is not accepted — import `parseJson` from "@ttr/std" and call `parseJson<T>(s)`',
        });
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
        undefined,
        // The `(el, i)` index param via `.enumerate()` is `map`-only (series 057).
        { indexAllowed: methodName === "map" },
      );
      const receiver = lowerExpr(m.object, analysis);
      const shared = {
        receiver,
        cbName: lifted.cbName,
        elemParam: lifted.paramNames[0] as string,
        forwarded: lifted.forwarded,
        elemMode: lifted.elemMode,
      };
      return methodName === "map"
        ? { kind: "iterMap", ...shared, indexParam: lifted.indexParam }
        : { kind: "iterFilter", ...shared };
    }
    // `flatMap(f)` with a uniform `U[]`-returning callback (series 085) →
    // `iter().flat_map(f).collect::<Vec<_>>()`. The one-level element unwrap lives
    // in `typeCbBody`'s array case: the lifted `__cb` returns `Vec<U>`, so
    // `flat_map` flattens exactly one level → `Vec<U>` (JS's `U[]` result). A
    // union (`U | U[]`) callback fails loud there (→ #59). Single-param only (no
    // `(x, i)` index — that is map-only, 057).
    if (
      !isUserMethod &&
      methodName === "flatMap" &&
      call.arguments.length === 1 &&
      call.arguments[0]?.type === "ArrowFunctionExpression"
    ) {
      const elemType = elementTypeOf(m.object, analysis);
      const lifted = liftCallback(
        call.arguments[0] as ArrowFunctionExpression,
        analysis,
        "flatMap",
        elemType,
        1,
      );
      return {
        kind: "iterFlatMap",
        receiver: lowerExpr(m.object, analysis),
        cbName: lifted.cbName,
        elemParam: lifted.paramNames[0] as string,
        forwarded: lifted.forwarded,
        elemMode: lifted.elemMode,
      };
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
        elemMode: lifted.elemMode,
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
        elemMode: lifted.elemMode,
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
    // RegExp methods (series 101) — a regex receiver (`re.test`/`re.exec`) or a
    // string receiver with a regex argument (`s.match(re)`/`.replace(re, …)`/…).
    // Runs before the string/Map dispatch so a regex arg claims `.split`/`.replace`
    // over the plain string routing; returns null (falls through) otherwise.
    if (!isUserMethod) {
      const regexRouted = tryRegexMethod(methodName, m, call, analysis);
      if (regexRouted) return regexRouted;
    }
    // `Map`/`Set` class methods (series 061) route by the receiver's binding type
    // to their `IndexMap`/`IndexSet` equivalents. Guarded by `!isUserMethod` so a
    // user method named `get`/`set`/`has`/`add`/`delete` stays a native call.
    if (!isUserMethod) {
      const mapSet = tryMapSetMethod(methodName, m, call, analysis);
      if (mapSet) return mapSet;
    }
    // Primitive (`string`/`number`) receiver methods (series 083) — routed
    // through the unified `receiverTypeOf` gate. Runs **before** `tryTslibMethod`
    // so a *string* `.slice`/`.at` (UTF-16 semantics) is claimed here rather than
    // by the array-intended `tslib::array::slice`. Only claims when the receiver
    // is a modeled `String`/`f64`; an unmodeled receiver → null → fall through.
    if (!isUserMethod) {
      const prim = tryPrimitiveMethod(methodName, m, call, analysis);
      if (prim) return prim;
    }
    // Quirk-heavy library methods route to the `tslib` fidelity crate (027);
    // clean-mapping methods fall through to the native `method` call below.
    const routed = isUserMethod
      ? null
      : tryTslibMethod(methodName, m, call, analysis);
    if (routed) return routed;
    // Method-parameter borrow inference (series 060): a user method whose param
    // `i` is `&T`/`&mut T` gets its arg borrow-adapted (`&arg`/`&mut arg`) — the
    // same call-site adaptation the free-fn path emits, reusing the 061 `ref` node.
    const methodInfo = isUserMethod ? analysis.methodParams.get(methodName) : undefined;
    const methodExpr: HirExpr = {
      kind: "method",
      receiver: lowerExpr(m.object, analysis),
      name: methodName,
      args: call.arguments.map((a, i) => {
        const expr = lowerExpr(a, analysis);
        const own = methodInfo?.[i];
        if (own && !own.isCopy && own.ownership === "ref") {
          return refExpr(expr);
        }
        if (own && !own.isCopy && own.ownership === "refMut") {
          return { kind: "ref", mut: true, expr };
        }
        return expr;
      }),
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
 * Local read/consume classifier for a callback's element parameter (series 057).
 * Walks the one body once, tagging each occurrence of `param` by its role:
 *
 *  - **read** — the receiver of a member access (`s.x`, `s.length`) or an operand
 *    of an arithmetic/comparison/logical/unary expression (produces a new value).
 *  - **consume** — the value flows out: it *is* the returned body, or an element of
 *    a returned array/object literal, or a by-value call/`new` argument.
 *  - **unresolved** — anything else (a use the local walk can't prove either way).
 *
 * A single consume → the element is owned+cloned; all-read → borrowed; any
 * unresolved use → fail-loud (the caller rejects, honoring "no silent clone").
 */
export function classifyElementUse(
  body: Expression,
  param: string,
): "read" | "consume" | "unresolved" {
  let sawConsume = false;
  let sawUnresolved = false;

  const visit = (node: unknown, role: "read" | "consume" | "unresolved") => {
    if (Array.isArray(node)) {
      for (const c of node) visit(c, role);
      return;
    }
    if (!isAstNode(node)) return;
    if (node.type === "Identifier") {
      if ((node.name as string) === param) {
        if (role === "consume") sawConsume = true;
        else if (role === "unresolved") sawUnresolved = true;
      }
      return;
    }
    switch (node.type) {
      case "MemberExpression": {
        visit(node.object, "read"); // the receiver is only read
        if (node.computed) visit(node.property, "read"); // an index value
        return;
      }
      case "BinaryExpression":
      case "LogicalExpression": {
        visit(node.left, "read");
        visit(node.right, "read");
        return;
      }
      case "UnaryExpression":
        visit(node.argument, "read");
        return;
      case "ConditionalExpression": {
        visit(node.test, "read");
        visit(node.consequent, role); // branches inherit the outer role
        visit(node.alternate, role);
        return;
      }
      case "ParenthesizedExpression":
        visit(node.expression, role);
        return;
      case "ArrayExpression":
        visit(node.elements, "consume"); // each element is moved into the array
        return;
      case "ObjectExpression":
        visit(node.properties, role);
        return;
      case "Property":
        visit(node.value, "consume"); // the value is moved into the object
        return;
      case "CallExpression":
      case "NewExpression": {
        visit(node.callee, "read");
        visit(node.arguments, "consume"); // by-value arguments own their value
        return;
      }
      default: {
        // An unrecognized position: descend, but any `param` reached is unresolved.
        for (const key in node) {
          if (key === "type") continue;
          visit(node[key], "unresolved");
        }
      }
    }
  };

  // The body's value is the callback's return — reaching `param` here is a consume.
  visit(body, "consume");

  if (sawUnresolved) return "unresolved";
  if (sawConsume) return "consume";
  return "read"; // all-read, or unused (borrow is safe either way)
}

/**
 * The element type of an adapter receiver (series 048): a receiver identifier of
 * a known `Vec<E>` yields `E`; an array literal yields its first element's scalar
 * type. Anything else (a chained call, an unknown binding) is fail-loud.
 */
export function elementTypeOf(objExpr: Expression, analysis: ModuleAnalysis): RustType {
  // Unified backbone (series 083): any receiver shape the `receiverTypeOf` tiers
  // resolve to a `Vec<E>` yields `E` — so `getRows().map(f)` / `this.items
  // .filter(g)` now work, not just identifier arrays. The identifier fast path is
  // subsumed by Tier-1 (bindingTypes), byte-for-byte unchanged.
  const rt = receiverTypeOf(objExpr, analysis);
  if (rt && rt.kind === "vec") return rt.elem;
  if (objExpr.type === "Identifier") {
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
/**
 * Scan for `T | null | undefined` unions (series 066, design C) — a type that
 * carries *both* nullish spellings. Both collapse to one `Option::None`, so their
 * erased JS distinction diverges at print / `===` / coercion. Returns one warning
 * per such site (deduped by the emitter's `new Set(...)`). A single-spelling union
 * (`T | undefined`) is unambiguous → no warning.
 */
export function collectBothPresentWarnings(program: Program): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isAstNode(node)) return;
    if (node.type === "TSUnionType") {
      const types = (node as { types?: { type: string }[] }).types ?? [];
      const hasNull = types.some((t) => t.type === "TSNullKeyword");
      const hasUndef = types.some((t) => t.type === "TSUndefinedKeyword");
      if (hasNull && hasUndef) {
        out.push(
          "a `T | null | undefined` union collapses both `null` and `undefined` to a single `Option::None`; print/`===`/coercion may diverge from JS at this site (066)",
        );
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

export function collectBindingTypes(
  program: Program,
  structs: Set<string>,
): Map<string, RustType> {
  const out = new Map<string, RustType>();
  const typeFrom = (
    annotation: unknown,
    init: Expression | null,
    scopeParams: Set<string>,
  ): RustType | null => {
    if (isAstNode(annotation)) {
      const inner = (annotation as { typeAnnotation?: unknown }).typeAnnotation;
      if (isAstNode(inner)) {
        try {
          // Series 081: pass the enclosing generic scope so a `T`-typed param
          // records `{kind:"param"}` (drives the operator-on-`T` fail-loud guard),
          // instead of being dropped (a bare `T` would otherwise throw → null).
          return lowerType(inner as unknown as TSType, structs, scopeParams);
        } catch {
          return null;
        }
      }
    }
    return init ? inferInitType(init, structs) : null;
  };
  // Read a `<T, U extends I>` declaration's param names (series 081) for the
  // in-scope generic set; a bound is ignored here (name-collection only).
  const declNames = (tp: unknown): string[] =>
    isAstNode(tp)
      ? ((tp as { params?: { name?: { name?: string } }[] }).params ?? [])
          .map((p) => p.name?.name)
          .filter((n): n is string => typeof n === "string")
      : [];
  // `scopeParams` accumulates the generic type-param names in scope as the walk
  // descends into a generic class/method/fn (series 081).
  const visit = (node: unknown, scopeParams: Set<string>): void => {
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n, scopeParams));
      return;
    }
    if (!isAstNode(node)) return;
    // Extend the generic scope for a class / generic fn / generic method body.
    let scope = scopeParams;
    if (
      node.type === "ClassDeclaration" ||
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      const names = declNames((node as { typeParameters?: unknown }).typeParameters);
      if (names.length > 0) scope = new Set([...scopeParams, ...names]);
    }
    if (node.type === "VariableDeclarator") {
      const id = node.id;
      if (isAstNode(id) && id.type === "Identifier") {
        const ty = typeFrom(
          (id as { typeAnnotation?: unknown }).typeAnnotation,
          (node.init as Expression | null) ?? null,
          scope,
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
            scope,
          );
          if (ty) out.set(p.name as string, ty);
        }
      }
    }
    for (const key in node) {
      if (key === "type") continue;
      visit(node[key], scope);
    }
  };
  visit(program.body, EMPTY_TYPE_PARAMS);
  return out;
}

/** Infer a `RustType` from a scalar/array-literal initializer (best-effort, series 048). */
export function inferInitType(
  init: Expression,
  structs: Set<string>,
): RustType | null {
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
    const elem = inferInitType(first as Expression, structs);
    return elem ? { kind: "vec", elem } : null;
  }
  // `new Map<K, V>()` / `new Set<T>()` — read the constructor's type arguments so
  // an un-annotated `const m = new Map<string, number>()` still records the
  // map/set type (series 061). Without type args it stays fail-loud.
  if (init.type === "NewExpression") {
    const nw = init as NewExpression;
    if (nw.callee.type !== "Identifier") return null;
    const name = (nw.callee as Identifier).name;
    const targs = (nw as { typeArguments?: { params?: TSType[] } }).typeArguments
      ?.params;
    try {
      if (name === "Map" && targs?.[0] && targs?.[1]) {
        return {
          kind: "hashmap",
          key: lowerMapKeyType(targs[0], structs),
          value: lowerType(targs[1], structs),
        };
      }
      if (name === "Set" && targs?.[0]) {
        return { kind: "set", elem: lowerMapKeyType(targs[0], structs) };
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * `xs.forEach(p => body)` → `for &p in xs.iter() { body }` (series 027-cl) — a
 * statement, so it is recognized here (before generic expression lowering) rather
 * than in `lowerCall`. The `&p` pattern copies each Copy element out of the
 * `.iter()` borrow. Returns null when `stmt` is not a `forEach` call.
 */
export function tryForEach(
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

/** Is `e` a direct call to a declared generator (`g()`) — an `impl Iterator`
 * source for the 065 collecting consumers? */
export function isGeneratorCall(e: Expression, analysis: ModuleAnalysis): boolean {
  return (
    e.type === "CallExpression" &&
    (e as CallExpression).callee.type === "Identifier" &&
    analysis.generators.has(
      ((e as CallExpression).callee as Identifier).name,
    )
  );
}

/** Is `e` an `Array.from(src, fn)` mapping-overload call (series 075)? */
export function isArrayFromMapCall(e: Expression): boolean {
  if (e.type !== "CallExpression") return false;
  const call = e as CallExpression;
  if (call.callee.type !== "MemberExpression") return false;
  const m = call.callee as MemberExpression;
  return (
    m.object.type === "Identifier" &&
    (m.object as Identifier).name === "Array" &&
    m.property.type === "Identifier" &&
    (m.property as Identifier).name === "from" &&
    call.arguments.length === 2
  );
}

/**
 * If `e` is a manual generator step `<recv>.next()` / `<recv>.next(v)` — where
 * `<recv>` is a direct generator call `g()` or a generator-instance binding `it`
 * (`const it = g()`) — return `{ recvExpr, genName, sent }` (`sent` the send-value
 * argument of a bidirectional `.next(v)`, series 076, else `null` for a bare
 * `.next()`). Otherwise null. (Series 075/076.)
 */
export function resolveGeneratorNext(
  e: Expression,
  analysis: ModuleAnalysis,
): { recvExpr: Expression; genName: string; sent: Expression | null } | null {
  if (e.type !== "CallExpression") return null;
  const call = e as CallExpression;
  if (call.callee.type !== "MemberExpression") return null;
  // A bare `.next()` (075) or a single-arg `.next(v)` send (076); more args isn't a
  // generator step.
  if (call.arguments.length > 1) return null;
  const sent = (call.arguments[0] as Expression | undefined) ?? null;
  const m = call.callee as MemberExpression;
  if (
    m.property.type !== "Identifier" ||
    (m.property as Identifier).name !== "next"
  ) {
    return null;
  }
  if (isGeneratorCall(m.object as Expression, analysis)) {
    return {
      recvExpr: m.object as Expression,
      genName: ((m.object as CallExpression).callee as Identifier).name,
      sent,
    };
  }
  if (
    m.object.type === "Identifier" &&
    analysis.generatorInstances.has((m.object as Identifier).name)
  ) {
    return {
      recvExpr: m.object as Expression,
      genName: analysis.generatorInstances.get(
        (m.object as Identifier).name,
      ) as string,
      sent,
    };
  }
  return null;
}

/**
 * Whole-program pre-scan (series 075) → `analysis.steppedGenerators`: the set of
 * generator names consumed by a manual `step()` surface, which must therefore lower
 * to the state-machine struct (never the straight-line fast path). Three triggers:
 *   - a manual `.next()` — `g().next()` or `it.next()` where `it` is a
 *     generator-instance binding (`const it = g()`, tracked here);
 *   - a fixed-arity destructure `const [a, b] = g()`;
 *   - a `yield*` whose completion value is read (`const r = yield* inner()`), which
 *     needs the delegate boxed as `dyn Steppable`.
 * Name-based (matching the rest of this intra-procedural analysis).
 */
export function collectSteppedGenerators(
  program: Program,
  analysis: ModuleAnalysis,
): void {
  const stepped = analysis.steppedGenerators;
  // Binding → generator fn name, from `const it = g()` over a known generator.
  const instances = new Map<string, string>();
  const genOf = (e: unknown): string | null => {
    if (
      e &&
      typeof e === "object" &&
      (e as { type?: string }).type === "CallExpression" &&
      isGeneratorCall(e as Expression, analysis)
    ) {
      return ((e as CallExpression).callee as Identifier).name;
    }
    return null;
  };

  // Pass 1: record generator-instance bindings so `it.next()` resolves.
  const scanBindings = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) scanBindings(c);
      return;
    }
    const n = node as { type?: string; declarations?: unknown[] };
    if (n.type === "VariableDeclaration") {
      for (const d of n.declarations ?? []) {
        const dd = d as { id?: { type?: string; name?: string }; init?: unknown };
        if (dd.id?.type === "Identifier" && dd.id.name) {
          const g = genOf(dd.init);
          if (g) instances.set(dd.id.name, g);
        }
      }
    }
    for (const v of Object.values(n)) scanBindings(v);
  };
  scanBindings(program);
  for (const [k, v] of instances) analysis.generatorInstances.set(k, v);

  // Pass 1b: mark **bidirectional** generators (series 076) — those whose body reads
  // a `yield` result (`const x = yield e`, a VariableDeclaration whose init is a
  // non-delegate `YieldExpression`). Their consumers route `.next(v)` → `resume(v)`.
  for (const stmt of program.body) {
    if (
      (stmt as { type?: string }).type === "FunctionDeclaration" &&
      (stmt as { generator?: boolean }).generator === true
    ) {
      const gname = (stmt as { id?: { name?: string } }).id?.name;
      const gbody = (stmt as { body?: unknown }).body;
      if (gname && readsYieldResult(gbody)) {
        analysis.bidirectionalGenerators.add(gname);
      }
    }
  }

  // Pass 2: find the manual-step trigger sites.
  const scan = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) scan(c);
      return;
    }
    const n = node as {
      type?: string;
      callee?: unknown;
      object?: unknown;
      property?: { name?: string };
      declarations?: unknown[];
      argument?: unknown;
      delegate?: boolean;
    };
    // `<recv>.next()` — a manual step over a generator call or instance binding.
    if (
      n.type === "CallExpression" &&
      (n.callee as { type?: string })?.type === "MemberExpression"
    ) {
      const m = n.callee as MemberExpression;
      if (
        m.property.type === "Identifier" &&
        (m.property as Identifier).name === "next"
      ) {
        const direct = genOf(m.object);
        if (direct) stepped.add(direct);
        else if (
          m.object.type === "Identifier" &&
          instances.has((m.object as Identifier).name)
        ) {
          stepped.add(instances.get((m.object as Identifier).name) as string);
        }
      }
    }
    // `const [a, b] = g()` — a fixed-arity generator destructure.
    if (n.type === "VariableDeclaration") {
      for (const d of n.declarations ?? []) {
        const dd = d as { id?: { type?: string }; init?: unknown };
        if (dd.id?.type === "ArrayPattern") {
          const g = genOf(dd.init);
          if (g) stepped.add(g);
        }
        // `const r = yield* inner()` — a read `yield*` completion value.
        const init = dd.init as { type?: string; delegate?: boolean; argument?: unknown } | undefined;
        if (init?.type === "YieldExpression" && init.delegate) {
          const g = genOf(init.argument);
          if (g) stepped.add(g);
        }
      }
    }
    for (const v of Object.values(n)) scan(v);
  };
  scan(program);
}

/**
 * Does this generator body **read** a `yield` result (`const x = yield e`, series
 * 076)? Scans for a VariableDeclaration whose init is a non-delegate
 * `YieldExpression`, without descending into nested functions (their `yield`s bind
 * to a different generator). Marks the generator bidirectional.
 */
function readsYieldResult(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as {
    type?: string;
    id?: { name?: string };
    init?: { type?: string; delegate?: boolean };
    declarations?: unknown[];
  };
  // Don't descend into a nested function — its `yield`s are a different generator.
  if (
    n.type === "FunctionExpression" ||
    n.type === "ArrowFunctionExpression" ||
    n.type === "FunctionDeclaration"
  ) {
    return false;
  }
  if (n.type === "VariableDeclaration") {
    for (const d of n.declarations ?? []) {
      const dd = d as {
        id?: { type?: string };
        init?: { type?: string; delegate?: boolean } | null;
      };
      if (
        dd.init?.type === "YieldExpression" &&
        !dd.init.delegate &&
        dd.id?.type === "Identifier"
      ) {
        return true;
      }
    }
  }
  for (const v of Object.values(n)) {
    if (Array.isArray(v)) {
      for (const c of v) if (readsYieldResult(c)) return true;
    } else if (readsYieldResult(v)) {
      return true;
    }
  }
  return false;
}

/** Is `e` a call to `Object.entries(...)` (series 043)? */
export function isObjectEntriesCall(e: Expression): boolean {
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

export function lowerMember(
  member: MemberExpression,
  analysis: ModuleAnalysis,
): HirExpr {
  if (member.computed) {
    // Positional group index on a first-match result (series 101) — `m![i]` →
    // `m.unwrap().get(i)` → `Option<String>` (`None` = out-of-range / a
    // non-participating group → JS `undefined`, the 066 model). Gated on the base
    // (through `!`) being a `matchBindings` name; the `!` lowers to `.unwrap()`.
    const posMatch = matchBindingName(member.object, analysis);
    if (posMatch) {
      return {
        kind: "method",
        receiver: matchBorrowUnwrap(posMatch),
        name: "get",
        args: [lowerExpr(member.property, analysis)],
      };
    }
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
    // A *variable*-key read of a `Map`/`Record` (series 061) → `m.get(&k).cloned()`
    // → `Option` (JS `V | undefined`). A literal-key read keeps the index form
    // (proven-present record access, series 010). Maps are never `Vec`-indexed.
    const collTy = collectionOf(member.object, analysis);
    if (collTy?.kind === "hashmap" && member.property.type !== "Literal") {
      const key = wrapKey(lowerExpr(member.property, analysis), collTy.key, true);
      return {
        kind: "method",
        receiver: {
          kind: "method",
          receiver: lowerExpr(member.object, analysis),
          name: "get",
          args: [refExpr(key)],
        },
        name: "cloned",
        args: [],
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
    // Named-group access on a first-match result (series 101) — `m!.groups!.name`
    // → `m.unwrap().group("name")` → `Option<String>` (`None` = non-participating
    // → JS `undefined`). Detects the `.groups` hop (through the optional `!`s)
    // whose base is a `matchBindings` name; the innermost `!` lowers to `.unwrap()`.
    {
      const groupsMember = peelNonNull(member.object);
      const groupBase =
        groupsMember.type === "MemberExpression" &&
        !(groupsMember as MemberExpression).computed &&
        (groupsMember as MemberExpression).property.type === "Identifier" &&
        ((groupsMember as MemberExpression).property as Identifier).name ===
          "groups"
          ? matchBindingName((groupsMember as MemberExpression).object, analysis)
          : null;
      if (groupBase) {
        return {
          kind: "method",
          receiver: matchBorrowUnwrap(groupBase),
          name: "group",
          args: [{ kind: "raw", text: rustStrLit(prop) }],
        };
      }
    }
    // Bare `Math.random` as a *value* (uncalled, e.g. assigned or passed) is
    // fail-loud (series 089) — redirect to `rng(seed)` from "@ttr/std". The
    // *called* form `Math.random()` is caught earlier in `lowerNumberStatic`.
    if (
      member.object.type === "Identifier" &&
      (member.object as Identifier).name === "Math" &&
      prop === "random"
    ) {
      throw new UnsupportedError({
        type: '`Math.random` is not accepted — import `rng` from "@ttr/std" and call `rng(seed)` (an explicit seed makes the stream differential-stable)',
      });
    }
    // `@ttr/std` `http.get`/`post` result (series 100): `.status`/`.ok` read the
    // public `HttpResponse` fields; `.body` is the `self`-consuming `body()`
    // accessor. Routed by the binding being a recorded `httpResponseBindings`
    // name (`const res = await http.get(u)`). An unknown member is fail-loud.
    if (
      member.object.type === "Identifier" &&
      analysis.httpResponseBindings.has((member.object as Identifier).name)
    ) {
      if (prop === "status" || prop === "ok") {
        return {
          kind: "field",
          object: lowerExpr(member.object, analysis),
          name: prop,
        };
      }
      if (prop === "body") {
        return {
          kind: "method",
          receiver: lowerExpr(member.object, analysis),
          name: "body",
          args: [],
        };
      }
      throw new UnsupportedError({
        type: `\`.${prop}\` on an http response — only \`.status\`, \`.ok\`, \`.body\` are available`,
      });
    }
    // `@ttr/std` `parseJson<T>` result (series 084): `.ok` is the `ParseResult`
    // discriminant field; `.value`/`.error` are the borrowing accessors
    // `.value()`/`.error()` (usable under a proven-`ok`/`!ok` branch). Routed by
    // the binding being a recorded `parseResultBindings` name.
    if (
      member.object.type === "Identifier" &&
      analysis.parseResultBindings.has((member.object as Identifier).name)
    ) {
      if (prop === "ok") {
        return {
          kind: "field",
          object: lowerExpr(member.object, analysis),
          name: "ok",
        };
      }
      if (prop === "value" || prop === "error") {
        return {
          kind: "method",
          receiver: lowerExpr(member.object, analysis),
          name: prop,
          args: [],
        };
      }
      throw new UnsupportedError({
        type: `\`.${prop}\` on a parseJson result — only \`.ok\`, \`.value\`, \`.error\` are available`,
      });
    }
    // A bare member access on a statically-`JsonValue` receiver (series 090). Only
    // `.length` is a property (→ the Rust `.length()` method); every other accessor
    // (`get`/`at`/`asX`/`isX`) is a method and must be *called* (those reach
    // `lowerCall`). Checked before the generic `.length` (which emits `.len()`).
    if (isJsonValueExpr(member.object, analysis)) {
      if (prop === "length") {
        return {
          kind: "method",
          receiver: lowerExpr(member.object, analysis),
          name: "length",
          args: [],
        };
      }
      throw new UnsupportedError({
        type: `\`.${prop}\` on a JsonValue must be called (\`get\`/\`at\`/\`asNumber\`/… are methods); only \`.length\` is a property`,
      });
    }
    // `.length` is a property in TS but a method in Rust. A **string** receiver
    // (series 098) counts Rust `char`s (`.chars().count()`) — JS `.length` counts
    // UTF-16 code units, and the dialect's char-indexed `slice`/`charAt` model
    // makes char-count the consistent choice (byte `.len()` diverges for any
    // non-ASCII). Any other receiver (array/…) keeps `.len()`.
    if (prop === "length") {
      const recv = receiverTypeOf(member.object, analysis);
      const chars = recv?.kind === "String" || recv?.kind === "str";
      return {
        kind: "len",
        object: lowerExpr(member.object, analysis),
        ...(chars ? { chars: true } : {}),
      };
    }
    // `Map`/`Set` `.size` → `.len()` (series 061), routed by receiver type so a
    // user struct field named `size` stays an ordinary field read.
    if (prop === "size") {
      const ty = collectionOf(member.object, analysis);
      if (ty && (ty.kind === "hashmap" || ty.kind === "set")) {
        return { kind: "len", object: lowerExpr(member.object, analysis) };
      }
    }
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
    // `Type.CONST` — a static field read off a class name (series 060) → the Rust
    // associated-const path `Type::CONST`. Accessing a member off the class name
    // is unambiguously static (instance members need a value receiver).
    if (
      member.object.type === "Identifier" &&
      analysis.classes.has((member.object as Identifier).name)
    ) {
      return {
        kind: "path",
        segments: [(member.object as Identifier).name, prop],
      };
    }
    // `Foo.bar` where `Foo` is a namespace (series 050d, Axis 4) or a namespace
    // import alias (`ns.f` after `import * as ns`) → the Rust module path `Foo::bar`
    // / `ns::f`. A property read is a path; a call `Foo.bar()` recurses through
    // here as its callee, so it lowers to the path-call `Foo::bar(...)`.
    if (
      member.object.type === "Identifier" &&
      analysis.namespaces.has((member.object as Identifier).name)
    ) {
      return {
        kind: "path",
        segments: [(member.object as Identifier).name, prop],
      };
    }
    // A getter read `obj.g` (series 060) → the method call `obj.g()`, routed by the
    // receiver's class carrying a getter named `prop`.
    const getterClass = receiverClass(member.object, analysis);
    if (getterClass && analysis.accessors.get(getterClass)?.getters.has(prop)) {
      return {
        kind: "method",
        receiver: lowerExpr(member.object, analysis),
        name: prop,
        args: [],
      };
    }
    // Interface inheritance (series 059): a field read through a base-interface
    // param (`&impl IA`) routes to the by-value getter `a.x()` — all base fields
    // are accessible (no downcast gating; interfaces flatten their bases).
    if (
      member.object.type === "Identifier" &&
      analysis.dynInterfaceBindings.has((member.object as Identifier).name)
    ) {
      return {
        kind: "method",
        receiver: lowerExpr(member.object, analysis),
        name: prop,
        args: [],
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
export function baseHopsToField(
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

// ── Template-string & update (++/--) lowering ────────────────────────────
// Expression-level lowerers re-homed from `types.ts` (series 109 Phase-2 /
// #94): template literals (``a${x}b`` → strConcat) and `++`/`--` in value &
// statement positions. They lower expressions, so they belong with `lowerExpr`.

/**
 * `++`/`--` in a **statement** position (series 096) → the `assign` node `arg += 1`
 * / `arg -= 1`. Prefix/postfix collapse (the produced value is discarded). Supports
 * every target the assign supports — local, field (`this.n++`), index (`a[i]++`).
 */
export function lowerUpdateAssign(
  u: { operator: string; argument: Expression },
  analysis: ModuleAnalysis,
): HirExpr {
  return {
    kind: "assign",
    op: u.operator === "++" ? "+=" : "-=",
    target: lowerExpr(u.argument, analysis),
    value: { kind: "number", value: 1 },
  };
}

/**
 * `++`/`--` in a **value** position (series 096) → the block-temp `update` node
 * (postfix old / prefix new). Restricted to an **identifier** target (no side-effect
 * on the doubly-emitted place); a field/index target used as a value is fail-loud
 * (statement position handles those). `step` embeds the `+= 1` assign so the numeric
 * pass types its `1` as usize/f64 like any `i += 1`.
 */
export function lowerUpdateValue(
  u: { operator: string; prefix: boolean; argument: Expression },
  analysis: ModuleAnalysis,
): HirExpr {
  if (u.argument.type !== "Identifier") {
    throw new UnsupportedError({
      type: "++/-- on a non-identifier target in a value position — assign in a statement",
    });
  }
  return {
    kind: "update",
    prefix: u.prefix,
    target: lowerExpr(u.argument, analysis),
    step: lowerUpdateAssign(u, analysis),
  };
}

/** Display-scalar RustType kinds — an array of these renders via `.join(",")`. */
const TEMPLATE_SCALAR_ELEM = new Set<RustType["kind"]>([
  "f64",
  "i64",
  "i128",
  "usize",
  "String",
  "str",
  "bool",
]);

/**
 * Lower one `${…}` interpolation of a template literal (series 095) to a
 * JS-faithful `String`-producing part (Collin's decision: match JS `String()` for
 * arrays, objects, and optionals, not merely inherit `strConcat`'s cargo boundary).
 * See docs/work/095-template-literals/design.md §"Interpolation classifier".
 */
function lowerTemplatePart(
  expr: Expression,
  analysis: ModuleAnalysis,
): HirExpr {
  // 1. Optional → `tslib::truthy::fmt_opt` (`Some(v)`→`v`, `None`→`undefined`),
  //    the same convention `console.log` uses for an `Option` (series 066).
  if (optionExprType(expr, analysis)) {
    return { kind: "optDisplay", value: lowerExpr(expr, analysis) };
  }
  const ty = receiverTypeOf(expr, analysis);
  if (ty) {
    // 2. Array → JS `Array.prototype.join(",")` over Display-scalar elements
    //    (`${[1,2,3]}` → "1,2,3"); reuses the exact node `arr.join()` lowers to.
    if (ty.kind === "vec") {
      if (!TEMPLATE_SCALAR_ELEM.has(ty.elem.kind)) {
        throw new UnsupportedError({
          type: "template interpolation of a nested/object array — only arrays of string/number/boolean render (JS `.join(\",\")`)",
        });
      }
      return {
        kind: "call",
        callee: "tslib::array::join",
        args: [
          { borrow: "ref", expr: lowerExpr(expr, analysis) },
          { borrow: "owned", expr: { kind: "raw", text: '","' } },
        ],
      };
    }
    // 3. Plain data struct → JS `String(object)` === "[object Object]" (plain
    //    structs derive only Clone+Debug, never Display). A union `enum` is also a
    //    `struct` RustType but has NO field table — it falls through to (6) and
    //    renders via its `Display` inner value (JS-faithful for `string|number`).
    if (ty.kind === "struct" && analysis.structFields.has(ty.name)) {
      return { kind: "jsObjectStr", value: lowerExpr(expr, analysis) };
    }
    // 5. Map/Set/fn-pointer → fail-loud (JS `[object Map]`/`[object Set]`/source
    //    text — niche; a clean signal beats a guess or an opaque cargo error).
    if (ty.kind === "hashmap" || ty.kind === "set" || ty.kind === "fnPtr") {
      throw new UnsupportedError({
        type: `template interpolation of a ${ty.kind} value`,
      });
    }
  }
  // 6. Scalar (String/number/bool), a union enum (Display inner), or an expression
  //    the light typer can't resolve → a plain `Display` part (`format!("{}", x)`),
  //    matching `strConcat`; a truly non-Display untyped part hits the cargo boundary.
  return lowerExpr(expr, analysis);
}

/**
 * Lower a template literal `` `a${x}b` `` (series 095) to the shipped `strConcat`
 * node (series 080) → `format!("{}{}…", …)`. Cooked quasis become `string` parts
 * (the emitter `JSON.stringify`s them, escaping `\n`/`"`/`\`/`{`); empty quasis
 * (a leading/trailing/adjacent hole) are dropped. Each `${…}` is classified by
 * `lowerTemplatePart` for its JS-faithful rendering.
 */
export function lowerTemplate(
  t: {
    quasis: { value: { cooked?: string; raw: string } }[];
    expressions: Expression[];
  },
  analysis: ModuleAnalysis,
): HirExpr {
  const parts: HirExpr[] = [];
  for (let i = 0; i < t.quasis.length; i += 1) {
    const cooked = t.quasis[i]!.value.cooked ?? t.quasis[i]!.value.raw;
    if (cooked.length > 0) parts.push({ kind: "string", value: cooked });
    const hole = t.expressions[i];
    if (hole) parts.push(lowerTemplatePart(hole, analysis));
  }
  return { kind: "strConcat", parts };
}
