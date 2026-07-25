/**
 * Lowering — union type recognition, registration, and coercion (series 093).
 *
 * The union pre-pass ({@link collectUnions}) that walks the program once and
 * registers a `HirUnionEnum` per literal / discriminated / named-discriminated /
 * primitive / non-discriminated union, plus the construction-site coercions that
 * turn a literal, object literal, or scalar/named value into its union variant
 * (`coerceLiteralToUnion` / `coerceObjectToUnion` / `coerceScalarToUnion`) and the
 * ternary-arm primitive-union synthesis (`synthPrimUnionForArms`). Extracted from
 * the lowering monolith; cyclic imports with `./index` are call-time only.
 */

import type { ModuleAnalysis } from "../analysis";
import type {
  Expression,
  Identifier,
  Literal,
  ObjectExpression,
  Program,
  TSInterfaceDeclaration,
  TSType,
} from "../ast";
import { UnsupportedError } from "../errors";
import type { HirExpr, HirUnionEnum, RustType } from "../hir";
import {
  anonDiscUnionName,
  anonMixedUnionName,
  anonNamedNonDiscUnionName,
  anonNamedUnionName,
  anonNonDiscUnionName,
  anonPrimUnionName,
  anonUnionName,
  classifyDiscriminatedUnion,
  classifyLiteralUnion,
  classifyMixedLiteralObjectUnion,
  classifyNamedDiscriminatedUnion,
  classifyNamedNonDiscriminatedUnion,
  classifyNonDiscriminatedUnion,
  classifyPrimitiveUnion,
  type DiscriminatedUnion,
  extractPropSignatures,
  isMixedLiteralObjectUnion,
  isNullishMember,
  literalVariants,
  mentionsTypeName,
  type LiteralMember,
  type MixedUnion,
  type NamedDiscriminatedUnion,
  type NamedNonDiscriminatedUnion,
  type NonDiscriminatedUnion,
  type PrimMember,
  type PrimitiveUnion,
  type PropSig,
  sanitizeVariantIdent,
} from "../unions";
import { lowerExpr } from "./expressions";
import { lowerTyped } from "./statements";
import { lowerType } from "./types";

/**
 * Union pre-pass (series 093). Walks the whole tree once, synthesizing a
 * {@link HirUnionEnum} per literal union — named by its `type X = …` alias, or
 * `__anonymous_union_<hash>` for an inline/anonymous union (structurally deduped).
 * Runs before `structFields`/`bindingTypes` so a union reference resolves
 * nominally. A `type` alias with a non-union non-trivial RHS is fail-loud here.
 */
export function collectUnions(program: Program, analysis: ModuleAnalysis): void {
  const aliasUnionNodes = new Set<TSType>();
  // Interface name → its own property signatures, for classifying named-interface
  // discriminated unions (D): `type Shape = Circle | Square` needs each interface's
  // fields to find the shared discriminant. Built once from the program body.
  const interfaceProps = new Map<string, PropSig[]>();
  for (const stmt of program.body) {
    if (stmt.type !== "TSInterfaceDeclaration") continue;
    const decl = stmt as TSInterfaceDeclaration;
    const props = extractPropSignatures(decl.body.body);
    if (props) interfaceProps.set(decl.id.name, props);
  }
  const resolveInterface = (name: string): PropSig[] | null =>
    interfaceProps.get(name) ?? null;
  // Named `type X = A | B` aliases first, so their RHS union node is claimed by
  // the alias name (not the anonymous-hash walk below).
  for (const stmt of program.body) {
    if (stmt.type !== "TSTypeAliasDeclaration") continue;
    const decl = stmt as unknown as {
      id: { name: string };
      typeAnnotation: TSType;
      typeParameters?: { params?: unknown[] };
    };
    const rhs = decl.typeAnnotation;
    if (rhs.type === "TSUnionType") {
      const real = (rhs as unknown as { types: TSType[] }).types.filter(
        (m) => !isNullishMember(m),
      );
      // (b) Generic union (type parameters × unions) — needs #59's generics work.
      // Detected before the classifier cascade so a bare `T` member doesn't first
      // trip `lowerType`'s generic "unsupported type" error (series 118 / #82).
      if ((decl.typeParameters?.params?.length ?? 0) > 0) {
        throw new UnsupportedError({
          type: `generic union '${decl.id.name}' (type parameters × unions) is not modeled — tracked in #59`,
        });
      }
      // (a) Recursive / self-referential union — a member (field) references the
      // alias itself; needs #59's boxed recursive-value model (series 118 / #82).
      if (real.some((m) => mentionsTypeName(m, decl.id.name))) {
        throw new UnsupportedError({
          type: `recursive/self-referential union '${decl.id.name}' needs the boxed recursive-value model — tracked in #59`,
        });
      }
      const lits = classifyLiteralUnion(real);
      if (lits) {
        aliasUnionNodes.add(rhs);
        registerUnionEnum(decl.id.name, lits, analysis);
        continue;
      }
      const disc = classifyDiscriminatedUnion(real);
      if (disc) {
        aliasUnionNodes.add(rhs);
        registerDiscriminatedUnion(decl.id.name, disc, analysis);
        continue;
      }
      const named = classifyNamedDiscriminatedUnion(real, resolveInterface);
      if (named) {
        aliasUnionNodes.add(rhs);
        registerNamedDiscriminatedUnion(decl.id.name, named, analysis);
        continue;
      }
      const prim = classifyPrimitiveUnion(real, (n) => analysis.structs.has(n));
      if (prim) {
        aliasUnionNodes.add(rhs);
        registerPrimitiveUnion(decl.id.name, prim, analysis);
        continue;
      }
      const namedNonDisc = classifyNamedNonDiscriminatedUnion(
        real,
        resolveInterface,
      );
      if (namedNonDisc) {
        aliasUnionNodes.add(rhs);
        registerNamedNonDiscriminatedUnion(decl.id.name, namedNonDisc, analysis);
        continue;
      }
      const nondisc = classifyNonDiscriminatedUnion(real);
      if (nondisc) {
        aliasUnionNodes.add(rhs);
        registerNonDiscriminatedUnion(decl.id.name, nondisc, analysis);
        continue;
      }
      // Mixed literal + object members (G, `"loading" | { kind: "done" }`) — a
      // single-level mixed enum (series 118 / #82, graduating 093 §9's UN-FL6): unit
      // variants for the literals + struct variants for the (discriminated) objects.
      const mixed = classifyMixedLiteralObjectUnion(real);
      if (mixed) {
        aliasUnionNodes.add(rhs);
        registerMixedUnion(decl.id.name, mixed, analysis);
        continue;
      }
      // A mixed literal+object union whose object part has **no** shared discriminant
      // (`"x" | { a: number }`) stays fail-loud — narrowing can't select the object
      // variant without a `.kind`-style field.
      if (isMixedLiteralObjectUnion(real)) {
        throw new UnsupportedError({
          type: `union alias '${decl.id.name}' mixes literal and object members but the object part has no shared discriminant — give the object members a shared \`kind\`/\`type\` field (e.g. \`"loading" | { kind: "done"; … }\`)`,
        });
      }
      // Another unmodeled union shape (e.g. two named structs with no discriminant)
      // — leave unregistered (fail-loud at the use site).
      continue;
    }
    // Trivial synonyms / non-union RHSs aren't modeled yet (design §8 — a later
    // sub-stage); fail loud rather than silently drop the alias.
    throw new UnsupportedError({
      type: `type alias '${decl.id.name}' with a non-union right-hand side (only literal-union aliases are modeled so far)`,
    });
  }
  // Inline / anonymous unions anywhere (params, returns, fields, locals).
  walkUnionTypes(program, (ty) => {
    if (aliasUnionNodes.has(ty)) return;
    const real = (ty as unknown as { types: TSType[] }).types.filter(
      (m) => !isNullishMember(m),
    );
    const lits = classifyLiteralUnion(real);
    if (lits) {
      registerUnionEnum(anonUnionName(lits), lits, analysis);
      return;
    }
    const disc = classifyDiscriminatedUnion(real);
    if (disc) {
      registerDiscriminatedUnion(anonDiscUnionName(disc), disc, analysis);
      return;
    }
    const named = classifyNamedDiscriminatedUnion(real, resolveInterface);
    if (named) {
      const nm = anonNamedUnionName(named.members.map((m) => m.interfaceName));
      registerNamedDiscriminatedUnion(nm, named, analysis);
      return;
    }
    const prim = classifyPrimitiveUnion(real, (n) => analysis.structs.has(n));
    if (prim) {
      registerPrimitiveUnion(anonPrimUnionName(prim), prim, analysis);
      return;
    }
    const namedNonDisc = classifyNamedNonDiscriminatedUnion(real, resolveInterface);
    if (namedNonDisc) {
      const nm = anonNamedNonDiscUnionName(
        namedNonDisc.members.map((m) => m.interfaceName),
      );
      registerNamedNonDiscriminatedUnion(nm, namedNonDisc, analysis);
      return;
    }
    const nondisc = classifyNonDiscriminatedUnion(real);
    if (nondisc) {
      registerNonDiscriminatedUnion(anonNonDiscUnionName(nondisc), nondisc, analysis);
      return;
    }
    // Mixed literal + object union (G, series 118 / #82) — an inline one was
    // silently skipped before; register it (an object-part-without-discriminant
    // inline union still falls through to fail-loud at the use site, as before).
    const mixed = classifyMixedLiteralObjectUnion(real);
    if (mixed) registerMixedUnion(anonMixedUnionName(mixed), mixed, analysis);
  });
}

/**
 * Register (idempotently) a discriminated object union → a struct-variant enum
 * (series 093, stage 1b). Field types lower via `lowerType` (the struct set is
 * populated); the discriminant field is dropped from each variant and drives the
 * variant name + `discValue`. Derives `Clone, Debug, PartialEq` (a struct variant
 * may hold a `String`/struct field, so not `Copy`; no `Display`).
 */
export function registerDiscriminatedUnion(
  name: string,
  disc: DiscriminatedUnion,
  analysis: ModuleAnalysis,
): void {
  if (analysis.unionEnums.has(name)) return;
  const seen = new Map<string, number>();
  const variants = disc.members.map((m) => {
    const base = sanitizeVariantIdent(m.discValue);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return {
      name: n === 1 ? base : `${base}${n}`,
      fields: m.fields.map((f) => ({
        name: f.name,
        ty: lowerType(f.ann, analysis.structs),
      })),
      display: null,
      discValue: m.discValue,
    };
  });
  analysis.unionEnums.set(name, {
    kind: "unionEnum",
    name,
    variants,
    displayImpl: false,
    derives: ["Clone", "Debug", "PartialEq"],
    discField: disc.discField,
  });
  analysis.structs.add(name);
}

/**
 * Register (idempotently) a named-interface discriminated union → a **newtype**-
 * variant enum (series 093, stage 1d, case D): `Shape::Circle(Circle)`. Each variant
 * wraps the nominal inner struct; the discriminant field stays inside that struct
 * (the match binds the whole struct). Derives `Clone, Debug, PartialEq` (no `Copy` —
 * a struct payload; no `Display`).
 */
export function registerNamedDiscriminatedUnion(
  name: string,
  named: NamedDiscriminatedUnion,
  analysis: ModuleAnalysis,
): void {
  if (analysis.unionEnums.has(name)) return;
  const variants = named.members.map((m) => ({
    name: m.interfaceName,
    fields: [],
    newtype: { kind: "struct", name: m.interfaceName } as RustType,
    display: null,
    discValue: m.discValue,
  }));
  analysis.unionEnums.set(name, {
    kind: "unionEnum",
    name,
    variants,
    displayImpl: false,
    derives: ["Clone", "Debug", "PartialEq"],
    discField: named.discField,
  });
  analysis.structs.add(name);
}

/**
 * Register (idempotently) a named-struct non-discriminated union → an `in`-narrowed
 * **newtype**-variant enum (series 118 / #82, case f): `FB::Foo(Foo)` narrowed by
 * `"field" in x`. D's payload model (nominal inner struct) with E's narrow. Derives
 * `Clone, Debug, PartialEq`; no `discField`.
 */
export function registerNamedNonDiscriminatedUnion(
  name: string,
  u: NamedNonDiscriminatedUnion,
  analysis: ModuleAnalysis,
): void {
  if (analysis.unionEnums.has(name)) return;
  const variants = u.members.map((m) => ({
    name: m.interfaceName,
    fields: [],
    newtype: { kind: "struct", name: m.interfaceName } as RustType,
    display: null,
  }));
  analysis.unionEnums.set(name, {
    kind: "unionEnum",
    name,
    variants,
    displayImpl: false,
    derives: ["Clone", "Debug", "PartialEq"],
    narrow: "in",
  });
  analysis.structs.add(name);
}

/**
 * Register (idempotently) a primitive/mixed union → a **newtype**-variant enum
 * narrowed by `typeof` (series 093, stage 1d, case F): `Str(String)`, `Num(f64)`,
 * `Bool(bool)`, `Point(Point)`. Derives `Clone, Debug, PartialEq` (a `String`/struct
 * payload → no `Copy`; no `Display`). `narrow:"typeof"` drives the consumption path.
 */
export function registerPrimitiveUnion(
  name: string,
  prim: PrimitiveUnion,
  analysis: ModuleAnalysis,
): void {
  if (analysis.unionEnums.has(name)) return;
  const inner = (m: { tag: string; name: string }): RustType => {
    switch (m.tag) {
      case "str":
        return { kind: "String" };
      case "num":
        return { kind: "f64" };
      case "bool":
        return { kind: "bool" };
      default:
        return { kind: "struct", name: m.name };
    }
  };
  const variants = prim.members.map((m) => ({
    name: m.name,
    fields: [],
    newtype: inner(m),
    display: null,
  }));
  analysis.unionEnums.set(name, {
    kind: "unionEnum",
    name,
    variants,
    // An **all-primitive** union gets a `Display` (series 094) so its value prints
    // directly (`console.log(x)` of a `string | number`, and the auto-synthesized
    // ternary union) — every member (`f64`/`String`/`bool`) impls `Display`. A
    // **mixed** union (a `nom` struct member has no `Display`) stays narrow-then-print.
    displayImpl: prim.members.every((m) => m.tag !== "nom"),
    derives: ["Clone", "Debug", "PartialEq"],
    narrow: "typeof",
  });
  analysis.structs.add(name);
}

/**
 * Register (idempotently) a non-discriminated object union → a struct-variant enum
 * narrowed by `in` (series 093, stage 1e, case E): `{a} | {b}` → `enum { A { a }, B { b } }`.
 * Variant field types lower via `lowerType`. Derives `Clone, Debug, PartialEq`;
 * `narrow:"in"` drives the `"field" in x` consumption path.
 */
export function registerNonDiscriminatedUnion(
  name: string,
  u: NonDiscriminatedUnion,
  analysis: ModuleAnalysis,
): void {
  if (analysis.unionEnums.has(name)) return;
  const variants = u.members.map((m) => ({
    name: m.variantName,
    fields: m.fields.map((f) => ({
      name: f.name,
      ty: lowerType(f.ann, analysis.structs),
    })),
    display: null,
  }));
  analysis.unionEnums.set(name, {
    kind: "unionEnum",
    name,
    variants,
    displayImpl: false,
    derives: ["Clone", "Debug", "PartialEq"],
    narrow: "in",
  });
  analysis.structs.add(name);
}

/**
 * Register (idempotently) a mixed literal + object union → a single enum with
 * **unit** variants for the literals (a `display` for `x === "lit"` matching) and
 * **struct** variants for the (discriminated) objects (series 118 / #82, case G).
 * `narrow:"mixed"` + `discField` drive the single-level mixed `match`. Derives
 * `Clone, Debug, PartialEq` (a struct field → no `Copy`); no `Display`.
 */
export function registerMixedUnion(
  name: string,
  u: MixedUnion,
  analysis: ModuleAnalysis,
): void {
  if (analysis.unionEnums.has(name)) return;
  // Unit variants (literals) carry a `display` for equality mapping; the object
  // struct variants carry a `discValue` for `.kind`/construction selection.
  const literalVs = literalVariants(u.literals);
  const seen = new Map<string, number>();
  const objectVs = u.objects.map((m) => {
    const base = sanitizeVariantIdent(m.discValue);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return {
      name: n === 1 ? base : `${base}${n}`,
      fields: m.fields.map((f) => ({
        name: f.name,
        ty: lowerType(f.ann, analysis.structs),
      })),
      display: null,
      discValue: m.discValue,
    };
  });
  analysis.unionEnums.set(name, {
    kind: "unionEnum",
    name,
    variants: [...literalVs, ...objectVs],
    displayImpl: false,
    derives: ["Clone", "Debug", "PartialEq"],
    narrow: "mixed",
    discField: u.discField,
  });
  analysis.structs.add(name);
}

/** Register (idempotently) a literal-union enum + merge its name into `structs`. */
export function registerUnionEnum(
  name: string,
  lits: LiteralMember[],
  analysis: ModuleAnalysis,
): void {
  if (analysis.unionEnums.has(name)) return;
  analysis.unionEnums.set(name, {
    kind: "unionEnum",
    name,
    variants: literalVariants(lits),
    displayImpl: true,
    derives: ["Clone", "Copy", "Debug", "PartialEq"],
  });
  analysis.structs.add(name);
}

/** Depth-first walk visiting every `TSUnionType` node in the tree. */
export function walkUnionTypes(node: unknown, visit: (ty: TSType) => void): void {
  if (Array.isArray(node)) {
    for (const c of node) walkUnionTypes(c, visit);
    return;
  }
  if (!node || typeof node !== "object") return;
  if ((node as { type?: string }).type === "TSUnionType") visit(node as TSType);
  for (const k in node as Record<string, unknown>) {
    if (k === "type") continue;
    walkUnionTypes((node as Record<string, unknown>)[k], visit);
  }
}

/**
 * Coerce a string/number **literal** AST expression to its union-enum variant
 * (`"north"` in a `Dir` slot → `Dir::North`), or null when `unionName` is not a
 * registered union or `expr` is not a matching literal. The construction primitive
 * shared by let-init/field/arg/return/`switch`/`===` coercion sites (series 093).
 */
export function coerceLiteralToUnion(
  expr: Expression,
  unionName: string,
  analysis: ModuleAnalysis,
): HirExpr | null {
  const info = analysis.unionEnums.get(unionName);
  if (!info || expr.type !== "Literal") return null;
  const v = (expr as Literal).value;
  if (typeof v !== "string" && typeof v !== "number") return null;
  const variant = info.variants.find((vt) => vt.display === String(v));
  if (!variant) return null;
  return { kind: "enumVariant", enumName: unionName, variant: variant.name, fields: [] };
}

/** The union-enum name of an operand when it is a union-typed identifier, else null. */
export function unionTypeOfOperand(
  e: Expression,
  analysis: ModuleAnalysis,
): string | null {
  if (e.type !== "Identifier") return null;
  const t = analysis.bindingTypes.get((e as Identifier).name);
  return t?.kind === "struct" && analysis.unionEnums.has(t.name) ? t.name : null;
}

/**
 * Coerce an object literal to its union variant: a discriminated union (C/D, 1b) by
 * the discriminant value (`{kind:"circle", r:2}` in a `Shape` slot → `Shape::Circle
 * { r: 2.0 }`, or a newtype `Shape::Circle(Circle{…})` for a named-interface member),
 * or a non-discriminated union (E, 1e) by an exact field-name-set match. Returns null
 * for a spread/computed key or when no variant matches.
 */
export function coerceObjectToUnion(
  obj: ObjectExpression,
  info: HirUnionEnum,
  analysis: ModuleAnalysis,
): HirExpr | null {
  const propByName = new Map<string, Expression>();
  for (const p of obj.properties) {
    if (p.type !== "Property" || p.computed) return null;
    const key = p.key;
    const name =
      key.type === "Identifier"
        ? (key as Identifier).name
        : key.type === "Literal" && typeof (key as Literal).value === "string"
          ? ((key as Literal).value as string)
          : null;
    if (name == null) return null;
    propByName.set(name, p.value as Expression);
  }
  // Build a variant's struct fields from the collected props (a missing optional
  // field defaults to `None`, mirroring struct-literal coercion).
  const buildFields = (variant: HirUnionEnum["variants"][number]) =>
    variant.fields.map((f) => {
      const value = propByName.get(f.name);
      if (value === undefined) {
        if (f.ty.kind === "option")
          return { name: f.name, value: { kind: "none" } as HirExpr };
        return {
          name: f.name,
          value: lowerExpr(
            { type: "Identifier", name: "undefined" } as unknown as Expression,
            analysis,
          ),
        };
      }
      return { name: f.name, value: lowerTyped(value, f.ty, analysis) };
    });

  // Discriminated (C/D): the discriminant value selects the variant.
  if (info.discField) {
    const discExpr = propByName.get(info.discField);
    if (!discExpr || discExpr.type !== "Literal") return null;
    const v = (discExpr as Literal).value;
    const discVal =
      typeof v === "string" || typeof v === "number" ? String(v) : null;
    if (discVal == null) return null;
    const variant = info.variants.find((vt) => vt.discValue === discVal);
    if (!variant) return null;
    // A newtype variant (D): build the nominal inner struct from the *whole* object
    // literal (the discriminant stays inside it), then wrap `Shape::Circle(<inner>)`.
    if (variant.newtype) {
      return {
        kind: "enumVariant",
        enumName: info.name,
        variant: variant.name,
        fields: [],
        newtype: lowerTyped(obj, variant.newtype, analysis),
      };
    }
    return {
      kind: "enumVariant",
      enumName: info.name,
      variant: variant.name,
      fields: buildFields(variant),
    };
  }

  // Non-discriminated (E / f): match the object's exact field-name set to a variant.
  // An inline-object variant (E) matches on its own `fields`; a **newtype** variant
  // (f, named-non-disc) matches on its inner struct's fields and builds
  // `FB::Foo(Foo{…})` from the whole object literal.
  if (info.narrow === "in") {
    const keys = [...propByName.keys()].sort();
    const variant = info.variants.find((vt) => {
      const set = (
        vt.newtype && vt.newtype.kind === "struct"
          ? (analysis.structFields.get(vt.newtype.name) ?? []).map((f) => f.name)
          : vt.fields.map((f) => f.name)
      ).sort();
      return set.length === keys.length && set.every((n, i) => n === keys[i]);
    });
    if (!variant) return null;
    if (variant.newtype) {
      return {
        kind: "enumVariant",
        enumName: info.name,
        variant: variant.name,
        fields: [],
        newtype: lowerTyped(obj, variant.newtype, analysis),
      };
    }
    return {
      kind: "enumVariant",
      enumName: info.name,
      variant: variant.name,
      fields: buildFields(variant),
    };
  }
  return null;
}

/** The static inner `RustType` of a scalar/named expression usable for union-variant
 * selection (series 093, 1d): a string/number/boolean literal, a template literal
 * (String), or an identifier resolved via `bindingTypes`. Null when indeterminate. */
export function inferScalarInner(
  expr: Expression,
  analysis: ModuleAnalysis,
): RustType | null {
  if (expr.type === "Literal") {
    const v = (expr as Literal).value;
    if (typeof v === "string") return { kind: "String" };
    if (typeof v === "number") return { kind: "f64" };
    if (typeof v === "boolean") return { kind: "bool" };
    return null;
  }
  if (expr.type === "TemplateLiteral") return { kind: "String" };
  if (expr.type === "Identifier") {
    return analysis.bindingTypes.get((expr as Identifier).name) ?? null;
  }
  return null;
}

/** Do two newtype inner `RustType`s match (by kind, and struct name)? */
export function newtypeInnerMatches(a: RustType, b: RustType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "struct" && b.kind === "struct") return a.name === b.name;
  return true;
}

/**
 * Coerce a scalar/named value into its newtype union variant (series 093, 1d): a
 * `Circle`-typed identifier into a `Shape` slot → `Shape::Circle(c)` (D from a
 * variable); a `string` value into `string|number` → `…::Str(v)` (F). The variant
 * is the one whose newtype inner matches the value's static type. Null otherwise.
 */
export function coerceScalarToUnion(
  expr: Expression,
  info: HirUnionEnum,
  analysis: ModuleAnalysis,
): HirExpr | null {
  const inner = inferScalarInner(expr, analysis);
  if (!inner) return null;
  const variant = info.variants.find(
    (v) => v.newtype && newtypeInnerMatches(v.newtype, inner),
  );
  if (!variant?.newtype) return null;
  return {
    kind: "enumVariant",
    enumName: info.name,
    variant: variant.name,
    fields: [],
    newtype: lowerTyped(expr, variant.newtype, analysis),
  };
}

/**
 * The `PrimMember` for a scalar `RustType`, or null for a non-primitive (a struct
 * arm has no `Display`, so it can't seed a *printable* synthesized union — series
 * 094).
 */
export function primMemberOf(t: RustType): PrimMember | null {
  if (t.kind === "String") return { tag: "str", name: "Str" };
  if (t.kind === "f64") return { tag: "num", name: "Num" };
  if (t.kind === "bool") return { tag: "bool", name: "Bool" };
  return null;
}

/**
 * Synthesize (idempotently) an anonymous primitive union from two heterogeneous
 * ternary-arm scalar types in an *untyped* value position (series 094): `c ? 1 :
 * "a"` → `__anonymous_union_<hash>` with `Num(f64)`/`Str(String)` newtype variants
 * plus a `Display` (so the value prints, matching JS `String(v)`). Returns the
 * registered enum, or null when either arm is a non-primitive (no `Display`).
 */
export function synthPrimUnionForArms(
  a: RustType,
  b: RustType,
  analysis: ModuleAnalysis,
): HirUnionEnum | null {
  const ma = primMemberOf(a);
  const mb = primMemberOf(b);
  if (!ma || !mb || ma.tag === mb.tag) return null;
  const u: PrimitiveUnion = { members: [ma, mb] };
  const name = anonPrimUnionName(u);
  registerPrimitiveUnion(name, u, analysis);
  return analysis.unionEnums.get(name) ?? null;
}
