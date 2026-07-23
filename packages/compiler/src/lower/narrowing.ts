/**
 * Narrowing recognition: the discriminated-union / `typeof` / `in` pattern
 * recognizers that turn a `switch` or an `if`/`else if` ladder into a Rust
 * `match` over a union `enum` (series 093 1b/2b, 094). `lowerSwitch` and `lowerIf`
 * (in `./statements`) delegate here: `lowerDiscriminatedSwitch` /
 * `recognizeTypeofSwitch` for `switch`, and `recognizeUnionIfLadder` /
 * `recognizeTypeofIfLadder` / `recognizeInIfLadder` for `if`-ladders. Each returns
 * a lowered `match` (or `null` when the shape isn't a recognized narrowing, so the
 * caller falls back to its default lowering).
 *
 * Split out of `statements.ts` (series 109 Phase-2 / #94): a self-contained,
 * internally-scoped cluster (no sibling but `./statements` reaches it) that was the
 * clearest sub-seam in the 3.7k-LOC statement hub. Byte-identical — pure motion.
 * The general statement lowerers it leans on (`lowerStatements` /
 * `lowerSwitchCaseBody`) come back from `./statements`; the scrutinee/field-read
 * recognizers from `./types` and `rewriteFieldReads` from `./try-carrier`.
 */

import type { ModuleAnalysis } from "../analysis";
import type {
  BlockStatement,
  Expression,
  Identifier,
  IfStatement,
  Literal,
  Statement,
  SwitchStatement,
} from "../ast";
import { UnsupportedError } from "../errors";
import type {
  HirExpr,
  HirMatchArm,
  HirStmt,
  HirUnionEnum,
  RustType,
} from "../hir";
import { lowerStatements, lowerSwitchCaseBody } from "./statements";
import { rewriteFieldReads } from "./try-carrier";
import {
  discriminatedScrutinee,
  readsAnyMemberField,
  readsMemberField,
} from "./types";

/**
 * Lower a discriminated-union `switch (obj.kind)` (series 093, 1b) to a variant
 * `match obj { Shape::Circle { r, .. } => …, … }`. Each `case "circle":` maps to a
 * variant; the arm binds the fields the body *reads* (`..` for the rest) and
 * `obj.field` reads are rewritten to the bound `field` before lowering. A `_ => {}`
 * default is appended only when the arms aren't exhaustive (JS-swallow parity).
 */
export function lowerDiscriminatedSwitch(
  stmt: SwitchStatement,
  sc: { objName: string; info: HirUnionEnum },
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt {
  const { objName, info } = sc;
  const disc: HirExpr = { kind: "ident", name: objName };
  const arms: HirMatchArm[] = [];
  let defaultArm: HirMatchArm | null = null;
  const covered = new Set<string>();
  let pending: Expression[] = [];

  const variantOf = (test: Expression): HirUnionEnum["variants"][number] => {
    const v =
      test.type === "Literal"
        ? info.variants.find(
            (vt) => vt.discValue === String((test as Literal).value),
          )
        : undefined;
    if (!v) {
      throw new UnsupportedError({
        type: `switch case is not a variant of union '${info.name}'`,
      });
    }
    return v;
  };

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
      pending.push(c.test);
      return;
    }
    const tests = [...pending, c.test];
    pending = [];
    const variants = tests.map(variantOf);
    variants.forEach((v) => covered.add(v.name));
    if (variants.length === 1) {
      arms.push(
        buildDiscArm(objName, info, variants[0]!, c.consequent, (b) =>
          lowerSwitchCaseBody(b, isLast, analysis, scope),
        ),
      );
    } else {
      // Stacked variants share a body → no field binds (fields differ per variant).
      // A newtype variant ignores its payload (`Shape::Circle(_)`).
      arms.push({
        guard: null,
        pats: variants.map((v) => ({
          kind: "varPat",
          enumName: info.name,
          variant: v.name,
          binds: [],
          struct: v.fields.length > 0,
          ...(v.newtype ? { newtypeBind: "_" } : {}),
        })),
        body: lowerSwitchCaseBody(c.consequent, isLast, analysis, scope),
      });
    }
  });
  if (pending.length > 0) {
    throw new UnsupportedError({
      type: "trailing empty switch case with no shared body",
    });
  }
  if (defaultArm) arms.push(defaultArm);
  else if (covered.size < info.variants.length)
    arms.push({ guard: null, body: [] });
  return { kind: "match", disc, arms };
}

/**
 * Build one `match` arm for a single discriminated-union variant (shared by the
 * `switch` and `if`-ladder lowerings, series 093, 1b). Binds the fields the raw
 * body *reads*, rewrites `obj.field` → `field`, and prepends a `let f = f.clone();`
 * prelude so a ref-bound field is used owned. `lowerBody` lowers the rewritten body.
 */
function buildDiscArm(
  objName: string,
  info: HirUnionEnum,
  v: HirUnionEnum["variants"][number],
  rawBody: Statement[],
  lowerBody: (body: Statement[]) => HirStmt[],
): HirMatchArm {
  // A newtype variant (D): bind the inner struct under the object's own name (so its
  // `sh.field` reads resolve unchanged), cloning it to an owned value when the body
  // reads any field. No field rewrite — the discriminant stays inside the struct.
  if (v.newtype) {
    const readsAny = readsAnyMemberField(rawBody, objName);
    const clonePrelude: HirStmt[] = readsAny
      ? [
          {
            kind: "let",
            name: objName,
            mut: false,
            ty: null,
            init: {
              kind: "method",
              receiver: { kind: "ident", name: objName },
              name: "clone",
              args: [],
            },
          },
        ]
      : [];
    return {
      guard: null,
      pat: {
        kind: "varPat",
        enumName: info.name,
        variant: v.name,
        binds: [],
        struct: false,
        newtypeBind: readsAny ? objName : "_",
      },
      body: [...clonePrelude, ...lowerBody(rawBody)],
    };
  }
  const read = v.fields
    .map((f) => f.name)
    .filter((f) => readsMemberField(rawBody, objName, f));
  const conseq = rewriteFieldReads(rawBody, objName, read);
  const clonePrelude: HirStmt[] = read.map((f) => ({
    kind: "let",
    name: f,
    mut: false,
    ty: null,
    init: {
      kind: "method",
      receiver: { kind: "ident", name: f },
      name: "clone",
      args: [],
    },
  }));
  return {
    guard: null,
    pat: {
      kind: "varPat",
      enumName: info.name,
      variant: v.name,
      binds: read,
      struct: v.fields.length > 0,
    },
    body: [...clonePrelude, ...lowerBody(conseq)],
  };
}

/**
 * Recognize a discriminated-union `if`-ladder (series 093, 1b): an
 * `if (obj.kind === "circle") … else if (obj.kind === "square") … [else …]` chain
 * over one discriminated-union binding, lowered to a variant `match obj`. Returns
 * null when the chain is not that shape (falls back to the ordinary `if`).
 */
export function recognizeUnionIfLadder(
  stmt: IfStatement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt | null {
  // The first test fixes the object binding + discriminant field.
  const first = discEqTest(stmt.test, analysis);
  if (!first) return null;
  const { objName, info } = first;
  const arms: HirMatchArm[] = [];
  const covered = new Set<string>();
  let node: Statement | null = stmt;
  let defaultBody: HirStmt[] | null = null;
  while (node && node.type === "IfStatement") {
    const iff = node as IfStatement;
    const t = discEqTest(iff.test, analysis);
    // Every rung must test the *same* object + discriminant.
    if (!t || t.objName !== objName || t.info.name !== info.name) return null;
    const variant = info.variants.find((vt) => vt.discValue === t.value);
    if (!variant) return null;
    covered.add(variant.name);
    const rawBody =
      iff.consequent.type === "BlockStatement"
        ? (iff.consequent as BlockStatement).body
        : [iff.consequent];
    arms.push(
      buildDiscArm(objName, info, variant, rawBody, (b) =>
        lowerStatements(b, analysis, scope),
      ),
    );
    node = iff.alternate;
  }
  // A trailing `else`: when exactly one variant is still uncovered, the `else` *is*
  // that variant (TS narrows it) — build a proper field-binding arm for it, so its
  // `obj.field` reads resolve. Otherwise it's a genuine catch-all (`_ => …`).
  if (node) {
    const rawBody =
      node.type === "BlockStatement" ? (node as BlockStatement).body : [node];
    const uncovered = info.variants.filter((v) => !covered.has(v.name));
    if (uncovered.length === 1) {
      const v = uncovered[0]!;
      covered.add(v.name);
      arms.push(
        buildDiscArm(objName, info, v, rawBody, (b) =>
          lowerStatements(b, analysis, scope),
        ),
      );
    } else {
      defaultBody = lowerStatements(rawBody, analysis, scope);
    }
  }
  if (defaultBody) arms.push({ guard: null, body: defaultBody });
  else if (covered.size < info.variants.length)
    arms.push({ guard: null, body: [] });
  return { kind: "match", disc: { kind: "ident", name: objName }, arms };
}

/**
 * An `obj.kind === "circle"` test over a discriminated-union binding → the object
 * name, its enum, and the discriminant value; else null.
 */
function discEqTest(
  test: Expression,
  analysis: ModuleAnalysis,
): { objName: string; info: HirUnionEnum; value: string } | null {
  if (test.type !== "BinaryExpression") return null;
  const b = test as { operator: string; left: Expression; right: Expression };
  if (b.operator !== "===" && b.operator !== "==") return null;
  const [member, lit] =
    b.left.type === "MemberExpression" ? [b.left, b.right] : [b.right, b.left];
  if (lit.type !== "Literal") return null;
  const sc = discriminatedScrutinee(member, analysis);
  if (!sc) return null;
  const v = (lit as Literal).value;
  if (typeof v !== "string" && typeof v !== "number") return null;
  return { objName: sc.objName, info: sc.info, value: String(v) };
}

/** The `typeof`-narrow string for a newtype inner type (F): String→`"string"`,
 *  f64→`"number"`, bool→`"boolean"`, struct→`"object"`; null otherwise. */
function typeofOfInner(ty: RustType): string | null {
  switch (ty.kind) {
    case "String":
      return "string";
    case "f64":
      return "number";
    case "bool":
      return "boolean";
    case "struct":
      return "object";
    default:
      return null;
  }
}

/** The primitive/mixed union (`narrow:"typeof"`) an identifier binding refers to, else null. */
function primitiveUnionBinding(
  name: string,
  analysis: ModuleAnalysis,
): HirUnionEnum | null {
  const t = analysis.bindingTypes.get(name);
  if (t?.kind !== "struct") return null;
  const info = analysis.unionEnums.get(t.name);
  return info && info.narrow === "typeof" ? info : null;
}

/** `typeof x` over a primitive-union binding → {objName, info}; else null. */
function typeofScrutinee(
  e: Expression,
  analysis: ModuleAnalysis,
): { objName: string; info: HirUnionEnum } | null {
  const u = e as { type?: string; operator?: string; argument?: Expression };
  if (u.type !== "UnaryExpression" || u.operator !== "typeof" || !u.argument) {
    return null;
  }
  if (u.argument.type !== "Identifier") return null;
  const objName = (u.argument as Identifier).name;
  const info = primitiveUnionBinding(objName, analysis);
  return info ? { objName, info } : null;
}

/** `typeof x === "string"` over a primitive-union binding → {objName, info, typeStr}; else null. */
function typeofEqTest(
  test: Expression,
  analysis: ModuleAnalysis,
): { objName: string; info: HirUnionEnum; typeStr: string } | null {
  if (test.type !== "BinaryExpression") return null;
  const b = test as { operator: string; left: Expression; right: Expression };
  if (b.operator !== "===" && b.operator !== "==") return null;
  const [uside, lit] =
    b.left.type === "UnaryExpression" ? [b.left, b.right] : [b.right, b.left];
  const sc = typeofScrutinee(uside, analysis);
  if (!sc) return null;
  if (lit.type !== "Literal" || typeof (lit as Literal).value !== "string") {
    return null;
  }
  return { objName: sc.objName, info: sc.info, typeStr: (lit as Literal).value as string };
}

/** The variant of a primitive union matched by a `typeof` string (`"string"`→`Str`). */
function variantForTypeof(
  info: HirUnionEnum,
  typeStr: string,
): HirUnionEnum["variants"][number] | null {
  return (
    info.variants.find((v) => v.newtype && typeofOfInner(v.newtype) === typeStr) ??
    null
  );
}

/** Does the AST subtree reference `<name>` as a value (not a `.field`/key position)? */
function referencesIdent(node: unknown, name: string): boolean {
  if (Array.isArray(node)) return node.some((n) => referencesIdent(n, name));
  if (!node || typeof node !== "object") return false;
  const n = node as Record<string, unknown> & {
    type?: string;
    computed?: boolean;
  };
  if (n.type === "Identifier" && (n as { name?: string }).name === name) {
    return true;
  }
  for (const k in n) {
    if (k === "type") continue;
    // The `.property` of a non-computed member access is a field name, not a ref;
    // likewise a non-computed object-property key. Skip them.
    if (k === "property" && n.type === "MemberExpression" && !n.computed) continue;
    if (k === "key" && n.type === "Property" && !n.computed) continue;
    if (referencesIdent(n[k], name)) return true;
  }
  return false;
}

/**
 * Build one `match` arm for a `typeof`-narrowed primitive-union variant (F, series
 * 093, 1d): bind the inner value under the object's own name (`SN::Str(x)`), clone it
 * to owned when the body uses it, and retype the binding to the narrowed inner during
 * body lowering so `x.length` / `x + 1` / string methods resolve. Restores after.
 */
function buildScalarArm(
  objName: string,
  info: HirUnionEnum,
  v: HirUnionEnum["variants"][number],
  rawBody: Statement[],
  lowerBody: (body: Statement[]) => HirStmt[],
  analysis: ModuleAnalysis,
): HirMatchArm {
  const used = referencesIdent(rawBody, objName);
  const clonePrelude: HirStmt[] = used
    ? [
        {
          kind: "let",
          name: objName,
          mut: false,
          ty: null,
          init: {
            kind: "method",
            receiver: { kind: "ident", name: objName },
            name: "clone",
            args: [],
          },
        },
      ]
    : [];
  const prev = analysis.bindingTypes.get(objName);
  if (v.newtype) analysis.bindingTypes.set(objName, v.newtype);
  let body: HirStmt[];
  try {
    body = [...clonePrelude, ...lowerBody(rawBody)];
  } finally {
    if (prev) analysis.bindingTypes.set(objName, prev);
    else analysis.bindingTypes.delete(objName);
  }
  return {
    guard: null,
    pat: {
      kind: "varPat",
      enumName: info.name,
      variant: v.name,
      binds: [],
      struct: false,
      newtypeBind: used ? objName : "_",
    },
    body,
  };
}

/**
 * Recognize a `switch (typeof x)` over a primitive/mixed union (F) → a variant
 * `match x`. Each `case "string"` / `case "number"` maps to the union's `Str`/`Num`
 * variant; the narrowed value is bound + retyped in the arm. Null when not that shape.
 */
export function recognizeTypeofSwitch(
  stmt: SwitchStatement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt | null {
  const sc = typeofScrutinee(stmt.discriminant, analysis);
  if (!sc) return null;
  const { objName, info } = sc;
  const arms: HirMatchArm[] = [];
  let defaultArm: HirMatchArm | null = null;
  const covered = new Set<string>();
  let pending: string[] = [];
  const variantOf = (typeStr: string): HirUnionEnum["variants"][number] => {
    const v = variantForTypeof(info, typeStr);
    if (!v) {
      throw new UnsupportedError({
        type: `typeof-switch case '${typeStr}' is not a variant of union '${info.name}'`,
      });
    }
    return v;
  };
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
    if (c.test.type !== "Literal" || typeof (c.test as Literal).value !== "string") {
      throw new UnsupportedError({ type: "typeof-switch case is not a string" });
    }
    const testStr = (c.test as Literal).value as string;
    if (c.consequent.length === 0) {
      pending.push(testStr);
      return;
    }
    const tests = [...pending, testStr];
    pending = [];
    const variants = tests.map(variantOf);
    variants.forEach((v) => covered.add(v.name));
    if (variants.length === 1) {
      arms.push(
        buildScalarArm(
          objName,
          info,
          variants[0]!,
          c.consequent,
          (b) => lowerSwitchCaseBody(b, isLast, analysis, scope),
          analysis,
        ),
      );
    } else {
      arms.push({
        guard: null,
        pats: variants.map((v) => ({
          kind: "varPat",
          enumName: info.name,
          variant: v.name,
          binds: [],
          struct: false,
          newtypeBind: "_",
        })),
        body: lowerSwitchCaseBody(c.consequent, isLast, analysis, scope),
      });
    }
  });
  if (pending.length > 0) {
    throw new UnsupportedError({
      type: "trailing empty typeof-switch case with no shared body",
    });
  }
  if (defaultArm) arms.push(defaultArm);
  else if (covered.size < info.variants.length)
    arms.push({ guard: null, body: [] });
  return { kind: "match", disc: { kind: "ident", name: objName }, arms };
}

/**
 * Recognize a `typeof`-narrowing `if`-ladder over a primitive/mixed union (F):
 * `if (typeof x === "string") … else if (typeof x === "number") … [else …]` → a
 * variant `match x`. A trailing `else` covering the one remaining variant binds it.
 */
export function recognizeTypeofIfLadder(
  stmt: IfStatement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt | null {
  const first = typeofEqTest(stmt.test, analysis);
  if (!first) return null;
  const { objName, info } = first;
  const arms: HirMatchArm[] = [];
  const covered = new Set<string>();
  let node: Statement | null = stmt;
  let defaultBody: HirStmt[] | null = null;
  while (node && node.type === "IfStatement") {
    const iff = node as IfStatement;
    const t = typeofEqTest(iff.test, analysis);
    if (!t || t.objName !== objName || t.info.name !== info.name) return null;
    const variant = variantForTypeof(info, t.typeStr);
    if (!variant) return null;
    covered.add(variant.name);
    const rawBody =
      iff.consequent.type === "BlockStatement"
        ? (iff.consequent as BlockStatement).body
        : [iff.consequent];
    arms.push(
      buildScalarArm(
        objName,
        info,
        variant,
        rawBody,
        (b) => lowerStatements(b, analysis, scope),
        analysis,
      ),
    );
    node = iff.alternate;
  }
  if (node) {
    const rawBody =
      node.type === "BlockStatement" ? (node as BlockStatement).body : [node];
    const uncovered = info.variants.filter((v) => !covered.has(v.name));
    if (uncovered.length === 1) {
      const v = uncovered[0]!;
      covered.add(v.name);
      arms.push(
        buildScalarArm(
          objName,
          info,
          v,
          rawBody,
          (b) => lowerStatements(b, analysis, scope),
          analysis,
        ),
      );
    } else {
      defaultBody = lowerStatements(rawBody, analysis, scope);
    }
  }
  if (defaultBody) arms.push({ guard: null, body: defaultBody });
  else if (covered.size < info.variants.length)
    arms.push({ guard: null, body: [] });
  return { kind: "match", disc: { kind: "ident", name: objName }, arms };
}

/** The non-discriminated union (`narrow:"in"`) an identifier binding refers to, else null. */
function inUnionBinding(
  name: string,
  analysis: ModuleAnalysis,
): HirUnionEnum | null {
  const t = analysis.bindingTypes.get(name);
  if (t?.kind !== "struct") return null;
  const info = analysis.unionEnums.get(t.name);
  return info && info.narrow === "in" ? info : null;
}

/** `"field" in x` over a non-discriminated-union binding → {objName, info, field}; else null. */
function inTest(
  test: Expression,
  analysis: ModuleAnalysis,
): { objName: string; info: HirUnionEnum; field: string } | null {
  if (test.type !== "BinaryExpression") return null;
  const b = test as { operator: string; left: Expression; right: Expression };
  if (b.operator !== "in") return null;
  if (b.left.type !== "Literal" || typeof (b.left as Literal).value !== "string") {
    return null;
  }
  if (b.right.type !== "Identifier") return null;
  const objName = (b.right as Identifier).name;
  const info = inUnionBinding(objName, analysis);
  if (!info) return null;
  return { objName, info, field: (b.left as Literal).value as string };
}

/** The variant that *uniquely* contains a field (E `in`-narrowing), else null (ambiguous). */
function variantByUniqueField(
  info: HirUnionEnum,
  field: string,
): HirUnionEnum["variants"][number] | null {
  const vs = info.variants.filter((v) => v.fields.some((f) => f.name === field));
  return vs.length === 1 ? vs[0]! : null;
}

/**
 * Recognize an `"a" in x` narrowing `if`-ladder over a non-discriminated union (E,
 * series 093, 1e) → a variant `match x`. Each rung tests a field present in exactly
 * one variant; the arm binds the read fields (reusing `buildDiscArm`). A trailing
 * `else` covering the one remaining variant binds it. Null when not that shape.
 */
export function recognizeInIfLadder(
  stmt: IfStatement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt | null {
  const first = inTest(stmt.test, analysis);
  if (!first) return null;
  const { objName, info } = first;
  const arms: HirMatchArm[] = [];
  const covered = new Set<string>();
  let node: Statement | null = stmt;
  let defaultBody: HirStmt[] | null = null;
  while (node && node.type === "IfStatement") {
    const iff = node as IfStatement;
    const t = inTest(iff.test, analysis);
    if (!t || t.objName !== objName || t.info.name !== info.name) return null;
    const variant = variantByUniqueField(info, t.field);
    if (!variant) return null;
    covered.add(variant.name);
    const rawBody =
      iff.consequent.type === "BlockStatement"
        ? (iff.consequent as BlockStatement).body
        : [iff.consequent];
    arms.push(
      buildDiscArm(objName, info, variant, rawBody, (b) =>
        lowerStatements(b, analysis, scope),
      ),
    );
    node = iff.alternate;
  }
  if (node) {
    const rawBody =
      node.type === "BlockStatement" ? (node as BlockStatement).body : [node];
    const uncovered = info.variants.filter((v) => !covered.has(v.name));
    if (uncovered.length === 1) {
      const v = uncovered[0]!;
      covered.add(v.name);
      arms.push(
        buildDiscArm(objName, info, v, rawBody, (b) =>
          lowerStatements(b, analysis, scope),
        ),
      );
    } else {
      defaultBody = lowerStatements(rawBody, analysis, scope);
    }
  }
  if (defaultBody) arms.push({ guard: null, body: defaultBody });
  else if (covered.size < info.variants.length)
    arms.push({ guard: null, body: [] });
  return { kind: "match", disc: { kind: "ident", name: objName }, arms };
}
