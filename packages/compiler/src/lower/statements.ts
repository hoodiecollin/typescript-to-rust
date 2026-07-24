/**
 * Statement lowering: the `lowerStatement` dispatch hub and its whole
 * statement-family — if/for/for-of/while, `switch` dispatch, block lowering,
 * `lowerVarDecl` (the largest single lowerer), the typed-literal path
 * (`lowerTyped` / struct + interface literals), and class-field planning. Two
 * cohesive clusters split out under #94: the discriminated-union / `typeof` /
 * `in` narrowing recognizers `lowerSwitch`/`lowerIf` delegate to → `./narrowing`,
 * and the shared expression-typing predicates (`receiverTypeOf` / `optionExprType`
 * / `truthyCond` / …) the expression and type lowerers lean on → `./typing`.
 *
 * Extracted from the `lower.ts` monolith (series 109, Phase 1) verbatim — no logic
 * change; the byte-identical corpus gate proves it. The typing predicates it calls
 * come from `./typing`, the expression/type lowerers from `./expressions` /
 * `./types`, and the few orchestrator-owned head helpers (`collectionOf` /
 * `structKeyName` / `retargetStructKey`) from `./index`.
 */

import { type ModuleAnalysis, isErrorSubclass } from "../analysis";
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
  Identifier,
  IfStatement,
  LabeledStatement,
  Literal,
  MemberExpression,
  MethodDefinition,
  NewExpression,
  ObjectExpression,
  ObjectPattern,
  Param,
  Program,
  PropertyDefinition,
  Statement,
  SwitchStatement,
  TSInterfaceDeclaration,
  TSType,
  ThrowStatement,
  TryStatement,
  VariableDeclaration,
  WhileStatement,
} from "../ast";
import { DialectError, UnsupportedError } from "../errors";
import type {
  HirExpr,
  HirFn,
  HirMatchArm,
  HirStmt,
  RustType,
} from "../hir";
import { fnv1a } from "../unions";
import { astWalk, collectBoundNames } from "./arrows";
import { isJoinTuple } from "./async";
import { isHeterogeneous, traitNameOf } from "./classes";
import {
  isClockExpr,
  isDateExpr,
  lowerNew,
  mapBuildParts,
} from "./collections";
import { CB_GLOBALS, EMPTY_TYPE_PARAMS, UNIT } from "./constants";
import {
  elementTypeOf,
  inferInitType,
  isArrayFromMapCall,
  isGeneratorCall,
  isObjectEntriesCall,
  lowerExpr,
  lowerUpdateAssign,
  resolveGeneratorNext,
  tryForEach,
} from "./expressions";
import { tryArrayMutStatement } from "./method-routing";
import { collectionOf, retargetStructKey, structKeyName } from "./index";
import type { TSTypeParamDecl } from "./index";
import {
  ioBindingRustType,
  isJsonBoundaryShimCall,
  isJsonValueExpr,
  isParseJsonShimCall,
  isRngMethodInit,
  isRngShimCall,
  isStdIoInit,
  redirectBareJson,
  redirectBareMathRandom,
} from "./io-shim";
import { isPluginCallInit } from "../plugins";
import {
  lowerDiscriminatedSwitch,
  recognizeInIfLadder,
  recognizeTypeofIfLadder,
  recognizeTypeofSwitch,
  recognizeUnionIfLadder,
} from "./narrowing";
import {
  isRegexInit,
  REGEX_MATCH_TYPE,
  regexLiteralInfo,
  regexResultTypeAst,
} from "./regex";
import { lowerThrow, lowerTry } from "./try-carrier";
import { discriminatedScrutinee, lowerType } from "./types";
import {
  isStringAtCall,
  optionExprType,
  receiverTypeOf,
  sourceStructName,
  truthyCond,
} from "./typing";
import {
  coerceLiteralToUnion,
  coerceObjectToUnion,
  coerceScalarToUnion,
  unionTypeOfOperand,
} from "./unions";
import { isAstNode, isNullishExpr } from "./utils";

export function lowerStatements(
  stmts: Statement[],
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt[] {
  return stmts.flatMap((s) => lowerStatement(s, analysis, scope));
}

/** A statement lowers to zero or more HIR statements (one `let` per declarator). */
export function lowerStatement(
  stmt: Statement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt[] {
  switch (stmt.type) {
    case "VariableDeclaration":
      return lowerVarDecl(stmt as VariableDeclaration, analysis, scope);
    case "ReturnStatement": {
      const arg = (stmt as { argument: Expression | null }).argument;
      // Union coercion on return (series 093): a value returned into a union-enum
      // return type constructs its variant (`return "south"` in a fn `: Dir` →
      // `Dir::South`; `return c` where `c: Circle` in a fn `: Shape` →
      // `Shape::Circle(c)`). `lowerTyped` handles literal/object/scalar coercion and
      // passes a value already of the union type straight through.
      if (arg) {
        const retAnn = analysis.fns.get(scope)?.retAnn;
        if (retAnn) {
          const rt = lowerType(retAnn, analysis.structs);
          if (rt.kind === "struct" && analysis.unionEnums.has(rt.name)) {
            return [{ kind: "return", value: lowerTyped(arg, rt, analysis) }];
          }
        }
      }
      return [{ kind: "return", value: arg ? lowerExpr(arg, analysis) : null }];
    }
    case "ExpressionStatement": {
      const e = (stmt as { expression: Expression }).expression;
      // `xs.forEach(p => …)` lowers to a `for` loop (a statement), not an expr.
      const forEach = tryForEach(e, analysis, scope);
      if (forEach) return forEach;
      // Statement-position `a.push(x)` / `a.unshift(x)` (series 116) — a bare mutation
      // (the JS return length is discarded), not the length-yielding value block.
      const arrMut = tryArrayMutStatement(e, analysis);
      if (arrMut) return arrMut;
      // A statement-position `x++;` (series 096) — including the async/generator
      // batch for-update, which re-wraps the update as an `ExpressionStatement` —
      // lowers to a bare `x += 1` (no block-temp), supporting field/index targets.
      if (e.type === "UpdateExpression") {
        return [
          {
            kind: "expr",
            expr: lowerUpdateAssign(
              e as unknown as { operator: string; argument: Expression },
              analysis,
            ),
          },
        ];
      }
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
    case "LabeledStatement":
      return [lowerLabeled(stmt as LabeledStatement, analysis, scope)];
    case "BreakStatement": {
      const label = (stmt as BreakStatement).label;
      return [{ kind: "break", label: label ? label.name : undefined }];
    }
    case "ContinueStatement": {
      const label = (stmt as ContinueStatement).label;
      return [{ kind: "continue", label: label ? label.name : undefined }];
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
  // Discriminated-union `if`-ladder (series 093, 1b): `if (sh.kind === "circle") …
  // else if (sh.kind === "square") …` → a variant `match sh`. Runs first.
  const ladder = recognizeUnionIfLadder(stmt, analysis, scope);
  if (ladder) return ladder;
  // `typeof`-narrowing `if`-ladder over a primitive/mixed union (series 093, 1d, F).
  const typeofLadder = recognizeTypeofIfLadder(stmt, analysis, scope);
  if (typeofLadder) return typeofLadder;
  // `"field" in x` narrowing `if`-ladder over a non-discriminated union (093, 1e, E).
  const inLadder = recognizeInIfLadder(stmt, analysis, scope);
  if (inLadder) return inLadder;
  // Truthiness narrowing (series 066, design E/TR7): a bare `if (opt)` over an
  // `Option<T>` binding narrows on presence → `if let Some(opt) = opt { … }`
  // (absence is falsy). This is the presence-narrowing analog of the explicit
  // `!== undefined` form below; it makes the inner `T` usable in the `then` branch.
  if (
    stmt.test.type === "Identifier" &&
    optionExprType(stmt.test, analysis)
  ) {
    const name = (stmt.test as Identifier).name;
    return {
      kind: "ifLet",
      binding: name,
      scrutinee: { kind: "ident", name },
      someBody: lowerNarrowedBlock(name, stmt.consequent, analysis, scope),
      noneBody: stmt.alternate
        ? lowerBlock(stmt.alternate, analysis, scope)
        : null,
    };
  }
  // Option narrowing (series 042c): `if (x !== undefined) { … }` →
  // `if let Some(x) = x { … }`, so `x` is the inner `T` inside the block. The
  // `=== undefined` form narrows the *else* branch (branches swap). Inside the
  // some-body `x` is the narrowed `T` (series 066: skip the arithmetic guard).
  const narrow = optionNarrowTest(stmt.test);
  if (narrow) {
    const scrutinee: HirExpr = { kind: "ident", name: narrow.name };
    if (narrow.op === "!==") {
      return {
        kind: "ifLet",
        binding: narrow.name,
        scrutinee,
        someBody: lowerNarrowedBlock(narrow.name, stmt.consequent, analysis, scope),
        noneBody: stmt.alternate
          ? lowerBlock(stmt.alternate, analysis, scope)
          : null,
      };
    }
    // `=== undefined`: the present-value branch is the `else`; narrow only when
    // it exists (a bare `if (x === undefined)` uses the `is_none()` condition).
    if (stmt.alternate) {
      return {
        kind: "ifLet",
        binding: narrow.name,
        scrutinee,
        someBody: lowerNarrowedBlock(narrow.name, stmt.alternate, analysis, scope),
        noneBody: lowerBlock(stmt.consequent, analysis, scope),
      };
    }
  }
  return {
    kind: "if",
    // A non-`bool` condition (`if (n)` / `if (s)`, series 066) uses JS truthiness.
    cond: truthyCond(stmt.test, analysis),
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
  // `===`/`!==` (strict) and `==`/`!=` (loose — catches both `null` and `undefined`
  // spellings, series 066/NR2) all narrow the same; loose folds to its strict twin.
  const strict: Record<string, "===" | "!==" | undefined> = {
    "===": "===",
    "!==": "!==",
    "==": "===",
    "!=": "!==",
  };
  const op = strict[b.operator];
  if (!op) return null;
  const leftNull = isNullishExpr(b.left);
  const rightNull = isNullishExpr(b.right);
  if (leftNull === rightNull) return null;
  const idExpr = leftNull ? b.right : b.left;
  if (idExpr.type !== "Identifier") return null;
  return { name: (idExpr as Identifier).name, op };
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
/**
 * Lower a labeled loop `label: <loop>` (series 064). The label threads to the
 * loop HIR node (`while`/`forIn`, or the `while` inside a C-`for`'s desugar block,
 * carried to a `forRange` by `promoteRanges`), so `break`/`continue label` render
 * `break 'label`/`continue 'label`. Only a loop may be labeled; a non-loop labeled
 * statement is fail-loud (Rust labels loops/blocks, not arbitrary statements).
 */
function lowerLabeled(
  stmt: LabeledStatement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt {
  const label = stmt.label.name;
  const inner = stmt.body;
  if (inner.type === "ForStatement") {
    return lowerFor(inner as ForStatement, analysis, scope, label);
  }
  if (inner.type === "ForOfStatement") {
    return lowerForOf(inner as ForOfStatement, analysis, scope, label);
  }
  if (inner.type === "WhileStatement") {
    const w = inner as WhileStatement;
    return {
      kind: "while",
      cond: lowerExpr(w.test, analysis),
      body: lowerBlock(w.body, analysis, scope),
      label,
    };
  }
  throw new UnsupportedError({
    type: "a label on a non-loop statement (only loops may be labeled)",
  });
}

function lowerFor(
  stmt: ForStatement,
  analysis: ModuleAnalysis,
  scope: string,
  label?: string,
): HirStmt {
  const init: HirStmt[] = stmt.init
    ? stmt.init.type === "VariableDeclaration"
      ? lowerVarDecl(stmt.init as VariableDeclaration, analysis, scope)
      : [{ kind: "expr", expr: lowerExpr(stmt.init as Expression, analysis) }]
    : [];

  const update: HirStmt | null = stmt.update
    ? {
        kind: "expr",
        // The `for` update slot is a statement position: `i++` → `i += 1` (series
        // 096), not the value-position block-temp.
        expr:
          stmt.update.type === "UpdateExpression"
            ? lowerUpdateAssign(
                stmt.update as unknown as {
                  operator: string;
                  argument: Expression;
                },
                analysis,
              )
            : lowerExpr(stmt.update, analysis),
      }
    : null;

  let body = lowerBlock(stmt.body, analysis, scope);
  // A `continue` skips the bottom `update`; inline the update before each so the
  // loop variable still advances. Covers a bare `continue` (own) and — when this
  // loop is labeled (064) — a `continue <label>` nested in an inner loop.
  if (update) {
    body = inlineUpdateBeforeContinue(body, update, label, true);
    body.push(update);
  }

  const cond: HirExpr = stmt.test
    ? lowerExpr(stmt.test, analysis)
    : { kind: "bool", value: true };

  return {
    kind: "block",
    body: [...init, { kind: "while", cond, body, label }],
  };
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
  label: string | undefined,
  ownScope: boolean,
): HirStmt[] {
  return stmts.map((s) => inlineUpdateInStmt(s, update, label, ownScope));
}

/**
 * Inline `update` before each `continue` that advances *this* loop. `ownScope` is
 * true at the loop's own level (a bare `continue` targets it) and false once we
 * descend into a nested loop (a bare `continue` there belongs to the inner loop —
 * already handled by its own desugar; only a `continue <label>` targeting *this*
 * loop still needs the update). `if`/`block`/`match` are transparent to `continue`.
 */
function inlineUpdateInStmt(
  stmt: HirStmt,
  update: HirStmt,
  label: string | undefined,
  ownScope: boolean,
): HirStmt {
  switch (stmt.kind) {
    case "continue": {
      const targetsThis =
        (ownScope && !stmt.label) || (label != null && stmt.label === label);
      return targetsThis
        ? { kind: "block", body: [update, stmt], fromForContinue: true }
        : stmt;
    }
    case "if":
      return {
        kind: "if",
        cond: stmt.cond,
        conseq: inlineUpdateBeforeContinue(stmt.conseq, update, label, ownScope),
        alt: stmt.alt
          ? inlineUpdateBeforeContinue(stmt.alt, update, label, ownScope)
          : null,
      };
    case "block":
      return {
        kind: "block",
        body: inlineUpdateBeforeContinue(stmt.body, update, label, ownScope),
      };
    case "match":
      return {
        kind: "match",
        disc: stmt.disc,
        arms: stmt.arms.map((a) => ({
          ...a,
          body: inlineUpdateBeforeContinue(a.body, update, label, ownScope),
        })),
      };
    case "while":
    case "forIn":
    case "forRange":
      // A nested loop: descend only to reach a `continue <label>` targeting *this*
      // loop (ownScope false — its own bare `continue`s are already handled).
      return label == null
        ? stmt
        : mapLoopBody(stmt, (b) =>
            inlineUpdateBeforeContinue(b, update, label, false),
          );
    default:
      return stmt;
  }
}

/** Rebuild a loop statement with its body passed through `f` (series 064). */
function mapLoopBody(
  stmt: Extract<HirStmt, { kind: "while" | "forIn" | "forRange" }>,
  f: (body: HirStmt[]) => HirStmt[],
): HirStmt {
  return { ...stmt, body: f(stmt.body) };
}

/**
 * Lower `for (const val of arr) body` to `for val in arr.iter() { body }`.
 * `.iter()` iterates by reference — sound whether the iterable is owned or
 * borrowed, never consuming it — so the loop binding is `&T`. Only a single
 * identifier binding is supported; destructuring throws (see design 008).
 */
export function lowerForOf(
  stmt: ForOfStatement,
  analysis: ModuleAnalysis,
  scope: string,
  label?: string,
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
    // f64-bearing struct key (series 074): the map yields `(&<Struct>Key, &V)`, so
    // destructure the newtype in the pattern — `for (<Struct>Key(k), v) in m.iter()`
    // binds `k: &<Struct>`, unwrapping the key transparently for the body.
    const keyTy = collectionOf(target, analysis);
    const kPat =
      keyTy?.kind === "hashmap" && keyTy.key.kind === "structKey"
        ? `${structKeyName(keyTy.key.name)}(${k.name})`
        : k.name;
    return {
      kind: "forIn",
      pat: `(${kPat}, ${v.name})`,
      iter: {
        kind: "method",
        receiver: lowerExpr(target, analysis),
        name: "iter",
        args: [],
      },
      body: lowerBlock(stmt.body, analysis, scope),
      label,
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
  // A **non-defaultable** `TNext` bidirectional generator (series 076) has no `impl
  // Iterator` (only `resume`), so `for-of` over it can't send a faithful default —
  // fail-loud. A defaultable `TNext` keeps `impl Iterator` (the loop sends the
  // `undefined`-model default), so it iterates fine.
  if (overGenerator) {
    const gName = ((stmt.right as CallExpression).callee as Identifier).name;
    if (
      analysis.bidirectionalGenerators.has(gName) &&
      analysis.generatorNextTypes.get(gName)?.kind !== "option"
    ) {
      throw new UnsupportedError({
        type: "for-of over a bidirectional generator with a non-defaultable resume-in type `TNext` — the loop can't send a faithful default (only `resume(v)` can drive it); annotate `TNext` to include `undefined` for a for-of surface (fail-loud residual, series 076)",
      });
    }
  }
  // Named-struct destructuring `for (const { x, y } of pts)` (series 064) → a Rust
  // struct pattern `for Point { x, y } in &pts`. Same "named/statically-shaped
  // only" boundary as 058's destructuring params: an anonymous element is
  // fail-loud. Borrow mode (the fields read `&T`); mutation/consume of a
  // destructured element is out of scope.
  if (declId.type === "ObjectPattern") {
    const structPat = destructureForOfPattern(stmt, analysis);
    return {
      kind: "forIn",
      pat: structPat,
      iter: {
        kind: "method",
        receiver: lowerExpr(stmt.right, analysis),
        name: "iter",
        args: [],
      },
      body: lowerBlock(stmt.body, analysis, scope),
      label,
    };
  }
  // for-of element ownership (series 064): a read-only element iterates `&xs`
  // (the default `.iter()`); an element *mutated in place* (`x.f = …`) iterates
  // `&mut xs`, binding `&mut T`. Only for a plain identifier binding over a
  // non-generator, non-`dyn` iterable — the consume→owned/cloned case (needing
  // liveness of `xs` after the loop) stays a fail-loud residual.
  const elemName = decl.id.name;
  const isDyn =
    stmt.right.type === "Identifier" &&
    analysis.dynBindings.has((stmt.right as Identifier).name);
  const mutatesElement =
    !overGenerator &&
    !isDyn &&
    elemName != null &&
    forOfElementMutated(stmt.body, elemName);

  // `for (const m of s.matchAll(re))` (series 101): the source is a
  // `Vec<Vec<String>>`, so each element `m` is a `Vec<String>` (`[full, g1, …]`).
  // Record its binding type so `m[i]` indexes the group array. Set before the
  // body lowers.
  const reSrcTy = regexResultTypeAst(stmt.right, analysis);
  if (
    reSrcTy?.kind === "vec" &&
    reSrcTy.elem.kind === "vec" &&
    elemName != null
  ) {
    analysis.bindingTypes.set(elemName, reSrcTy.elem);
  }
  const iter: HirExpr =
    overGenerator || mutatesElement
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
  if (isDyn) {
    const base = analysis.dynBindings.get(
      (stmt.right as Identifier).name,
    ) as string;
    analysis.dynBindings.set(decl.id.name, base);
  }
  // f64-bearing struct-key `Set` (series 074): the set yields `&<Struct>Key`, so
  // destructure the newtype — `for <Struct>Key(x) in s.iter()` binds `x: &<Struct>`.
  const elemTy = collectionOf(stmt.right, analysis);
  const pat =
    elemTy?.kind === "set" && elemTy.elem.kind === "structKey"
      ? `${structKeyName(elemTy.elem.name)}(${decl.id.name})`
      : decl.id.name;
  return {
    kind: "forIn",
    pat,
    iter,
    body: lowerBlock(stmt.body, analysis, scope),
    label,
    mode: mutatesElement ? "refMut" : undefined,
  };
}

/**
 * Build a Rust struct pattern for a `for (const { … } of xs)` destructuring
 * (series 064) — `Point { x, y }` from the element struct of `xs`. Only shorthand
 * field bindings (`{ x }`, not `{ x: renamed }`) over a statically-known named
 * struct element are supported; anything else is fail-loud.
 */
function destructureForOfPattern(
  stmt: ForOfStatement,
  analysis: ModuleAnalysis,
): string {
  const elem = elementTypeOf(stmt.right, analysis);
  if (elem.kind !== "struct") {
    throw new UnsupportedError({
      type: "for-of object destructuring over a non-named-struct element",
    });
  }
  const pattern = stmt.left.declarations[0]?.id as unknown as ObjectPattern;
  const fields = pattern.properties.map((p) => {
    const key = p.key as unknown as { type: string; name?: string };
    const value = p.value as unknown as { type: string; name?: string };
    if (
      p.computed ||
      key.type !== "Identifier" ||
      value.type !== "Identifier" ||
      key.name !== value.name
    ) {
      throw new UnsupportedError({
        type: "for-of object destructuring supports only shorthand field bindings (`{ x, y }`)",
      });
    }
    return key.name as string;
  });
  return `${elem.name} { ${fields.join(", ")} }`;
}

/**
 * Does the for-of body mutate its element binding `name` *in place* — an
 * assignment whose target is `name` or a member access rooted at `name`
 * (`name.f = …`, `name.a.b = …`)? Such a loop iterates `&mut xs` (series 064).
 * Purely syntactic over the AST body; a nested closure/loop is still scanned
 * (a mutation anywhere needs the mutable borrow).
 */
function forOfElementMutated(body: Statement, name: string): boolean {
  let found = false;
  const rootedAt = (node: unknown): boolean => {
    if (!isAstNode(node)) return false;
    if (node.type === "Identifier") return node.name === name;
    if (node.type === "MemberExpression") return rootedAt(node.object);
    return false;
  };
  const visit = (node: unknown): void => {
    if (found) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isAstNode(node)) return;
    if (node.type === "AssignmentExpression" && rootedAt(node.left)) {
      found = true;
      return;
    }
    for (const key in node) {
      if (key === "type") continue;
      visit((node as Record<string, unknown>)[key]);
    }
  };
  visit(body);
  return found;
}

/**
 * Lower `switch (disc) { … }` to a `match`. Consecutive **empty** `case` labels
 * that share a body fold into one arm (series 064's or-pattern) — `case 1: case 2:
 * body` → the tests `[1, 2]` on one arm. Two arm shapes result:
 *
 *  - **String scrutinee** (a `String`-typed discriminant, all case tests string
 *    literals): idiomatic `match s.as_str() { "a" | "b" => …, _ => … }` — literal
 *    string patterns, the scrutinee borrowed as `&str` (series 064).
 *  - **Otherwise**: guarded wildcard `_ if disc == a || disc == b => …` (Rust
 *    forbids `f64` literal patterns). An integer switch is later upgraded to
 *    literal / or / range patterns by `promoteMatches` (numeric.ts).
 *
 * Rust `match` has no fall-through: a *bodied* case must terminate with `break`
 * (stripped) or `return`; a non-terminating non-final case throws. A synthetic
 * `_ => {}` is appended when there is no `default`, so the match is exhaustive.
 */
export function lowerSwitch(
  stmt: SwitchStatement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt {
  // Discriminated-union `switch (obj.kind)` (series 093, 1b) → a variant `match obj`
  // that binds each read field and rewrites `obj.field` → `field` in the arm. Runs
  // before the generic fold below since it needs the *raw* case bodies.
  const discSc = discriminatedScrutinee(stmt.discriminant, analysis);
  if (discSc) return lowerDiscriminatedSwitch(stmt, discSc, analysis, scope);
  // `switch (typeof x)` over a primitive/mixed union (series 093, 1d, F) → variant match.
  const typeofSwitch = recognizeTypeofSwitch(stmt, analysis, scope);
  if (typeofSwitch) return typeofSwitch;

  const disc = lowerExpr(stmt.discriminant, analysis);

  // Fold consecutive empty (stacked) cases into the next bodied case's tests.
  const folded: { tests: Expression[]; body: HirStmt[] }[] = [];
  let pending: Expression[] = [];
  let defaultArm: HirMatchArm | null = null;

  stmt.cases.forEach((c, i) => {
    const isLast = i === stmt.cases.length - 1;
    if (c.test === null) {
      defaultArm = {
        guard: null,
        body:
          c.consequent.length === 0
            ? []
            : lowerSwitchCaseBody(c.consequent, isLast, analysis, scope),
      };
      return;
    }
    if (c.consequent.length === 0) {
      pending.push(c.test); // a stacked `case v:` sharing the next body
      return;
    }
    const body = lowerSwitchCaseBody(c.consequent, isLast, analysis, scope);
    folded.push({ tests: [...pending, c.test], body });
    pending = [];
  });
  if (pending.length > 0) {
    throw new UnsupportedError({
      type: "trailing empty switch case with no shared body",
    });
  }

  // Union-enum scrutinee (series 093): `switch (d)` over a `Dir` binding → a
  // `match d { Dir::North => …, … }` with variant patterns. A `_ => {}` default is
  // appended only when the arms aren't exhaustive (or a `default` was written), so
  // an exhaustive switch emits no unreachable wildcard.
  const discUnion =
    stmt.discriminant.type === "Identifier"
      ? unionTypeOfOperand(stmt.discriminant, analysis)
      : null;
  if (discUnion) {
    const info = analysis.unionEnums.get(discUnion)!;
    const arms: HirMatchArm[] = folded.map(({ tests, body }) => {
      const pats = tests.map((t) => {
        const variant = coerceLiteralToUnion(t, discUnion, analysis);
        if (!variant) {
          throw new UnsupportedError({
            type: `switch case is not a variant of union '${discUnion}'`,
          });
        }
        return variant;
      });
      return pats.length === 1
        ? { guard: null, pat: pats[0], body }
        : { guard: null, pats, body };
    });
    const covered = new Set(
      arms.flatMap((a) =>
        (a.pats ?? (a.pat ? [a.pat] : [])).map((p) =>
          p.kind === "enumVariant" ? p.variant : "",
        ),
      ),
    );
    if (defaultArm) arms.push(defaultArm);
    else if (covered.size < info.variants.length)
      arms.push({ guard: null, body: [] });
    return { kind: "match", disc, arms };
  }

  // String scrutinee → literal `&str` patterns over `s.as_str()` (series 064).
  const discName =
    stmt.discriminant.type === "Identifier"
      ? (stmt.discriminant as Identifier).name
      : null;
  const isStringScrutinee =
    discName != null &&
    analysis.bindingTypes.get(discName)?.kind === "String" &&
    folded.every((f) => f.tests.every(isStringLiteralExpr));

  const arms: HirMatchArm[] = folded.map(({ tests, body }) => {
    if (isStringScrutinee) {
      const pats: HirExpr[] = tests.map((t) => ({
        kind: "string",
        value: (t as Literal).value as string,
      }));
      return pats.length === 1
        ? { guard: null, pat: pats[0], body }
        : { guard: null, pats, body };
    }
    const eqs = tests.map<HirExpr>((t) => ({
      kind: "binary",
      op: "==",
      left: disc,
      right: lowerExpr(t, analysis),
    }));
    const guard = eqs.reduce((acc, e) => ({
      kind: "binary",
      op: "||",
      left: acc,
      right: e,
    }));
    return { guard, body };
  });

  arms.push(defaultArm ?? { guard: null, body: [] });
  const matchDisc: HirExpr = isStringScrutinee
    ? { kind: "method", receiver: disc, name: "as_str", args: [] }
    : disc;
  return { kind: "match", disc: matchDisc, arms };
}

/** Is `e` a string-literal expression (a `case "x":` test)? */
function isStringLiteralExpr(e: Expression): boolean {
  return e.type === "Literal" && typeof (e as Literal).value === "string";
}

/** Lower a case body, enforcing the terminator rule and stripping a trailing `break`. */
export function lowerSwitchCaseBody(
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
export function lowerBlock(
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
 * Lower a block with `name` marked narrowed-to-`T` (series 066): inside an
 * `if let Some(name)` some-body, `name` is a plain `T`. Adds the name to
 * `narrowedOptions` for the duration, restoring the prior state after (a shadowed
 * outer optional of the same name is preserved).
 */
function lowerNarrowedBlock(
  name: string,
  block: Statement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt[] {
  const had = analysis.narrowedOptions.has(name);
  analysis.narrowedOptions.add(name);
  try {
    return lowerBlock(block, analysis, scope);
  } finally {
    if (!had) analysis.narrowedOptions.delete(name);
  }
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

/** Bitwise operators whose result type is inferred by construction (series 056). */
const BITWISE_OPS = new Set(["&", "|", "^", "<<", ">>", ">>>"]);

/**
 * Does an initializer contain a bitwise operator (series 056)? A bitwise result is
 * typed by construction (`refineBitwise` widens it to `i128`, or coerces it to
 * `f64` at a float boundary), so — like `Object.entries` / `<array>.find` — an
 * untyped binding to one needs no annotation. Recurses through arithmetic so
 * `const x = (a & b) + 1` is covered too.
 */
function isBitwiseInit(e: Expression | null): boolean {
  if (e == null) return false;
  if (e.type === "BinaryExpression") {
    const b = e as { operator: string; left: Expression; right: Expression };
    if (BITWISE_OPS.has(b.operator)) return true;
    return isBitwiseInit(b.left) || isBitwiseInit(b.right);
  }
  if (e.type === "UnaryExpression") {
    const u = e as unknown as { operator: string; argument: Expression };
    return u.operator === "~" || isBitwiseInit(u.argument);
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

/**
 * Series 097 destructuring helpers. A newly-graduated destructure shape (array
 * over a Vec variable, array/object rest) reads its source once per binding slot,
 * so the source must be a plain identifier (side-effect-free, cheap to re-read). A
 * non-identifier source (a call, a complex expression) is fail-loud — bind it to a
 * variable first.
 */
function requireIdentifierSource(init: Expression, what: string): void {
  if (init.type !== "Identifier") {
    throw new UnsupportedError({
      type: `${what} over a non-identifier source (bind the source to a variable first)`,
    });
  }
}

/** `<src>.get(i).cloned()` — an `Option<T>` element read (`None` on out-of-bounds). */
function vecElemOption(src: HirExpr, index: number): HirExpr {
  return {
    kind: "method",
    name: "cloned",
    args: [],
    receiver: {
      kind: "method",
      name: "get",
      args: [{ kind: "raw", text: String(index) }],
      receiver: src,
    },
  };
}

/**
 * `<src>.get(from..).map(|__s| __s.to_vec()).unwrap_or_default()` — the array-rest
 * `Vec<T>`. `get(from..)` is `None` when the source is shorter than the leading
 * count, so `unwrap_or_default()` yields an empty vec (JS's `[]`). The closure
 * lets Rust infer the element type (no rendered `T`).
 */
function vecRest(src: HirExpr, from: number): HirExpr {
  return {
    kind: "method",
    name: "unwrap_or_default",
    args: [],
    receiver: {
      kind: "method",
      name: "map",
      args: [{ kind: "raw", text: "|__s| __s.to_vec()" }],
      receiver: {
        kind: "method",
        name: "get",
        args: [{ kind: "raw", text: `${from}..` }],
        receiver: src,
      },
    },
  };
}

/**
 * Synthesize (idempotently) an anonymous struct for an object-rest's remaining
 * fields (series 097), modeled on the 093 anon-union precedent: an FNV-1a hash
 * over the sorted `name:type` signature so two structurally-identical rests dedupe
 * to one `__anonymous_struct_<hash>` definition. Fields keep source order. Registers
 * the struct in `restStructs` (drained into items), `structs`, and `structFields`.
 */
function synthRestStruct(
  restFields: { name: string; ty: RustType }[],
  analysis: ModuleAnalysis,
): string {
  const sig = restFields
    .map((f) => `${f.name}:${JSON.stringify(f.ty)}`)
    .sort()
    .join("|");
  const name = `__anonymous_struct_${fnv1a(sig)}`;
  if (!analysis.restStructs.has(name)) {
    const fields = restFields.map((f) => ({ name: f.name, ty: f.ty }));
    analysis.restStructs.set(name, { kind: "struct", name, fields });
    analysis.structs.add(name);
    analysis.structFields.set(name, fields);
  }
  return name;
}

export function lowerVarDecl(
  decl: VariableDeclaration,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt[] {
  const mutable = analysis.mut.get(scope);
  return decl.declarations.map((d) => {
    if (!d.init) throw new UnsupportedError({ type: "uninitialized binding" });
    // Array-pattern destructuring over a **fixed-arity tuple source** (series
    // 051a `join!`, and series 067's exact-arity graduation): binds `let (a, b) =
    // …`. Two tuple sources are accepted — a `join!`/`try_join!` tuple from
    // `Promise.all`, and a fixed-arity array *literal* `[e0, e1]` (its element
    // count is statically known, so it lowers to a Rust tuple `(e0, e1)`). A
    // `Vec`/`Array`-typed source is fail-loud (out-of-bounds is `undefined` in JS
    // but a panic in Rust — deferred to #42 / the `undefined` model).
    if ((d.id as { type: string }).type === "ArrayPattern") {
      const pat = d.id as unknown as {
        elements?:
          | ({ type: string; name?: string; argument?: { type: string; name?: string } } | null)[]
          | undefined;
      };
      const elements = pat.elements ?? [];
      // Parse leading identifier names + an optional trailing rest (series 097).
      const leadingNames: string[] = [];
      let restName: string | null = null;
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        if (!el) {
          throw new UnsupportedError({
            type: "array-destructuring hole (`[a, , b]`)",
          });
        }
        if (el.type === "RestElement") {
          if (i !== elements.length - 1) {
            throw new UnsupportedError({
              type: "array-destructuring rest element must be last",
            });
          }
          const arg = el.argument;
          if (!arg || arg.type !== "Identifier" || !arg.name) {
            throw new UnsupportedError({
              type: "array-destructuring rest must bind a plain identifier",
            });
          }
          restName = arg.name;
          break;
        }
        if (el.type === "AssignmentPattern") {
          throw new UnsupportedError({
            type: "array-destructuring default value (`[a = 0]`)",
          });
        }
        if (el.type !== "Identifier" || !el.name) {
          throw new UnsupportedError({
            type: "array-destructuring must bind plain identifiers",
          });
        }
        leadingNames.push(el.name);
      }
      const names = leadingNames;
      // The three fixed-arity sources (generator prefix-pull, `join!` tuple, array
      // literal) have a statically-known length, so no element can be missing —
      // they bind plain (non-Option) values and reject a rest (series 067/051a/075).
      if (restName === null) {
        // A generator source `const [a, b] = g()` (series 075, rides 067): a
        // fixed-arity prefix pull off the generator's `impl Iterator`.
        if (isGeneratorCall(d.init, analysis)) {
          return {
            kind: "let",
            name: names[0] as string,
            mut: false,
            ty: null,
            init: {
              kind: "genPrefixPull",
              source: lowerExpr(d.init, analysis),
              arity: names.length,
            },
            names,
          };
        }
        const init = lowerExpr(d.init, analysis);
        if (isJoinTuple(init)) {
          return {
            kind: "let",
            name: names[0] as string,
            mut: false,
            ty: null,
            init,
            names,
          };
        }
        // A fixed-arity array literal `[e0, e1]` typed as a tuple: bind
        // `let (a, b) = (e0, e1);`, one element per pattern name (exact-arity).
        if (d.init.type === "ArrayExpression") {
          const lit = d.init as ArrayExpression;
          const litElems = lit.elements;
          if (litElems.some((e) => !e || e.type === "SpreadElement")) {
            throw new UnsupportedError({
              type: "array-destructuring over a spread/hole array literal",
            });
          }
          if (litElems.length !== names.length) {
            throw new UnsupportedError({
              type: "array-destructuring arity mismatch (pattern length ≠ tuple length)",
            });
          }
          return {
            kind: "let",
            name: names[0] as string,
            mut: false,
            ty: null,
            init: {
              kind: "tuple",
              elems: litElems.map((e) => lowerExpr(e as Expression, analysis)),
            },
            names,
          };
        }
      }
      // A **Vec/Array variable** (series 097): runtime length → an out-of-bounds
      // slot is `undefined`. Each leading name binds `Option<T>` via
      // `src.get(i).cloned()` (`None` on OOB → JS `undefined`, the shipped 066
      // model); a trailing rest binds the remaining `Vec<T>`. The source is read
      // once per slot, so it must be a plain identifier.
      requireIdentifierSource(d.init, "array-destructuring");
      const srcTy = receiverTypeOf(d.init, analysis);
      if (!srcTy || srcTy.kind !== "vec") {
        throw new UnsupportedError({
          type: "array-destructuring over a source whose element type is unknown",
        });
      }
      const elem = srcTy.elem;
      const arrSrc = d.init as Expression;
      const slots: HirExpr[] = leadingNames.map((_, i) =>
        vecElemOption(lowerExpr(arrSrc, analysis), i),
      );
      const allNames = [...leadingNames];
      for (const n of leadingNames) {
        analysis.bindingTypes.set(n, { kind: "option", inner: elem });
      }
      if (restName !== null) {
        slots.push(vecRest(lowerExpr(arrSrc, analysis), leadingNames.length));
        allNames.push(restName);
        analysis.bindingTypes.set(restName, { kind: "vec", elem });
      }
      return {
        kind: "let",
        name: allNames[0] as string,
        mut: false,
        ty: null,
        init: { kind: "tuple", elems: slots },
        names: allNames,
      };
    }
    // Object-pattern destructuring over a **named-struct source** (series 067):
    // `const { x, y } = point` → a Rust struct pattern `let Point { x, y } =
    // point;`. Shorthand fields only (mirrors 064/058); a renamed/nested/rest
    // field is fail-loud. The source's struct name is resolved from its known
    // binding type; the ownership pass clones the source if it stays live.
    if ((d.id as { type: string }).type === "ObjectPattern") {
      // `const { value, done } = it.next()` (series 075) — a manual generator step
      // read as JS's `{ value, done }`. Lowers to a `(value, done)` tuple driven off
      // `step()`. Requires the generator's `Y === R` (so `value` is one Rust type);
      // otherwise the un-resolvable-`.value` residual → fail-loud.
      const nextInfo = resolveGeneratorNext(d.init, analysis);
      if (nextInfo) {
        const objPat = d.id as unknown as ObjectPattern;
        const names = objPat.properties.map((prop) => {
          if ((prop as { type?: string }).type !== "Property") {
            throw new UnsupportedError({
              type: "manual generator `.next()` destructure supports only `{ value, done }` shorthand",
            });
          }
          const key = prop.key as unknown as { type: string; name?: string };
          const value = prop.value as unknown as { type: string; name?: string };
          if (
            prop.computed ||
            key.type !== "Identifier" ||
            value.type !== "Identifier" ||
            key.name !== value.name ||
            (key.name !== "value" && key.name !== "done")
          ) {
            throw new UnsupportedError({
              type: "manual generator `.next()` destructure supports only `{ value, done }` shorthand bindings",
            });
          }
          return key.name as string;
        });
        if (
          names.length !== 2 ||
          names[0] !== "value" ||
          names[1] !== "done"
        ) {
          throw new UnsupportedError({
            type: "manual generator `.next()` destructure must bind exactly `{ value, done }` in order",
          });
        }
        const yTy = analysis.generatorItemTypes.get(nextInfo.genName);
        const rTy = analysis.generatorRetTypes.get(nextInfo.genName) ?? UNIT;
        if (!yTy || JSON.stringify(yTy) !== JSON.stringify(rTy)) {
          throw new UnsupportedError({
            type: "manual generator `.next()` `{ value, done }` read where the yield type `Y` and return type `R` differ — `value` has no single Rust type (fail-loud residual, series 075)",
          });
        }
        // A send `.next(v)` (076) is only valid over a bidirectional generator (one
        // that reads a `yield` result). Sending into a pull-only generator is
        // fail-loud (there is no `resume` / `TNext` to receive it).
        const bidi = analysis.bidirectionalGenerators.has(nextInfo.genName);
        if (nextInfo.sent && !bidi) {
          throw new UnsupportedError({
            type: "send value `gen.next(v)` into a non-bidirectional generator (it reads no `yield` result — nothing receives the sent value)",
          });
        }
        return {
          kind: "let",
          name: "value",
          mut: false,
          ty: null,
          init: {
            kind: "genStepTuple",
            recv: lowerExpr(nextInfo.recvExpr, analysis),
            sent: bidi
              ? nextInfo.sent
                ? lowerExpr(nextInfo.sent, analysis)
                : null
              : undefined,
          },
          names: ["value", "done"],
        };
      }
      const objPat = d.id as unknown as ObjectPattern;
      const restProp = objPat.properties.find(
        (p) => (p as { type?: string }).type === "RestElement",
      );
      const hasRest = !!restProp;
      const structName = sourceStructName(d.init, analysis);
      if (!structName) {
        throw new UnsupportedError({
          type: hasRest
            ? "object-rest over a non-named-struct source"
            : "object-destructuring over a non-named-struct source",
        });
      }
      // Parse the kept (non-rest) properties as `{ key, value }` identifier pairs;
      // shorthand → key === value, a renamed field → `{ x: px }` (series 097).
      const kept: { key: string; value: string }[] = [];
      for (const prop of objPat.properties) {
        const pType = (prop as { type?: string }).type;
        if (pType === "RestElement") continue;
        if (pType !== "Property") {
          throw new UnsupportedError({
            type: "object-destructuring unsupported property",
          });
        }
        const p = prop as unknown as {
          computed?: boolean;
          key: { type: string; name?: string };
          value: { type: string; name?: string };
        };
        const key = p.key;
        const value = p.value;
        if (p.computed || key.type !== "Identifier" || !key.name) {
          throw new UnsupportedError({
            type: "object-destructuring computed / non-identifier key",
          });
        }
        if (value.type === "AssignmentPattern") {
          throw new UnsupportedError({
            type: "object-destructuring default value (`{ x = 1 }`)",
          });
        }
        if (value.type === "ObjectPattern" || value.type === "ArrayPattern") {
          throw new UnsupportedError({
            type: "object-destructuring nested pattern (`{ p: { x } }`)",
          });
        }
        if (value.type !== "Identifier" || !value.name) {
          throw new UnsupportedError({
            type: "object-destructuring supports only identifier field bindings",
          });
        }
        kept.push({ key: key.name, value: value.name });
      }
      if (!hasRest) {
        // Shorthand or renamed fields → a Rust struct pattern (renaming is native:
        // `let P { x: px, y } = p;`). All-shorthand stays byte-for-byte with 067.
        const fieldPats = kept.map((f) =>
          f.key === f.value ? f.key : `${f.key}: ${f.value}`,
        );
        return {
          kind: "let",
          name: kept[0]?.value as string,
          mut: false,
          ty: null,
          init: lowerExpr(d.init, analysis),
          pat: `${structName} { ${fieldPats.join(", ")} }`,
        };
      }
      // Object rest `const { x, ...rest } = obj` (series 097): the kept fields bind
      // directly; `rest` binds a synthesized anonymous struct of the remaining
      // source fields. Read once per slot → identifier source only.
      requireIdentifierSource(d.init, "object-rest destructuring");
      const restArg = (restProp as unknown as {
        argument?: { type: string; name?: string };
      }).argument;
      if (!restArg || restArg.type !== "Identifier" || !restArg.name) {
        throw new UnsupportedError({
          type: "object-rest must bind a plain identifier",
        });
      }
      const restName = restArg.name;
      const srcFields = analysis.structFields.get(structName) ?? [];
      const keptKeys = new Set(kept.map((f) => f.key));
      const restFields = srcFields
        .filter((f) => !keptKeys.has(f.name))
        .map((f) => ({ name: f.name, ty: f.ty }));
      const anonName = synthRestStruct(restFields, analysis);
      const objSrc = d.init as Expression;
      const objSlots: HirExpr[] = kept.map((f) => ({
        kind: "field",
        object: lowerExpr(objSrc, analysis),
        name: f.key,
      }));
      objSlots.push({
        kind: "structLit",
        name: anonName,
        fields: restFields.map((f) => ({
          name: f.name,
          value: { kind: "field", object: lowerExpr(objSrc, analysis), name: f.name },
        })),
      });
      for (const f of kept) {
        const ft = srcFields.find((sf) => sf.name === f.key)?.ty;
        if (ft) analysis.bindingTypes.set(f.value, ft);
      }
      analysis.bindingTypes.set(restName, { kind: "struct", name: anonName });
      return {
        kind: "let",
        name: [...kept.map((f) => f.value), restName][0] as string,
        mut: false,
        ty: null,
        init: { kind: "tuple", elems: objSlots },
        names: [...kept.map((f) => f.value), restName],
      };
    }
    // Any other non-identifier binding target is unsupported.
    if ((d.id as { type: string }).type !== "Identifier") {
      throw new UnsupportedError({ type: "destructuring binding" });
    }
    let ty = d.id.typeAnnotation
      ? lowerType(d.id.typeAnnotation.typeAnnotation, analysis.structs)
      : null;
    // f64-bearing struct key (series 074): a `Map<Point,V>`/`Set<Point>` binding
    // annotation keys on the `<Struct>Key` newtype, matching the retargeted
    // `mapNew`/`setNew` init (else the annotation and turbofish disagree).
    if (ty) retargetStructKey(ty, analysis.structKeyStructs);
    // An untyped binding is allowed only for a statically-obvious scalar or
    // homogeneous-scalar-array literal (series 046) — anything else (a user
    // call, arithmetic, `-5`, `null`/`undefined`, an identifier, a member
    // access, an empty / mixed / nested array) leaks an un-checked type to
    // Rust inference, so it fails loud pointing at the fix: annotate it.
    //
    // Exceptions — builtin forms the lowerer already types *by construction*,
    // so no annotation is needed (and none can express the type): a stored
    // `Object.entries(…)` (→ `Vec<(String, V)>`, 043b), a `parseJson<T>(…)`
    // std-shim result (→ `ParseResult<T>`, series 084 — the `<T>` carries the
    // type), and an `<array>.find(…)` (→ `Option<T>`, 042d). `using`/`await using`
    // resources are also skipped — their acquisition is typed by construction.
    // Bare `JSON.parse(...)` in a binding (annotated or not) is fail-loud and
    // redirects to `parseJson<T>` (series 084) — run before the annotation gate
    // so the message is the redirect, not "binding without a type annotation".
    if (d.init) redirectBareJson(d.init);
    if (d.init) redirectBareMathRandom(d.init);
    // A `const re = new RegExp(runtimeVar)` (series 101) fails loud with the
    // inline-a-literal redirect — run before the annotation gate so the message is
    // the RE-PORT redirect, not "binding without a type annotation".
    if (
      d.init &&
      d.init.type === "NewExpression" &&
      (d.init as NewExpression).callee.type === "Identifier" &&
      ((d.init as NewExpression).callee as Identifier).name === "RegExp"
    ) {
      lowerNew(d.init as NewExpression, analysis);
    }
    const declKind = (decl as { kind: string }).kind;
    const gated = declKind === "const" || declKind === "let" || declKind === "var";
    if (
      gated &&
      ty === null &&
      !isObviousLiteralInit(d.init) &&
      !isObjectEntriesCall(d.init) &&
      !isParseJsonShimCall(d.init, analysis) &&
      // A `const r = rng(seed)` handle (089) is typed by construction (the
      // `tslib::rng::Rng` struct); Rust infers it, so no annotation is required.
      !isRngShimCall(d.init, analysis) &&
      // A `const p = r.pick(arr)` / `const b = r.shuffle(arr)` off an rng handle
      // (089) is typed by the method's return (`T` / `Vec<T>`); Rust infers it, so
      // no annotation is required (like a `.map(...)` binding).
      !isRngMethodInit(d.init, analysis) &&
      // A JSON-boundary shim call (`parseJsonValue`/`fromJsonValue`/`toJsonValue`,
      // 090) or any statically-`JsonValue` chain (`r.value.at(i)`) is typed by
      // construction — Rust infers it, so no annotation is required.
      !isJsonBoundaryShimCall(d.init, analysis) &&
      !isJsonValueExpr(d.init, analysis) &&
      !isArrayFindCall(d.init) &&
      !isAllSettledAwait(d.init) &&
      !isSpawnInit(d.init, analysis) &&
      !isBitwiseInit(d.init) &&
      // A `const it = g()` generator instance is typed by construction (the wrapper
      // fn's `impl Iterator` / the struct); no dialect annotation expresses it.
      !isGeneratorCall(d.init, analysis) &&
      // `Array.from(src, fn)` (075) → a `Vec` typed by the lifted callback's return;
      // Rust infers it (like `<array>.map(fn)`), so no annotation is required.
      !isArrayFromMapCall(d.init) &&
      // A string `.at(i)` (098) → `Option<String>`, typed by construction; Rust
      // infers it, so no annotation is required (like an `<array>.find(…)`).
      !isStringAtCall(d.init, analysis) &&
      // An `@ttr/std` I/O intrinsic binding (series 100) — `const s = readFile(p)`,
      // `const w = stdout()`, `const res = await http.get(u)` — is typed by
      // construction (the `tslib` return); Rust infers it, so no annotation.
      !isStdIoInit(d.init, analysis) &&
      // A plugin-bound intrinsic call (epic #95) — `const s = leftPad(…)` — is
      // typed by construction (its `expand()` produces concrete core HIR Rust
      // infers), so no annotation is required, like the `@ttr/std` exemptions.
      !isPluginCallInit(d.init, analysis.plugins) &&
      // A regex value or a regex `match`/`exec`/`split`/`test`/`search`/`replace`
      // result (series 101) is typed by construction (the `tslib::regex` return);
      // Rust infers it, so no annotation is required (like `.find`/`.at`).
      !isRegexInit(d.init, analysis) &&
      // A `Date` (`new Date(...)`, a `clock(...).date()` bridge) or a `clock(...)`
      // handle (series 102) is typed by construction (`tslib::date::Date`/`Clock`);
      // Rust infers it, so no annotation is required. (A no-arg / loose-string
      // `new Date` is still fail-loud — the throw fires when `init` lowers below.)
      !isDateExpr(d.init, analysis) &&
      !isClockExpr(d.init, analysis)
    ) {
      // Series 099 inference tier: before failing loud, ask the lib-backed oracle
      // to infer the initializer's type *through* built-in signatures and
      // re-validate it to a modeled `RustType`. An inferred `any`/`unknown`
      // throws `DialectError` from the oracle; null (out-of-surface, or no oracle)
      // keeps the throw below.
      const inferred =
        d.init && analysis.typeOracle
          ? analysis.typeOracle.inferredRustType(d.init.start, d.init.end)
          : null;
      if (inferred) {
        // Unlike an annotation, inference means the init ALREADY has this type —
        // it is NOT a coercion target (don't `Some`-wrap an option-returning
        // call, don't re-coerce a union). So record it for downstream analysis
        // (indexing / `if let Some` narrowing / method dispatch / `fmt_opt`) and
        // leave `ty` null so `lowerTyped` does the natural, non-coercing lowering
        // and Rust infers the binding — exactly as the by-construction exemptions
        // above already do for `.find` / `.at` / `Object.entries`.
        if (d.id.type === "Identifier") {
          analysis.bindingTypes.set(d.id.name, inferred);
        }
      } else {
        throw new UnsupportedError({
          type: `binding '${d.id.name}' without a type annotation`,
          start: d.id.start,
        });
      }
    }
    // An object/array literal is interpreted from its binding's type: a `hashmap`
    // → `HashMap::from([…])`, a `struct` → `Name { … }`, a `vec<struct>` →
    // `vec![Name { … }, …]`, recursing into nested literals (series 032). A bare
    // object literal (no struct/record type) stays unsupported (via `lowerExpr`).
    const init = lowerTyped(d.init, ty, analysis);
    // Track an `Object.entries(...)` binding so `es[i][0]`/`es[i][1]` can lower to
    // tuple field access (series 043).
    if (isObjectEntriesCall(d.init)) analysis.entriesBindings.add(d.id.name);
    // A `const c = s.at(i)` binding is `Option<String>` (series 098) — record it so
    // a later bare `console.log(c)` renders via `fmt_opt` and `c !== undefined`
    // narrows via `if let Some` (the 066 machinery keys on the binding type).
    if (d.id.type === "Identifier" && isStringAtCall(d.init, analysis)) {
      analysis.bindingTypes.set((d.id as Identifier).name, {
        kind: "option",
        inner: { kind: "String" },
      });
    }
    // Track a `JoinHandle` binding (series 051c increment 1): a binding whose
    // lowered init is a `{kind:"spawn"}` node (an un-awaited async call) is a
    // `JoinHandle<T>`. A later `await h` on it lowers to `joinHandleAwait`
    // (`h.await.unwrap()`). Statements lower top-to-bottom, so this is recorded
    // before the `await`.
    if (init.kind === "spawn") analysis.joinHandleBindings.add(d.id.name);
    // Track a `parseJson<T>` result binding (series 084): the value is a
    // `ParseResult<T>`, so a later `.ok`/`.value`/`.error` read routes to the
    // `ParseResult` surface. Recorded before those reads (statements lower
    // top-to-bottom). `d.id.name` is a plain identifier binding.
    if (
      (init.kind === "parseJson" || init.kind === "fromJsonValue") &&
      d.id.type === "Identifier"
    ) {
      analysis.parseResultBindings.set(
        (d.id as Identifier).name,
        init.target,
      );
    }
    // Track a `JsonValue` binding (series 090): a `toJsonValue<T>(x)` result, or
    // any statically-JsonValue init (`const v = r.value`, `const e = v.at(i)`), so
    // a later `.get`/`.asX`/`.length` routes to the accessor surface. Recorded
    // before those reads (statements lower top-to-bottom); `r`/`v` are already in
    // their binding sets from earlier statements, so `isJsonValueExpr` resolves.
    if (
      d.id.type === "Identifier" &&
      (init.kind === "toJsonValue" ||
        (d.init != null && isJsonValueExpr(d.init, analysis)))
    ) {
      analysis.jsonValueBindings.add((d.id as Identifier).name);
    }
    // Track an `rng(seed)` handle binding (series 089): a `const r = rng(seed)`
    // binds a `tslib::rng::Rng`, so a later `r.next()/.int()/.pick()/.shuffle()`
    // routes to the handle surface (checked before the generator `.next()`
    // protocol). Recorded before those reads (statements lower top-to-bottom).
    if (init.kind === "rngNew" && d.id.type === "Identifier") {
      analysis.rngBindings.add((d.id as Identifier).name);
    }
    // Track a `stdout()`/`stderr()` `Writer` handle binding (series 100): a later
    // `.write()/.writeLine()/.flush()` routes to the handle surface. The lowered
    // init is a `tslib::io::stdout`/`stderr` call. Emitted `let mut` below.
    if (
      init.kind === "call" &&
      (init.callee === "tslib::io::stdout" ||
        init.callee === "tslib::io::stderr") &&
      d.id.type === "Identifier"
    ) {
      analysis.writerBindings.add((d.id as Identifier).name);
    }
    // Track an `http.get`/`post` result binding (series 100): the lowered init is
    // `try(await(tslib::http::get|post(...)))`, so a later `.status`/`.ok`/`.body`
    // routes to the `HttpResponse` surface.
    if (
      init.kind === "try" &&
      init.expr.kind === "await" &&
      init.expr.expr.kind === "call" &&
      (init.expr.expr.callee === "tslib::http::get" ||
        init.expr.expr.callee === "tslib::http::post") &&
      d.id.type === "Identifier"
    ) {
      analysis.httpResponseBindings.add((d.id as Identifier).name);
    }
    // Track a regex value binding (series 101): `const re = /pat/g` /
    // `new RegExp("lit","g")` records the `g` flag so a later `s.match(re)` picks
    // `captures` vs `find_all`, and `re.test`/`re.exec` route to the regex surface.
    if (d.id.type === "Identifier") {
      const reInfo = regexLiteralInfo(d.init);
      if (reInfo) {
        analysis.regexBindings.set((d.id as Identifier).name, {
          global: reInfo.flags.includes("g"),
        });
      }
      // A first-match result binding (`const m = s.match(re)` no `g`, or
      // `const m = re.exec(s)`) is an `Option<Match>`: record it so `m![i]` /
      // `m!.groups!.name` route to the `Match` surface, and `m !== null` narrows.
      // A `const all = s.match(/…/g)!` unwraps at the binding (peel the `!`) → the
      // inner `Vec<String>`, so `all.length`/`all.join` route through the vec gate.
      const unwrappedInit = d.init.type === "TSNonNullExpression";
      const reInitInner = unwrappedInit
        ? (d.init as unknown as { expression: Expression }).expression
        : d.init;
      const reTy = regexResultTypeAst(reInitInner, analysis);
      if (reTy) {
        if (unwrappedInit && reTy.kind === "option") {
          analysis.bindingTypes.set((d.id as Identifier).name, reTy.inner);
        } else {
          analysis.bindingTypes.set((d.id as Identifier).name, reTy);
          if (reTy.kind === "option" && reTy.inner === REGEX_MATCH_TYPE) {
            analysis.matchBindings.add((d.id as Identifier).name);
          }
        }
      }
    }
    // Track a `Date` binding (series 102): `const d = new Date(...)` or a
    // `const d = c.date()` clock bridge — a `tslib::date::Date`. A later
    // `.getTime()`/`.getUTCHours()`/`.toISOString()`/… routes to the Date accessor
    // surface. Recorded before those reads (statements lower top-to-bottom).
    if (d.id.type === "Identifier" && isDateExpr(d.init, analysis)) {
      analysis.dateBindings.add((d.id as Identifier).name);
    }
    // Track a `clock(seed)` handle binding (series 102) — the lowered init is a
    // `tslib::date::Clock::new(...)` call, so `.now()/.date()/.tick(ms)` route to
    // the handle surface. Emitted `let mut` below (`tick` takes `&mut self`).
    if (
      init.kind === "call" &&
      init.callee === "tslib::date::Clock::new" &&
      d.id.type === "Identifier"
    ) {
      analysis.clockBindings.add((d.id as Identifier).name);
    }
    // Record the `RustType` of an I/O intrinsic binding (series 100) so a later
    // method call resolves by type — e.g. `.join(",")` on a `Vec<String>` from
    // `readDir`/`args`, or a `?? d` on the `Option<String>` from `env`/`readLine`.
    // `ty` stays null (Rust infers the `let`); this only feeds method dispatch,
    // exactly as the 099 inferred-binding recording does.
    if (d.id.type === "Identifier") {
      const ioTy = ioBindingRustType(init);
      if (ioTy) analysis.bindingTypes.set((d.id as Identifier).name, ioTy);
    }
    // A `const b = r.shuffle(arr)` binding (089) holds a fresh `Vec<T>` — record
    // its `bindingTypes` entry (element type from the source array) so a later
    // `b.join(",")` / `b.map(...)` resolves via the `vec` gate. The `noLib` oracle
    // can't type the method's return, so record it structurally here.
    if (
      init.kind === "method" &&
      init.name === "shuffle" &&
      d.id.type === "Identifier" &&
      d.init?.type === "CallExpression" &&
      (d.init as CallExpression).callee.type === "MemberExpression" &&
      ((d.init as CallExpression).callee as MemberExpression).object.type ===
        "Identifier" &&
      analysis.rngBindings.has(
        (((d.init as CallExpression).callee as MemberExpression)
          .object as Identifier).name,
      )
    ) {
      const arg = (d.init as CallExpression).arguments[0];
      if (arg) {
        analysis.bindingTypes.set((d.id as Identifier).name, {
          kind: "vec",
          elem: elementTypeOf(arg as Expression, analysis),
        });
      }
    }
    // Class inheritance (series 053c): a heterogeneous base-typed array binding
    // is `Vec<Box<dyn IA>>`. Rewrite its declared type and record it as a `dyn`
    // binding so a later `.field` read routes through a trait accessor and a
    // `for-of` element inherits the polymorphic type.
    let letTy = ty;
    if (
      ty?.kind === "vec" &&
      ty.elem.kind === "struct" &&
      (analysis.baseClasses.has(ty.elem.name) ||
        analysis.behavioralInterfaces.has(ty.elem.name)) &&
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
    // Object-literal interface synthesis (series 071 increment 2): a binding typed
    // as a behavioral interface whose init lowered to a synthesized per-literal
    // struct (`Shape__litN { … }`) has no `struct Shape` — retype the binding to
    // the synthesized struct so `let s = Shape__lit1 { … }` type-checks.
    if (
      letTy?.kind === "struct" &&
      analysis.behavioralInterfaces.has(letTy.name) &&
      init.kind === "structLit" &&
      init.name !== letTy.name
    ) {
      letTy = { kind: "struct", name: init.name };
    }
    // A stepped generator instance (`const it = g()`, series 075) is mutated by each
    // `it.step()` (`&mut self`), so it must bind `let mut` even without a TS reassign.
    const steppedInstance =
      isGeneratorCall(d.init, analysis) &&
      analysis.steppedGenerators.has(
        ((d.init as CallExpression).callee as Identifier).name,
      );
    // An rng handle binding (089) is always `let mut` — its methods take
    // `&mut self` (they advance the internal state), so the handle is only useful
    // mutably even without a TS reassignment.
    const rngHandle = init.kind === "rngNew";
    // A `stdout()`/`stderr()` `Writer` handle (series 100) is always `let mut` —
    // its `write`/`writeLine`/`flush` methods take `&mut self`.
    const writerHandle =
      init.kind === "call" &&
      (init.callee === "tslib::io::stdout" ||
        init.callee === "tslib::io::stderr");
    // A `clock(epochMs)` handle (series 102) is always `let mut` — its `tick(ms)`
    // method takes `&mut self` (advances the internal epoch-ms). Mirrors `rng`.
    const clockHandle =
      init.kind === "call" && init.callee === "tslib::date::Clock::new";
    return {
      kind: "let",
      name: d.id.name,
      mut:
        (mutable?.has(d.id.name) ?? false) ||
        steppedInstance ||
        rngHandle ||
        writerHandle ||
        clockHandle,
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
export function lowerTyped(
  expr: Expression,
  ty: RustType | null,
  analysis: ModuleAnalysis,
): HirExpr {
  // The old 045 annotation-driven `const x: T = JSON.parse(s)` is gone (series
  // 084): bare `JSON.parse` is fail-loud and redirects to `parseJson<T>` from
  // `@ttr/std`. We deliberately no longer special-case it here — the binding-init
  // gate (`redirectBareJson`) throws the redirect before this runs.
  // Ternary in a typed context (series 094): lower each arm *against the same
  // target `T`* so both coerce uniformly — `T = number` widens both arms to `f64`;
  // `T = Shape` (a declared union) coerces `c ? circle : square` to its variants;
  // `T = number | undefined` `Some`-wraps a present arm. Reuses every coercion
  // below by recursing through `lowerTyped`.
  if (expr.type === "ConditionalExpression") {
    const c = expr as unknown as {
      test: Expression;
      consequent: Expression;
      alternate: Expression;
    };
    return {
      kind: "cond",
      test: truthyCond(c.test, analysis),
      conseq: lowerTyped(c.consequent, ty, analysis),
      alt: lowerTyped(c.alternate, ty, analysis),
    };
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
  // Union coercion (series 093): a string/number literal in a union-enum slot
  // constructs its variant (`"north"` in a `Dir` field → `Dir::North`); a
  // discriminated object literal `{kind:"circle", r:2}` → `Shape::Circle { r: 2.0 }`.
  if (ty?.kind === "struct" && analysis.unionEnums.has(ty.name)) {
    const info = analysis.unionEnums.get(ty.name)!;
    const variant = coerceLiteralToUnion(expr, ty.name, analysis);
    if (variant) return variant;
    if (
      (info.discField || info.narrow === "in") &&
      expr.type === "ObjectExpression"
    ) {
      const built = coerceObjectToUnion(expr as ObjectExpression, info, analysis);
      if (built) return built;
    }
    // Scalar/named value into a newtype-variant union (D from a variable, F primitive):
    // pick the variant whose newtype inner matches the value's static type and wrap
    // (`const sh: Shape = c` → `Shape::Circle(c)`; `const x: string|number = "hi"` →
    // `…::Str("hi".to_string())`).
    const scalar = coerceScalarToUnion(expr, info, analysis);
    if (scalar) return scalar;
  }
  if (ty?.kind === "struct" && expr.type === "ObjectExpression") {
    // Object-literal interface synthesis (series 071 increment 2): an object
    // literal typed as a *behavioral* interface has no `struct <Name>` to build —
    // synthesize a per-literal nominal struct (data fields + non-capturing method
    // literals as `fn`-pointer fields) + `impl I<Name>`, and construct *that*.
    if (analysis.behavioralInterfaces.has(ty.name)) {
      return synthesizeInterfaceLiteral(
        expr as ObjectExpression,
        ty.name,
        analysis,
      );
    }
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
    // A single-spread array over a generator `[...g()]` into a `Vec` target
    // (series 065) → `g().collect::<Vec<_>>()`; handled by `lowerExpr` (its
    // ArrayExpression case), not the element-mapping path below.
    const arrEls = (expr as ArrayExpression).elements;
    if (
      arrEls.length === 1 &&
      (arrEls[0] as { type?: string })?.type === "SpreadElement" &&
      isGeneratorCall(
        (arrEls[0] as unknown as { argument: Expression }).argument,
        analysis,
      )
    ) {
      return lowerExpr(expr, analysis);
    }
    // Class inheritance (series 053c): a base-typed array holding *different*
    // subtypes is heterogeneous → `Vec<Box<dyn IA>>`; each element is upcast
    // with `Box::new(...)`. Detected when the elem type is an extended base and
    // the literal's `new` elements name a subclass (a class ≠ the base).
    // Behavioral-interface arrays (series 071 increment 2) reuse the same
    // `Box<dyn I<Name>>` path: a `Shape[]` holding instances of implementing
    // classes is stored polymorphically → each element dispatches via the trait
    // vtable. Every element class differs from the interface name, so
    // `isHeterogeneous` is always true for a non-empty array of instances.
    if (
      ty.elem.kind === "struct" &&
      (analysis.baseClasses.has(ty.elem.name) ||
        analysis.behavioralInterfaces.has(ty.elem.name)) &&
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
 * Object-literal interface synthesis (series 071 increment 2). An object literal
 * typed as a **behavioral** interface (`const s: Shape = { area: () => 5 }`) has
 * no named struct to build — synthesize a per-literal nominal struct
 * `struct <Interface>__litN` whose data fields are ordinary and whose method
 * literals are stored as **`fn`-pointer fields** (non-capturing arrows only) plus
 * an `impl I<Interface>` dispatching each trait method through the stored pointer.
 * The synthesized struct is queued on `analysis.litStructs` (appended to module
 * items) and the literal is lowered to its `structLit` construction.
 *
 * @throws {UnsupportedError} on a **capturing** method literal (needs a boxed
 *   `Box<dyn Fn…>` field — a later series), a non-arrow method value, or a
 *   property not present on the interface (the interface drives the field set).
 */
function synthesizeInterfaceLiteral(
  obj: ObjectExpression,
  iface: string,
  analysis: ModuleAnalysis,
): HirExpr {
  const methodSigs = analysis.interfaceMethods.get(iface) ?? [];
  const methodByName = new Map(methodSigs.map((m) => [m.name, m]));
  const dataFields = analysis.structFields.get(iface) ?? [];
  const dataByName = new Map(dataFields.map((f) => [f.name, f.ty]));

  const structName = `${iface}__lit${(analysis.litCounter += 1)}`;
  const fields: { name: string; ty: RustType }[] = [];
  const litFields: { name: string; value: HirExpr }[] = [];
  const litMethods: { sig: HirFn; field: string }[] = [];
  const litGetters: { field: string; ty: RustType }[] = [];

  for (const p of obj.properties) {
    if (p.type !== "Property" || p.computed) {
      throw new UnsupportedError({
        type: "unsupported object-literal member (spread or computed key) in an interface-typed literal",
      });
    }
    const key = p.key;
    const name =
      key.type === "Identifier"
        ? (key as Identifier).name
        : key.type === "Literal" && typeof (key as Literal).value === "string"
          ? ((key as Literal).value as string)
          : null;
    if (name == null) {
      throw new UnsupportedError({
        type: "non-identifier key in an interface-typed object literal",
      });
    }
    const sig = methodByName.get(name);
    if (sig) {
      // A method member — its value must be a **non-capturing** arrow so it can
      // coerce to an `fn`-pointer field. A capturing arrow (closes over a local /
      // `this`) needs a boxed-closure field — fail-loud until a later series.
      const value = p.value;
      if (value.type !== "ArrowFunctionExpression") {
        throw new UnsupportedError({
          type: `method '${name}' in an interface-typed literal must be an arrow (non-method-shorthand)`,
        });
      }
      assertNonCapturingLiteralMethod(
        value as ArrowFunctionExpression,
        analysis,
      );
      const fnTy: RustType = {
        kind: "fnPtr",
        params: sig.params.map((pp) => pp.ty),
        ret: sig.ret,
      };
      fields.push({ name, ty: fnTy });
      litFields.push({
        name,
        value: lowerLiteralMethodClosure(
          value as ArrowFunctionExpression,
          analysis,
        ),
      });
      litMethods.push({ sig, field: name });
    } else if (dataByName.has(name)) {
      // A data field (mixed interface) — an ordinary struct field + by-value getter.
      const ty = dataByName.get(name) as RustType;
      fields.push({ name, ty });
      litFields.push({ name, value: lowerTyped(p.value, ty, analysis) });
      litGetters.push({ field: name, ty });
    } else {
      throw new UnsupportedError({
        type: `object-literal property '${name}' is not declared on interface '${iface}'`,
      });
    }
  }

  analysis.litStructs.push({
    kind: "struct",
    name: structName,
    fields,
    litImpl: {
      trait: traitNameOf(iface),
      methods: litMethods,
      getters: litGetters,
    },
  });

  return { kind: "structLit", name: structName, fields: litFields };
}

/**
 * A method literal in an interface-typed object literal must be **non-capturing**
 * to become an `fn`-pointer field (series 071 increment 2). It captures if its
 * body references `this`, or any free identifier that is not its own param/local,
 * a top-level fn/class/enum, or a known callback global. A capturing literal is
 * fail-loud (a boxed-closure field is a later series).
 *
 * @throws {UnsupportedError} when the arrow captures its environment.
 */
function assertNonCapturingLiteralMethod(
  arrow: ArrowFunctionExpression,
  analysis: ModuleAnalysis,
): void {
  const bound = new Set<string>();
  for (const p of arrow.params) collectBoundNames(p, bound);
  astWalk(arrow.body, (n) => {
    if (n.type === "VariableDeclarator") collectBoundNames(n.id, bound);
    if (
      n.type === "ArrowFunctionExpression" ||
      n.type === "FunctionExpression"
    ) {
      for (const p of (n as { params?: unknown[] }).params ?? []) {
        collectBoundNames(p, bound);
      }
    }
  });
  // A reference to a top-level *name* (class, enum, interface, generator, or
  // free/async fn) is not a capture — it's a path, valid in a non-capturing
  // closure. `analysis.topLevelFns` holds the module's free-fn names.
  const topLevel = (name: string): boolean =>
    analysis.classes.has(name) ||
    analysis.enums.has(name) ||
    analysis.behavioralInterfaces.has(name) ||
    analysis.asyncFns.has(name) ||
    analysis.generators.has(name) ||
    analysis.topLevelFns.has(name);
  let captures = false;
  astWalk(arrow.body, (n) => {
    if (n.type === "ThisExpression") captures = true;
    if (n.type === "Identifier") {
      const name = (n as { name?: string }).name;
      if (
        name != null &&
        !bound.has(name) &&
        !CB_GLOBALS.has(name) &&
        !topLevel(name)
      ) {
        captures = true;
      }
    }
  });
  if (captures) {
    throw new UnsupportedError({
      type: "capturing method literal in an interface-typed object literal (closes over a local or `this` — needs a boxed-closure field, a later series)",
    });
  }
}

/**
 * Lower a non-capturing method literal (`() => 5` or `(x) => { return x + 1 }`)
 * to a `{kind:"closure"}` HirExpr that coerces to the field's `fn`-pointer type
 * (series 071 increment 2). An expression body lowers directly; a block body must
 * be a single `return <expr>;` (an early-return / multi-statement literal method
 * is a later slice). The capture check has already run.
 *
 * @throws {UnsupportedError} on a block body that is not a single `return <expr>`.
 */
function lowerLiteralMethodClosure(
  arrow: ArrowFunctionExpression,
  analysis: ModuleAnalysis,
): HirExpr {
  const params = arrow.params.map((p) => {
    if ((p as { type?: string }).type !== "Identifier") {
      throw new UnsupportedError({
        type: "destructured parameter in an interface-literal method (a later slice)",
      });
    }
    return (p as unknown as Identifier).name;
  });
  const body = arrow.body as unknown as { type: string; body?: Statement[] };
  let value: HirExpr;
  if (body.type === "BlockStatement") {
    const stmts = body.body ?? [];
    if (stmts.length !== 1 || stmts[0]?.type !== "ReturnStatement") {
      throw new UnsupportedError({
        type: "interface-literal method body must be an expression or a single `return` (a later slice)",
      });
    }
    const ret = (stmts[0] as unknown as { argument?: Expression }).argument;
    value = ret
      ? lowerExpr(ret, analysis)
      : ({ kind: "unit" } as unknown as HirExpr);
  } else {
    value = lowerExpr(arrow.body as unknown as Expression, analysis);
  }
  return { kind: "closure", params, body: value };
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
export function fieldRustType(
  annotation: TSType,
  optional: boolean,
  structs: Set<string>,
  typeParams: Set<string> = EMPTY_TYPE_PARAMS,
): RustType {
  const base = lowerType(annotation, structs, typeParams);
  return optional && base.kind !== "option"
    ? { kind: "option", inner: base }
    : base;
}

/**
 * Does a struct field omit its key from JSON when the value is `None` (series
 * 091)? True iff the field's nullishness is **`undefined`-only** — an optional
 * `x?: T` or a `x: T | undefined` with **no** `null` arm. A `null`-bearing field
 * (`T | null`, `T | null | undefined`) keeps the key and serializes `null`
 * ("null wins"); a non-nullish field never omits. The declared annotation is the
 * provenance signal: the runtime `Option<T>` collapses `null` and `undefined`,
 * but the *type* still records which nullish keywords produced it.
 */
export function fieldOmitsUndefined(annotation: TSType, optional: boolean): boolean {
  let hasNull = annotation.type === "TSNullKeyword";
  let hasUndef = optional || annotation.type === "TSUndefinedKeyword";
  if (annotation.type === "TSUnionType") {
    const members = (annotation as unknown as { types: TSType[] }).types;
    hasNull ||= members.some((m) => m.type === "TSNullKeyword");
    hasUndef ||= members.some((m) => m.type === "TSUndefinedKeyword");
  }
  return hasUndef && !hasNull;
}

/**
 * How a class field gets its value at construction (series 070). Every non-error
 * class field resolves to exactly one source: `ctor` (assigned `this.f = …` or a
 * `public/private f` parameter property — the existing 060 path), `initializer`
 * (a `f = <expr>` field default), or `none` (neither — an implicitly-absent field
 * that becomes `Option<T>` / `None`, per the design's Decision via series 066).
 */
type ClassFieldSource = "ctor" | "initializer" | "none";

export interface ClassFieldPlan {
  name: string;
  /** The field's Rust type — Option-wrapped when the source is `none`. */
  ty: RustType;
  source: ClassFieldSource;
  /** The initializer AST node (present iff `source === "initializer"`). */
  init?: Expression;
  /**
   * The field omits its key from JSON when `None` (series 091): an
   * `undefined`-only declared type, or a `source: "none"` field (implicitly
   * `undefined` at construction — unset class fields are `undefined` in JS).
   */
  omitIfNone?: boolean;
}

/**
 * The set of field names a constructor directly initializes (series 070): each
 * `this.<field> = …` assignment plus every `public/private/readonly` parameter
 * property. Drives per-field construction-source resolution — a field the ctor
 * doesn't assign falls back to its initializer, else to `None`.
 */
function ctorAssignedFields(ctor: MethodDefinition | undefined): Set<string> {
  const assigned = new Set<string>();
  if (!ctor) return assigned;
  for (const p of (ctor.value.params ?? []) as unknown as Param[]) {
    if (p.type === "TSParameterProperty") assigned.add(p.parameter.name);
  }
  for (const stmt of ctor.value.body?.body ?? []) {
    if (stmt.type !== "ExpressionStatement") continue;
    const e = (stmt as ExpressionStatement).expression;
    if (e.type !== "AssignmentExpression") continue;
    const a = e as AssignmentExpression;
    if (a.operator !== "=" || a.left.type !== "MemberExpression") continue;
    const m = a.left as MemberExpression;
    if (m.computed || m.object.type !== "ThisExpression") continue;
    if (m.property.type === "Identifier") assigned.add((m.property as Identifier).name);
  }
  return assigned;
}

/**
 * A field initializer must be a self-contained construction constant (series
 * 070): it may not reference `this` or another field — a cross-field / ordered
 * initializer is fail-loud (design §Open sub-details). A bare `Identifier` is
 * rejected too (it could name a field or an out-of-scope binding); only closed
 * literal-shaped expressions are accepted as construction defaults.
 */
export function rejectImpureInitializer(field: string, expr: Expression): void {
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (!node || typeof node !== "object") return;
    const t = (node as { type?: string }).type;
    if (t === "ThisExpression") {
      throw new UnsupportedError({
        type: `field initializer for '${field}' references \`this\` (cross-field init is not a construction constant)`,
      });
    }
    for (const key in node as Record<string, unknown>) {
      if (key === "type") continue;
      walk((node as Record<string, unknown>)[key]);
    }
  };
  walk(expr);
}

/**
 * Resolve every instance field of a non-error class to its construction plan
 * (series 070): declared `field: T` properties and field initializers first (in
 * declaration order), then `public/private` parameter properties. A field the
 * constructor assigns keeps its declared type; an *un-assigned, un-initialized*
 * field with a non-`Option` type is wrapped `Option<T>` (source `none`, filled
 * `None` at construction). Shared by `collectStructFields` (the read-narrowing
 * table) and `lowerClass` (the emitted struct + `new`) so both agree.
 */
export function planClassFields(
  decl: ClassDeclaration,
  structs: Set<string>,
  typeParams: Set<string> = EMPTY_TYPE_PARAMS,
): ClassFieldPlan[] {
  const ctor = decl.body.body.find(
    (m): m is MethodDefinition =>
      m.type === "MethodDefinition" && m.kind === "constructor",
  );
  const assigned = ctorAssignedFields(ctor);
  const plans: ClassFieldPlan[] = [];
  for (const m of decl.body.body) {
    if (m.type !== "PropertyDefinition" || m.static || m.computed) continue;
    const f = m as PropertyDefinition;
    const name = f.key.name;
    const init = (f.value as Expression | undefined) ?? undefined;
    // A declared type (may already be `Option` via `?`/`T | undefined`), or the
    // literal type inferred from the initializer (`x = 5` → `f64`) via the shared
    // numeric literal pass (`inferInitType`) — never a parallel path.
    let declared: RustType | null = f.typeAnnotation
      ? fieldRustType(
          f.typeAnnotation.typeAnnotation,
          f.optional === true,
          structs,
          typeParams,
        )
      : init
        ? inferInitType(init, structs)
        : null;
    if (!declared) {
      throw new UnsupportedError({
        type: `class field '${name}' without a type (nor an inferable initializer)`,
      });
    }
    // JSON omission flavour (series 091) from the declared annotation, if any.
    const omitIfNone = f.typeAnnotation
      ? fieldOmitsUndefined(f.typeAnnotation.typeAnnotation, f.optional === true)
      : false;
    if (assigned.has(name)) {
      plans.push({ name, ty: declared, source: "ctor", omitIfNone });
    } else if (init) {
      plans.push({ name, ty: declared, source: "initializer", init, omitIfNone });
    } else {
      // Neither ctor-assigned nor initialized → implicitly absent: `Option<T>`,
      // `None` at construction (design Decision, via series 066). An unset field is
      // `undefined` in JS, so it omits its JSON key (series 091).
      const ty: RustType =
        declared.kind === "option" ? declared : { kind: "option", inner: declared };
      plans.push({ name, ty, source: "none", omitIfNone: true });
    }
  }
  // `public/private` parameter properties are always ctor-assigned fields.
  for (const p of (ctor?.value.params ?? []) as unknown as Param[]) {
    if (p.type !== "TSParameterProperty" || !p.parameter.typeAnnotation) continue;
    plans.push({
      name: p.parameter.name,
      ty: lowerType(p.parameter.typeAnnotation.typeAnnotation, structs, typeParams),
      source: "ctor",
    });
  }
  return plans;
}

export function collectStructFields(
  program: Program,
  structs: Set<string>,
): Map<string, { name: string; ty: RustType }[]> {
  const map = new Map<string, { name: string; ty: RustType }[]>();
  for (const stmt of program.body) {
    if (stmt.type === "TSInterfaceDeclaration") {
      const decl = stmt as TSInterfaceDeclaration;
      const fields: { name: string; ty: RustType; omitIfNone?: boolean }[] = [];
      // Interface inheritance (series 059): flatten each already-processed base's
      // fields first (declared earlier, so its entry is complete — including its
      // own transitive bases). A later shadowing own field wins.
      for (const h of decl.extends as { expression?: { name?: string } }[]) {
        const baseName = h.expression?.name;
        if (baseName) fields.push(...(map.get(baseName) ?? []));
      }
      for (const m of decl.body.body) {
        if (
          m.type === "TSPropertySignature" &&
          !m.computed &&
          m.typeAnnotation
        ) {
          const annotation = m.typeAnnotation.typeAnnotation;
          const optional = m.optional === true;
          const ty = fieldRustType(annotation, optional, structs);
          const omitIfNone = fieldOmitsUndefined(annotation, optional);
          const existing = fields.findIndex((f) => f.name === m.key.name);
          if (existing >= 0)
            fields[existing] = { name: m.key.name, ty, omitIfNone };
          else fields.push({ name: m.key.name, ty, omitIfNone });
          continue;
        }
      }
      map.set(decl.id.name, fields);
    } else if (stmt.type === "ClassDeclaration" && !isErrorSubclass(stmt)) {
      const decl = stmt as ClassDeclaration;
      if (!decl.id) continue;
      // Series 070: the field-type table (read-narrowing) must match the emitted
      // struct — an un-assigned, un-initialized field is `Option<T>`. `planClassFields`
      // is lenient here (malformed members still fail loud in `lowerClass`).
      // Series 088: resolve the class's own `<T, …>` params so a `param`-typed field
      // (`v: T`) is recorded as `{kind:"param"}` (else `lowerType` fails loud on `T`
      // here and the class is skipped, leaving `this.v` unresolvable). This mirrors
      // the per-class `typeParams` push in `lowerClassBody`.
      const classTP = (decl as { typeParameters?: TSTypeParamDecl }).typeParameters;
      const tp = classTP
        ? new Set(classTP.params.map((p) => p.name.name))
        : EMPTY_TYPE_PARAMS;
      let plans: ClassFieldPlan[];
      try {
        plans = planClassFields(decl, structs, tp);
      } catch {
        continue;
      }
      map.set(
        decl.id.name,
        plans.map((p) => ({
          name: p.name,
          ty: p.ty,
          omitIfNone: p.omitIfNone,
        })),
      );
    }
  }
  return map;
}

/**
 * Collect each declared struct's `readonly` field names (series 059) — from
 * `readonly` interface members and `readonly` class properties. An assignment to
 * one is rejected (`DialectError`) in `lowerExpr`; construction is unaffected.
 */
export function collectReadonlyFields(program: Program): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const stmt of program.body) {
    if (stmt.type === "TSInterfaceDeclaration") {
      const decl = stmt as TSInterfaceDeclaration;
      const ro = new Set<string>();
      for (const m of decl.body.body) {
        if (m.type === "TSPropertySignature" && !m.computed && m.readonly) {
          ro.add(m.key.name);
        }
      }
      if (ro.size > 0) map.set(decl.id.name, ro);
    } else if (stmt.type === "ClassDeclaration") {
      const decl = stmt as ClassDeclaration;
      if (!decl.id) continue;
      const ro = new Set<string>();
      for (const m of decl.body.body) {
        const pd = m as { type: string; readonly?: boolean; computed?: boolean; key?: { name?: string } };
        if (pd.type === "PropertyDefinition" && !pd.computed && pd.readonly && pd.key?.name) {
          ro.add(pd.key.name);
        }
      }
      if (ro.size > 0) map.set(decl.id.name, ro);
    }
  }
  return map;
}

/**
 * Reject an assignment to a `readonly` field (series 059). Fires on a non-computed
 * `s.f = …` (or `this.f = …`) where `f` is `readonly` on `s`'s struct type. The
 * receiver's struct is resolved from `bindingTypes` (a local) or the class under
 * lowering (`this`). Construction (a struct literal) never reaches here.
 */
export function checkReadonlyAssign(target: Expression, analysis: ModuleAnalysis): void {
  if (target.type !== "MemberExpression") return;
  const m = target as MemberExpression;
  if (m.computed || m.property.type !== "Identifier") return;
  const field = (m.property as Identifier).name;
  let structName: string | undefined;
  if (m.object.type === "Identifier") {
    const t = analysis.bindingTypes.get((m.object as Identifier).name);
    if (t?.kind === "struct") structName = t.name;
  }
  if (structName && analysis.readonlyFields.get(structName)?.has(field)) {
    throw new DialectError(
      `assignment to readonly field '${field}' of '${structName}'`,
    );
  }
}

/** A record key: a string literal or a bare identifier, both a `String`. */
export function lowerKey(key: Expression): HirExpr {
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
