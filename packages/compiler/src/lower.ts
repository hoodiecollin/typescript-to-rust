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

import { type ModuleAnalysis, SCRIPT_SCOPE, analyzeModule } from "./analysis";
import type {
  BlockStatement,
  BreakStatement,
  CallExpression,
  ContinueStatement,
  Expression,
  ForOfStatement,
  ForStatement,
  FunctionDeclaration,
  Identifier,
  IfStatement,
  Literal,
  MemberExpression,
  ObjectExpression,
  Program,
  Statement,
  SwitchStatement,
  TSInterfaceDeclaration,
  TSType,
  VariableDeclaration,
  WhileStatement,
} from "./ast";
import type {
  Borrow,
  HirArg,
  HirExpr,
  HirFn,
  HirItem,
  HirMatchArm,
  HirModule,
  HirParam,
  HirStmt,
  HirStruct,
  RustType,
} from "./hir";
import { refineNumerics } from "./numeric";
import { refineStrings } from "./strings";
import { DialectError, validate } from "./validate";

export { DialectError };

export class UnsupportedError extends Error {
  constructor(
    public readonly node: { type: string; start?: number; end?: number },
  ) {
    super(`Unsupported ${node.type} (the dialect does not implement this yet)`);
    this.name = "UnsupportedError";
  }
}

const UNIT: RustType = { kind: "unit" };

/**
 * Lower a whole program to HIR.
 * @throws {UnsupportedError} on any construct outside the implemented dialect.
 */
export function lower(program: Program): HirModule {
  // Step 2: reject input forbidden by the dialect (`any`/`unknown`, …) — fail
  // loud with `DialectError`, distinct from the "not yet implemented" gate below.
  validate(program);
  const analysis = analyzeModule(program);
  const items: HirItem[] = [];
  const script: Statement[] = [];

  for (const stmt of program.body) {
    if (stmt.type === "FunctionDeclaration") {
      items.push(lowerFunction(stmt as FunctionDeclaration, analysis));
    } else if (stmt.type === "TSInterfaceDeclaration") {
      items.push(lowerInterface(stmt as TSInterfaceDeclaration, analysis.structs));
    } else if (stmt.type === "ClassDeclaration") {
      // SEAM (series 012): the HIR/emitter shape exists; real lowering pending.
      throw new UnsupportedError({
        type: "class → struct/impl lowering pending",
      });
    } else {
      script.push(stmt);
    }
  }

  let main: HirStmt[] = [];
  if (script.length > 0) {
    if (items.some((f) => f.kind === "fn" && f.name === "main")) {
      // No sound single lowering mixes script with a user-defined `main`.
      throw new UnsupportedError({
        type: "top-level statements alongside a user-defined main()",
      });
    }
    main = lowerStatements(script, analysis, SCRIPT_SCOPE);
  }

  // Final gate steps: refine `number` → `usize` where indexing demands it, then
  // read-only `string` params (`&String`) → the idiomatic `&str`.
  return refineStrings(refineNumerics({ items, main }));
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
  const ret = func.returnType
    ? lowerType(func.returnType.typeAnnotation, analysis.structs)
    : UNIT;

  if (!func.body)
    throw new UnsupportedError({ type: "function without a body" });
  // The function name is its own scope key for mutability lookups.
  const body = lowerStatements(func.body.body, analysis, name);

  return { kind: "fn", name, isAsync: func.async, params, ret, body };
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
    if (m.optional) {
      throw new UnsupportedError({ type: "optional interface field (x?: T)" });
    }
    if (!m.typeAnnotation) {
      throw new UnsupportedError({
        type: `interface field '${m.key.name}' without a type`,
      });
    }
    return { name: m.key.name, ty: lowerType(m.typeAnnotation.typeAnnotation, structs) };
  });
  return { kind: "struct", name: decl.id.name, fields };
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
  const base = lowerType(p.typeAnnotation.typeAnnotation, structs);
  const ownership = info?.ownership ?? "move";
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
    case "ExpressionStatement":
      return [
        {
          kind: "expr",
          expr: lowerExpr(
            (stmt as { expression: Expression }).expression,
            analysis,
          ),
        },
      ];
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
    default:
      throw new UnsupportedError(stmt);
  }
}

function lowerIf(
  stmt: IfStatement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt {
  return {
    kind: "if",
    cond: lowerExpr(stmt.test, analysis),
    conseq: lowerBlock(stmt.consequent, analysis, scope),
    alt: lowerAlternate(stmt.alternate, analysis, scope),
  };
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
 * A `continue` in the body would jump to the `while` condition and **skip** the
 * appended `update` — a semantic change — so an *own* `continue` (not inside a
 * nested loop) is rejected. `break` is sound (it exits the `while`, exactly as
 * the `for` would). The labeled-block fix is a deferred series (see design 009).
 */
function lowerFor(
  stmt: ForStatement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt {
  if (hasOwnContinue(stmt.body)) {
    throw new UnsupportedError({
      type: "continue inside a C-style for (unsound while-desugar — deferred)",
    });
  }

  const init: HirStmt[] = stmt.init
    ? stmt.init.type === "VariableDeclaration"
      ? lowerVarDecl(stmt.init as VariableDeclaration, analysis, scope)
      : [{ kind: "expr", expr: lowerExpr(stmt.init as Expression, analysis) }]
    : [];

  const body = lowerBlock(stmt.body, analysis, scope);
  if (stmt.update) {
    body.push({ kind: "expr", expr: lowerExpr(stmt.update, analysis) });
  }

  const cond: HirExpr = stmt.test
    ? lowerExpr(stmt.test, analysis)
    : { kind: "bool", value: true };

  return { kind: "block", body: [...init, { kind: "while", cond, body }] };
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
  const iter: HirExpr = {
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

function lowerVarDecl(
  decl: VariableDeclaration,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt[] {
  const mutable = analysis.mut.get(scope);
  return decl.declarations.map((d) => {
    if (!d.init) throw new UnsupportedError({ type: "uninitialized binding" });
    const ty = d.id.typeAnnotation
      ? lowerType(d.id.typeAnnotation.typeAnnotation, analysis.structs)
      : null;
    // An object literal is interpreted from its binding's type: a `hashmap`
    // annotation makes it a `HashMap::from([…])` construction, a `struct` a
    // `Name { … }` literal. A bare object literal (neither) stays unsupported.
    let init: HirExpr;
    if (ty?.kind === "hashmap" && d.init.type === "ObjectExpression") {
      init = lowerHashMapLiteral(d.init as ObjectExpression, analysis);
    } else if (ty?.kind === "struct" && d.init.type === "ObjectExpression") {
      init = lowerStructLiteral(d.init as ObjectExpression, ty.name, analysis);
    } else {
      init = lowerExpr(d.init, analysis);
    }
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
    return { name: key.value, value: lowerExpr(p.value, analysis) };
  });
  return { kind: "structLit", name, fields };
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
    case "Literal":
      return lowerLiteral(expr as Literal);
    case "Identifier":
      return { kind: "ident", name: (expr as Identifier).name };
    case "BinaryExpression": {
      const b = expr as {
        operator: string;
        left: Expression;
        right: Expression;
      };
      return {
        kind: "binary",
        op: b.operator,
        left: lowerExpr(b.left, analysis),
        right: lowerExpr(b.right, analysis),
      };
    }
    case "AssignmentExpression": {
      const a = expr as {
        operator: string;
        left: Expression;
        right: Expression;
      };
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

function lowerLiteral(lit: Literal): HirExpr {
  const v = lit.value;
  if (typeof v === "number") return { kind: "number", value: v };
  if (typeof v === "string") return { kind: "string", value: v };
  if (typeof v === "boolean") return { kind: "bool", value: v };
  if (v === null) throw new UnsupportedError({ type: "null literal" });
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

function lowerCall(call: CallExpression, analysis: ModuleAnalysis): HirExpr {
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
    const args: HirArg[] = call.arguments.map((a, i) => {
      const param = sig?.params[i];
      let borrow: Borrow = "owned";
      if (param && !param.isCopy) {
        if (param.ownership === "ref") borrow = "ref";
        else if (param.ownership === "refMut") borrow = "refMut";
      }
      return { borrow, expr: lowerExpr(a, analysis) };
    });
    return { kind: "call", callee: name, args };
  }

  // Method call: `obj.method(args)`.
  if (call.callee.type === "MemberExpression") {
    const m = call.callee as MemberExpression;
    if (m.property.type !== "Identifier") throw new UnsupportedError(call);
    return {
      kind: "method",
      receiver: lowerExpr(m.object, analysis),
      name: (m.property as Identifier).name,
      args: call.arguments.map((a) => lowerExpr(a, analysis)),
    };
  }

  throw new UnsupportedError(call);
}

function lowerMember(
  member: MemberExpression,
  analysis: ModuleAnalysis,
): HirExpr {
  if (member.computed) {
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
    default:
      throw new UnsupportedError(ty);
  }
}
