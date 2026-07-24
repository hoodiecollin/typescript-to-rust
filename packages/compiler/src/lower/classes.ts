/**
 * Lowering: the class family — `class` / `interface` / `enum` (series 021/024/
 * 037/071/072). A class becomes a `struct` + `impl` (constructor synthesis,
 * instance/static methods, accessors, `Symbol.dispose`); an interface becomes a
 * data `struct` and/or a behavioral `trait` with per-class forwarders; an enum
 * becomes a Rust `enum`. Includes the base-class → trait synthesis, heterogeneous
 * (dyn-dispatch) array detection, and the `implements`/`extends` trait wiring.
 * Extracted from the lowering monolith (series 109); the core lowerers and field
 * planners come from the sibling hubs (`./expressions` / `./statements` /
 * `./types`), and the item-level `lowerMethod`/`lowerParam`/`takeDirectives`/
 * `programErrType` from `./index`.
 */

import type { ModuleAnalysis } from "../analysis";
import type {
  ArrayExpression,
  AssignmentExpression,
  CallExpression,
  ClassDeclaration,
  Expression,
  ExpressionStatement,
  FunctionExpression,
  Identifier,
  Literal,
  MemberExpression,
  MethodDefinition,
  NewExpression,
  Param,
  PropertyDefinition,
  Statement,
  TSEnumDeclaration,
  TSInterfaceDeclaration,
  TSType,
} from "../ast";
import { UnsupportedError } from "../errors";
import type {
  GenericParam,
  HirClass,
  HirEnum,
  HirExpr,
  HirFn,
  HirItem,
  HirParam,
  HirStmt,
  HirStruct,
  HirTrait,
  RustType,
} from "../hir";
import { UNIT } from "./constants";
import { baseHopsToField, inferInitType, lowerExpr } from "./expressions";
import {
  lowerMethod,
  lowerParam,
  programErrType,
  takeDirectives,
} from "./index";
import {
  fieldOmitsUndefined,
  fieldRustType,
  lowerStatement,
  lowerStatements,
  lowerTyped,
  planClassFields,
  rejectImpureInitializer,
} from "./statements";
import { lowerType } from "./types";
import type { ClassFieldPlan } from "./statements";
import type { TSTypeParamDecl } from "./index";
import { makeFallible } from "./try-carrier";
import { resultType } from "./utils";

/**
 * Lower an `interface` to a `struct` item. Data-only: `extends` (inheritance) and
 * optional/computed members are rejected (`UnsupportedError`), each a later
 * series. Field types resolve through `structs` so a struct field may name
 * another declared interface (though no fixture exercises nesting yet).
 */
/**
 * Build the method signatures of a behavioral interface (series 071) as bodyless
 * `HirFn`s (`recv: "ref"`). Reused for both the synthesized `trait I<name>` items
 * and the per-class `impl` forwarders. Data (property) members are ignored here —
 * they flow through `structFields` as by-value getters.
 */
export function interfaceMethodSigs(
  decl: TSInterfaceDeclaration,
  structs: Set<string>,
): HirFn[] {
  const sigs: HirFn[] = [];
  for (const m of decl.body.body as unknown as Array<{
    type: string;
    computed?: boolean;
    key: { type?: string; name: string };
    params?: unknown[];
    returnType?: { typeAnnotation: TSType } | null;
  }>) {
    if (m.type !== "TSMethodSignature") continue;
    if (m.computed || m.key.type !== "Identifier") {
      throw new UnsupportedError({
        type: "computed / non-identifier interface method signature",
      });
    }
    const params = (m.params ?? []).map((p) =>
      lowerParam(p as Identifier, undefined, structs),
    );
    const ret = m.returnType
      ? lowerType(m.returnType.typeAnnotation, structs)
      : UNIT;
    sigs.push({
      kind: "fn",
      name: m.key.name,
      isAsync: false,
      params,
      ret,
      body: [],
      recv: "ref",
    });
  }
  return sigs;
}

export function lowerInterface(
  decl: TSInterfaceDeclaration,
  structs: Set<string>,
  analysis: ModuleAnalysis,
): HirStruct | null {
  // A behavioral/mixed interface (series 071) emits **no** struct — its values are
  // backed by a concrete class; the `trait I<name>` is synthesized separately and
  // its data fields (if any) become by-value getters on that trait.
  if (analysis.behavioralInterfaces.has(decl.id.name)) return null;
  // Interface inheritance (series 059): flatten the base interface's fields into
  // this struct (so construction + Debug work), and record it so trait synthesis
  // gives it an `impl I<Base>`. Multi-level `extends` chains via `structFields`
  // (already flattened for the base when it was itself derived).
  const inherited: { name: string; ty: RustType; omitIfNone?: boolean }[] = [];
  for (const h of decl.extends as { expression?: { name?: string } }[]) {
    const baseName = h.expression?.name;
    if (!baseName) continue;
    for (const f of analysis.structFields.get(baseName) ?? []) {
      inherited.push({ name: f.name, ty: f.ty, omitIfNone: f.omitIfNone });
    }
  }
  const own = decl.body.body.map((m) => {
    if (m.type !== "TSPropertySignature" || m.computed) {
      throw new UnsupportedError({ type: "unsupported interface member" });
    }
    if (!m.typeAnnotation) {
      throw new UnsupportedError({
        type: `interface field '${m.key.name}' without a type`,
      });
    }
    // An optional field `x?: T` is `Option<T>` (series 042b); an `undefined`-only
    // field omits its key from JSON when `None` (series 091).
    const annotation = m.typeAnnotation.typeAnnotation;
    const optional = m.optional === true;
    return {
      name: m.key.name,
      ty: fieldRustType(annotation, optional, structs),
      omitIfNone: fieldOmitsUndefined(annotation, optional),
    };
  });
  // Base fields first (a derived struct reads cleanly), then own fields; a shadowed
  // field keeps the derived declaration.
  const seen = new Set(own.map((f) => f.name));
  const fields = [...inherited.filter((f) => !seen.has(f.name)), ...own];
  // A struct used as a `Map` key / `Set` element derives `Hash, PartialEq, Eq`
  // (series 061); `collectHashEqStructs` verified every field is eligible.
  const hashEq = analysis.hashEqStructs.has(decl.id.name);
  return { kind: "struct", name: decl.id.name, fields, hashEq };
}

/**
 * Lower `enum E { A, B = 1 }` (numeric, series 025a) or `enum E { A = "a" }`
 * (string, series 114) to a `HirEnum` (a C-like Rust enum). Variants must be plain
 * identifiers. A **numeric** member's initializer is an integer discriminant; a
 * **string** member carries its source literal as `display`, and `emitEnum`
 * synthesizes an `impl Display`. The two kinds cannot be mixed in one enum
 * (heterogeneous), and `const enum`/computed members stay rejected — each a
 * separate slice.
 */
export function lowerEnum(decl: TSEnumDeclaration): HirEnum {
  if (decl.const) {
    throw new UnsupportedError({
      type: "`const enum` (compile-time inlining)",
    });
  }
  // Classify the enum by its initializers up front so a heterogeneous
  // numeric+string mix fails loud with a clear message (rather than the second
  // kind hitting the first kind's per-member rejection).
  let seenNumeric = false;
  let seenString = false;
  for (const m of decl.body.members) {
    const init = m.initializer;
    if (init?.type === "Literal") {
      const v = (init as Literal).value;
      if (typeof v === "number") seenNumeric = true;
      else if (typeof v === "string") seenString = true;
    }
  }
  if (seenNumeric && seenString) {
    throw new UnsupportedError({
      type: "heterogeneous (mixed numeric + string) enum member initializers",
    });
  }
  const variants = decl.body.members.map((m) => {
    if (m.computed || m.id.type !== "Identifier") {
      throw new UnsupportedError({ type: "computed enum member" });
    }
    let disc: number | null = null;
    let display: string | null = null;
    if (m.initializer) {
      const init = m.initializer;
      if (init.type === "Literal" && typeof (init as Literal).value === "string") {
        // String enum member (series 114) — the source literal is the Display text.
        display = (init as Literal).value as string;
      } else if (
        init.type !== "Literal" ||
        typeof (init as Literal).value !== "number"
      ) {
        throw new UnsupportedError({
          type: "enum member initializer must be an integer or string literal",
        });
      } else {
        const v = (init as Literal).value as number;
        if (!Number.isInteger(v)) {
          throw new UnsupportedError({
            type: "enum member with a fractional discriminant",
          });
        }
        disc = v;
      }
    } else if (seenString) {
      // A bare member in an otherwise-string enum has no source string. TS assigns
      // it the *ordinal* as a number — a heterogeneous shape we don't model.
      throw new UnsupportedError({
        type: "string enum member without an explicit string initializer",
      });
    }
    return { name: m.id.name, disc, display };
  });
  return { kind: "enum", name: decl.id.name, variants };
}

/**
 * Lower a `class` to a `HirClass` (a `struct` + `impl`). Fields come from
 * `PropertyDefinition`s; the constructor becomes an associated `new`; each method
 * becomes an `fn` with a `self` receiver. Inheritance (`extends`/`implements`),
 * statics, accessors, and a missing constructor are rejected — each a later
 * series. Fields are collected first so a method or the constructor may reference
 * a field declared after it.
 */
export function lowerClass(
  decl: ClassDeclaration,
  analysis: ModuleAnalysis,
): HirClass {
  if (!decl.id) throw new UnsupportedError({ type: "anonymous class" });
  // Behavioral-interface conformance (series 071): `class C implements I`. A
  // behavioral/mixed interface contributes an `impl I<I> for C` (method forwarders
  // + 059 data-field getters); a data-only interface has no trait to bind → still
  // fail-loud (a later resolution).
  const interfaceImpls: NonNullable<HirClass["interfaceImpls"]> = [];
  for (const h of (decl.implements ?? []) as Array<{
    expression?: { type?: string; name?: string };
  }>) {
    const iname = h.expression?.name;
    if (!iname || h.expression?.type !== "Identifier") {
      throw new UnsupportedError({ type: "class implements a non-identifier" });
    }
    if (!analysis.behavioralInterfaces.has(iname)) {
      // `implements` of a **pure-data** (methods-less) interface (series 071
      // increment 2) is a field-shape assertion, not a dispatch contract: there
      // is no trait to bind. TS already type-checked that the class structurally
      // carries the interface's fields, so the class stays a plain `struct` with
      // no `impl` synthesized. Skip this clause (contribute no `interfaceImpl`).
      continue;
    }
    const methods = analysis.interfaceMethods.get(iname) ?? [];
    const getters = (analysis.structFields.get(iname) ?? []).map((f) => ({
      field: f.name,
      ty: f.ty,
    }));
    interfaceImpls.push({ trait: traitNameOf(iname), methods, getters });
  }
  const interfaceImplsOpt =
    interfaceImpls.length > 0 ? interfaceImpls : undefined;
  const name = decl.id.name;
  // Generic type parameters (series 081): `class Box<T>` / `<T extends I>` /
  // `<A, B>`. Collect the params + their (behavioral-interface) bounds, and push
  // the names into `analysis.typeParams` for the duration of this class's lowering
  // so field/method/ctor `lowerType` resolves a bare `T` to a `{kind:"param"}`.
  const generics = collectClassGenerics(decl, analysis);
  const prevTypeParams = analysis.typeParams;
  analysis.typeParams =
    generics.length > 0
      ? new Set([...prevTypeParams, ...generics.map((g) => g.name)])
      : prevTypeParams;
  // Series 088: the class-level params are the ones an operator-on-`T` may bind an
  // operator trait onto (a method's own `<U>` is not). Reset the per-class bound
  // accumulator; both are restored after the class lowers (classes don't nest).
  const prevClassTypeParams = analysis.classTypeParams;
  const prevOpBounds = analysis.opBounds;
  analysis.classTypeParams = new Set(generics.map((g) => g.name));
  analysis.opBounds = new Map();
  try {
    return lowerClassBody(decl, analysis, {
      name,
      generics,
      interfaceImpls,
      interfaceImplsOpt,
    });
  } finally {
    analysis.typeParams = prevTypeParams;
    analysis.classTypeParams = prevClassTypeParams;
    analysis.opBounds = prevOpBounds;
  }
}

/**
 * Collect a class's declared generic type params + bounds (series 081). Each
 * `<T>` → `{name}`; `<T extends I>` where `I` is a **behavioral interface** →
 * `{name, bound: traitNameOf(I)}` (reuses 071). Fail-loud residuals (slice 3):
 * a **class** as a bound, a **multi-bound** (`A & B`), and any non-behavioral
 * (data-only / unknown) interface bound — none has a Rust trait to bind.
 */
function collectClassGenerics(
  decl: ClassDeclaration,
  analysis: ModuleAnalysis,
): GenericParam[] {
  const tp = (decl as { typeParameters?: TSTypeParamDecl }).typeParameters;
  if (!tp) return [];
  return tp.params.map((param) => {
    const pname = param.name.name;
    const constraint = param.constraint;
    if (!constraint) return { name: pname };
    // A multi-bound `<T extends A & B>` — no single Rust trait. Fail-loud (slice 3).
    if ((constraint as { type?: string }).type === "TSIntersectionType") {
      throw new UnsupportedError({
        type: `multi-bound generic '<${pname} extends A & B>' (only a single behavioral-interface bound is supported)`,
      });
    }
    if ((constraint as { type?: string }).type !== "TSTypeReference") {
      throw new UnsupportedError({
        type: `generic bound on '${pname}' that is not a behavioral interface`,
      });
    }
    const bname = (constraint as { typeName: { name: string } }).typeName.name;
    // A **class** as a bound isn't a trait (a class isn't a trait unless it is an
    // inheritance base with a synthesized trait) — fail-loud (slice 3 / #40 tail).
    if (analysis.classes.has(bname)) {
      throw new UnsupportedError({
        type: `class '${bname}' used as a generic bound '<${pname} extends ${bname}>' (a class isn't a trait bound)`,
      });
    }
    // Only a **behavioral** interface has a synthesized trait to bind (071). A
    // data-only / unknown interface bound has no trait → fail-loud.
    if (!analysis.behavioralInterfaces.has(bname)) {
      throw new UnsupportedError({
        type: `generic bound '<${pname} extends ${bname}>' where '${bname}' is not a behavioral interface (no trait to bind)`,
      });
    }
    return { name: pname, bound: traitNameOf(bname) };
  });
}

/** The class-body lowering, split from `lowerClass` so the generic-scope push/pop
 * wraps it (series 081). `pre` carries the already-computed `implements` data. */
function lowerClassBody(
  decl: ClassDeclaration,
  analysis: ModuleAnalysis,
  pre: {
    name: string;
    generics: GenericParam[];
    interfaceImpls: NonNullable<HirClass["interfaceImpls"]>;
    interfaceImplsOpt: NonNullable<HirClass["interfaceImpls"]> | undefined;
  },
): HirClass {
  const { name, generics, interfaceImplsOpt } = pre;
  const structs = analysis.structs;
  // Class inheritance (series 053). A subclass `class B extends A` gains a
  // synthetic `base: A` embed (prepended so `super(...)` reads first, like Rust
  // field-init order). `A` must be a declared class (not `Error` — those are
  // error subclasses handled elsewhere, and never reach here).
  const baseName =
    decl.superClass && decl.superClass.type === "Identifier"
      ? (decl.superClass as Identifier).name
      : analysis.superclass.get(name);
  if (decl.superClass && decl.superClass.type !== "Identifier") {
    throw new UnsupportedError({ type: "class extends a non-identifier base" });
  }
  if (baseName && !analysis.classes.has(baseName)) {
    throw new UnsupportedError({
      type: `class extends '${baseName}' which is not a declared class`,
    });
  }
  const base = baseName
    ? { field: "base" as const, ty: { kind: "struct" as const, name: baseName } }
    : undefined;

  // `static` fields → associated `const`s (series 060), collected separately.
  const staticConsts: { name: string; ty: RustType; value: HirExpr }[] = [];
  const propDefs = decl.body.body.filter(
    (m): m is PropertyDefinition => m.type === "PropertyDefinition",
  );
  for (const f of propDefs) {
    rejectProtected(f as { accessibility?: string }, `class field '${f.key.name}'`);
    if (f.computed && !f.static) {
      throw new UnsupportedError({ type: "computed class field" });
    }
    if (f.static) {
      if (f.computed) {
        throw new UnsupportedError({ type: "computed class field" });
      }
      staticConsts.push(lowerStaticConst(f, structs, analysis));
    }
  }
  // Series 070: resolve each instance field's construction source (ctor-assigned /
  // field initializer / `None`) and its Rust type in one pass. Parameter
  // properties are folded in (marked ctor-assigned) in declaration order.
  const fieldPlans = planClassFields(decl, structs, analysis.typeParams);
  const fields = fieldPlans.map((p) => ({
    name: p.name,
    ty: p.ty,
    omitIfNone: p.omitIfNone,
  }));
  // A field initializer must be a construction constant — reject a `this`-/
  // cross-field-referencing one (design §Open sub-details: fail-loud).
  for (const p of fieldPlans) {
    if (p.source === "initializer" && p.init) rejectImpureInitializer(p.name, p.init);
  }

  // Class inheritance (series 053): the synthetic `base: A` embed is *prepended*
  // to the field list, so the struct literal, the struct definition, and the
  // derive walk all see it first (Rust field-init order, and `super(...)` runs
  // before own-field init).
  if (base) fields.unshift({ name: base.field, ty: base.ty, omitIfNone: false });

  let ctor: HirFn | null = null;
  let dispose: HirStmt[] | null = null;
  const methods: HirFn[] = [];
  const statics: HirFn[] = [];
  // Getters/setters (series 060) → methods, with a rewrite at member sites: a
  // read `obj.g` → `obj.g()`, a write `obj.s = v` → `obj.set_s(v)`.
  const accessorFns: HirFn[] = [];
  // Class inheritance (series 053a): mark the class under lowering so a
  // `this.<field>` read can be classified own-vs-inherited (`.base` hop).
  const prevClass = analysis.currentClass;
  analysis.currentClass = name;
  for (const member of decl.body.body) {
    if (member.type !== "MethodDefinition") continue;
    // A `[Symbol.dispose]() { … }` method → the class's `Drop` impl (series 025).
    if (isDisposeMethod(member)) {
      if (!member.value.body) {
        throw new UnsupportedError({ type: "[Symbol.dispose] without a body" });
      }
      dispose = lowerStatements(
        member.value.body.body,
        analysis,
        `${name}.drop`,
      );
      continue;
    }
    if (member.computed) {
      throw new UnsupportedError({ type: "computed class method" });
    }
    rejectProtected(member as { accessibility?: string }, `class method '${member.key.name}'`);
    // `static` method (series 060) → an associated `fn` with no `self` receiver.
    if (member.static) {
      if (member.kind !== "method") {
        throw new UnsupportedError({ type: `static ${member.kind} accessor` });
      }
      statics.push(lowerStaticMethod(member, name, analysis));
      continue;
    }
    if (member.kind === "constructor") {
      ctor = lowerConstructor(
        member.value,
        name,
        fields,
        analysis,
        baseName,
        fieldPlans,
      );
    } else if (member.kind === "method") {
      methods.push(lowerMethod(member, name, analysis));
    } else if (member.kind === "get" || member.kind === "set") {
      // A getter/setter → a method (`g(&self)` / `set_s(&mut self, v)`); the
      // accessor table (`analysis.accessors`) drives the member-site rewrite.
      accessorFns.push(lowerAccessor(member, name, analysis));
    } else {
      throw new UnsupportedError({ type: `class ${member.kind} member` });
    }
  }
  analysis.currentClass = prevClass;
  // Series 088: merge the JS-operator trait bounds accumulated during body lowering
  // onto each class-level `GenericParam` (demand-driven — a param gains only the
  // bounds its operators used). Order-stable (declaration order of the map inserts).
  for (const g of generics) {
    const set = analysis.opBounds.get(g.name);
    if (set && set.size > 0) g.opBounds = [...set];
  }
  // Accessor methods live in the inherent impl alongside ordinary methods.
  methods.push(...accessorFns);
  // Series 070: a class with no explicit constructor synthesizes a zero-param
  // `new()` from its field plans (initializer defaults, `None` for the rest). A
  // user-declared `static new` would collide with it — fail loud rather than
  // silently shadow.
  if (!ctor) {
    if (statics.some((s) => s.name === "new")) {
      throw new UnsupportedError({
        type: "class has a `static new` that collides with the synthesized zero-arg constructor",
      });
    }
    if (baseName) {
      throw new UnsupportedError({
        type: "subclass without an explicit constructor (a `super(...)` call is required)",
      });
    }
    ctor = synthesizeConstructor(name, fields, fieldPlans, analysis);
  }
  // Series 081: a generic class's constructor returns the *parameterized* type
  // `Boxed<T>` (inside `impl<T> Boxed<T>`), not the bare `Boxed`. The ctor return
  // type is the class struct type (`Result`-wrapped when fallible); attach the
  // generic args to it so `emitType` renders `Boxed<T>` / `Result<Boxed<T>, E>`.
  if (generics.length > 0 && ctor) {
    const args: RustType[] = generics.map((g) => ({ kind: "param", name: g.name }));
    const withArgs = (ty: RustType): RustType =>
      ty.kind === "struct" && ty.name === name ? { ...ty, args } : ty;
    ctor = {
      ...ctor,
      ret:
        ctor.ret.kind === "result"
          ? { ...ctor.ret, ok: withArgs(ctor.ret.ok) }
          : withArgs(ctor.ret),
    };
  }
  // Throwing / `?`-propagation inside methods and constructors is supported
  // (series 023): the fallibility fixpoint types the method/ctor as `Result` and
  // `?`-propagates fallible method/`new` calls.
  //
  // Class inheritance (series 053b): a class that participates in an `extends`
  // relationship — either a subclass (`baseName` set) or a base that is itself
  // extended (in `analysis.baseClasses`) — implements the shared trait `I<Root>`
  // (named after the root base). `overrides` names the trait methods this class
  // provides itself; the rest fall through to the trait default (via a
  // forwarder synthesized in the emitter for a subclass, or the default itself
  // for the base). Accessors (053c) are attached later in `lower()` once the
  // module's `dynFieldReads` are known.
  const staticsOpt = statics.length > 0 ? statics : undefined;
  const staticConstsOpt = staticConsts.length > 0 ? staticConsts : undefined;
  const genericsOpt = generics.length > 0 ? generics : undefined;
  const inChain = !!baseName || analysis.baseClasses.has(name);
  // A generic class combined with inheritance or `implements` is out of scope for
  // slices 1+2 (the `impl IA for Name` blocks don't carry generic clauses yet) —
  // fail loud rather than emit a mis-parameterized trait impl (a later slice).
  if (genericsOpt && (inChain || interfaceImplsOpt)) {
    throw new UnsupportedError({
      type: `generic class '${name}' that also participates in inheritance / \`implements\` (a generic + trait-impl combination is not yet supported)`,
    });
  }
  if (!inChain) {
    return {
      kind: "class",
      name,
      fields,
      ctor,
      methods,
      dispose,
      generics: genericsOpt,
      interfaceImpls: interfaceImplsOpt,
      statics: staticsOpt,
      staticConsts: staticConstsOpt,
    };
  }
  const root = rootBaseOf(name, analysis);
  const implTrait = traitNameOf(root);
  const overrides = analysis.overrides.get(name) ?? new Set<string>();
  return {
    kind: "class",
    name,
    fields,
    ctor,
    methods,
    dispose,
    base,
    implTrait,
    overrides,
    interfaceImpls: interfaceImplsOpt,
    statics: staticsOpt,
    staticConsts: staticConstsOpt,
  };
}

/** Reject a `protected` member (series 060) — no Rust equivalent; rejecting is
 * more honest than silently widening to `pub(crate)`. `public`/`private` are
 * accepted (the emitted single-file binary has no cross-module visibility). */
function rejectProtected(
  member: { accessibility?: string },
  what: string,
): void {
  if (member.accessibility === "protected") {
    throw new UnsupportedError({
      type: `${what} is 'protected' (no Rust equivalent; use public/private)`,
    });
  }
}

/**
 * A `static` field → an associated `const` (series 060). Its type comes from the
 * annotation, or is inferred from a literal initializer; the value must be a
 * constant expression (a literal today — a non-const initializer is fail-loud).
 */
function lowerStaticConst(
  f: PropertyDefinition,
  structs: Set<string>,
  analysis: ModuleAnalysis,
): { name: string; ty: RustType; value: HirExpr } {
  if (!f.value) {
    throw new UnsupportedError({
      type: `static field '${f.key.name}' without an initializer`,
    });
  }
  const ty = f.typeAnnotation
    ? lowerType(f.typeAnnotation.typeAnnotation, structs)
    : inferInitType(f.value as Expression, structs);
  if (!ty) {
    throw new UnsupportedError({
      type: `static field '${f.key.name}' needs a type annotation`,
    });
  }
  return { name: f.key.name, ty, value: lowerExpr(f.value as Expression, analysis) };
}

/**
 * A `static` method → an associated `fn` with **no** `self` receiver (series
 * 060). Params infer borrows like any method; the body may reference other
 * statics and construct the class. A call site `Type.m(args)` → `Type::m(args)`.
 */
function lowerStaticMethod(
  member: MethodDefinition,
  className: string,
  analysis: ModuleAnalysis,
): HirFn {
  const fn = member.value;
  const name = member.key.name;
  const structs = analysis.structs;
  const info = analysis.methodParams.get(name);
  const params = fn.params.map((p, i) => lowerParam(p, info?.[i], structs));
  applyBaseParamTraits(params, analysis);
  let ret: RustType;
  if (!fn.returnType) {
    // Series 099 inference tier: infer the static-method return via the oracle.
    const inferred = analysis.typeOracle
      ? analysis.typeOracle.inferredReturnRustType(member.start, member.end)
      : null;
    if (!inferred) {
      throw new UnsupportedError({
        type: `static method '${name}' without a return type annotation`,
      });
    }
    ret = inferred;
  } else {
    ret = lowerType(fn.returnType.typeAnnotation, structs);
  }
  if (!fn.body) throw new UnsupportedError({ type: "static method without a body" });
  const body = lowerStatements(
    takeDirectives(fn.body.body),
    analysis,
    `${className}.${name}`,
  );
  if (analysis.fallibleMethods.has(name)) {
    return {
      kind: "fn",
      name,
      isAsync: fn.async,
      params,
      ret: resultType(ret, programErrType(analysis)),
      body: makeFallible(body, ret),
    };
  }
  return { kind: "fn", name, isAsync: fn.async, params, ret, body };
}

/**
 * A getter/setter → a method (series 060). `get g()` → `fn g(&self) -> T`; a read
 * `obj.g` rewrites to `obj.g()`. `set s(v)` → `fn set_s(&mut self, v: T)`; a write
 * `obj.s = v` rewrites to `obj.set_s(v)`. The accessor names are recorded in
 * `analysis.accessors` (per class) to drive the member-site rewrite.
 */
function lowerAccessor(
  member: MethodDefinition,
  className: string,
  analysis: ModuleAnalysis,
): HirFn {
  const fn = member.value;
  const prop = member.key.name;
  const structs = analysis.structs;
  const acc = analysis.accessors.get(className) ?? {
    getters: new Set<string>(),
    setters: new Set<string>(),
  };
  if (member.kind === "get") {
    acc.getters.add(prop);
    analysis.accessors.set(className, acc);
    let ret: RustType;
    if (!fn.returnType) {
      // Series 099 inference tier: infer the getter return via the oracle.
      const inferred = analysis.typeOracle
        ? analysis.typeOracle.inferredReturnRustType(member.start, member.end)
        : null;
      if (!inferred) {
        throw new UnsupportedError({
          type: `getter '${prop}' without a return type annotation`,
        });
      }
      ret = inferred;
    } else {
      ret = lowerType(fn.returnType.typeAnnotation, structs);
    }
    if (!fn.body) throw new UnsupportedError({ type: "getter without a body" });
    const body = lowerStatements(
      takeDirectives(fn.body.body),
      analysis,
      `${className}.${prop}`,
    );
    return { kind: "fn", name: prop, isAsync: false, params: [], ret, body, recv: "ref" };
  }
  // setter
  acc.setters.add(prop);
  analysis.accessors.set(className, acc);
  const info = analysis.methodParams.get(prop);
  const params = fn.params.map((p, i) => lowerParam(p, info?.[i], structs));
  if (!fn.body) throw new UnsupportedError({ type: "setter without a body" });
  const body = lowerStatements(
    takeDirectives(fn.body.body),
    analysis,
    `${className}.${prop}`,
  );
  return {
    kind: "fn",
    name: `set_${prop}`,
    isAsync: false,
    params,
    ret: UNIT,
    body,
    recv: "refMut",
  };
}

/** The trait name synthesized for a base class `A` — `IA` (design §Trait). */
export function traitNameOf(baseName: string): string {
  return `I${baseName}`;
}

/**
 * Rewrite base-typed params to `impl IA` (series 053b, INH10) and record each as
 * a `dyn` binding, so a `.method()` in the body dispatches through the trait and
 * a base-`.field` read routes through an accessor. A param whose (possibly
 * borrowed) type names an extended base class is monomorphic static dispatch.
 */
export function applyBaseParamTraits(
  params: HirParam[],
  analysis: ModuleAnalysis,
): void {
  for (const p of params) {
    const inner = p.ty.kind === "ref" ? p.ty.inner : p.ty;
    if (inner.kind === "struct" && analysis.baseClasses.has(inner.name)) {
      const base = inner.name;
      p.ty = { kind: "implTrait", trait: traitNameOf(base) };
      analysis.dynBindings.set(p.name, base);
    } else if (
      inner.kind === "struct" &&
      analysis.baseInterfaces.has(inner.name)
    ) {
      // Interface inheritance (series 059): a base-interface param becomes
      // `&impl IA` (borrowed, read-only) — a field read routes to the getter.
      const base = inner.name;
      const traitTy: RustType = { kind: "implTrait", trait: traitNameOf(base) };
      p.ty =
        p.ty.kind === "ref" ? { ...p.ty, inner: traitTy } : traitTy;
      analysis.dynInterfaceBindings.set(p.name, base);
    } else if (
      inner.kind === "struct" &&
      analysis.behavioralInterfaces.has(inner.name)
    ) {
      // Behavioral-interface param (series 071): `s: Shape` → `&impl IShape`; a
      // `.method()` dispatches through the trait, a data-field read routes to the
      // getter (like 059).
      const base = inner.name;
      const traitTy: RustType = { kind: "implTrait", trait: traitNameOf(base) };
      p.ty = p.ty.kind === "ref" ? { ...p.ty, inner: traitTy } : traitTy;
      analysis.dynInterfaceBindings.set(p.name, base);
    }
  }
}

/**
 * Class inheritance trait synthesis (series 053b/c). For each extended base
 * (a root of an `extends` chain), build the shared `trait IA` from the base's
 * public methods (as default bodies) plus on-demand accessors for base fields
 * read through a `dyn IA` (`analysis.dynFieldReads`). Rewire each participating
 * `HirClass`'s `impl IA`:
 *   - the trait-owning **base** moves its methods into the trait defaults and
 *     keeps an empty `impl IA for Base {}` (uses every default);
 *   - a **subclass** provides its overrides directly and a *forwarder*
 *     `fn m(&self){ self.base.m() }` for every non-overridden trait method, plus
 *     an accessor `fn x(&self) -> &T { &self.base.x }` for each polymorphic
 *     field read.
 * Returns the synthesized `HirTrait` items.
 */
export function synthesizeTraits(
  items: HirItem[],
  analysis: ModuleAnalysis,
): HirTrait[] {
  const classByName = new Map<string, HirClass>();
  for (const it of items) {
    if (it.kind === "class") classByName.set(it.name, it);
  }
  const traits: HirTrait[] = [];
  for (const root of analysis.baseClasses) {
    const base = classByName.get(root);
    if (!base) continue;
    const traitName = traitNameOf(root);
    // Trait surface: the base's own public methods (their bodies become the
    // trait defaults). Subclasses may override these; never add new methods.
    const traitMethods = base.methods;
    const traitMethodNames = new Set(traitMethods.map((m) => m.name));
    // Accessors: base fields read through a `dyn IA`. Each maps to the projection
    // reaching the field on that class (`self.x` on the base, `self.base.x` on a
    // subclass). The trait carries only the signature.
    const dynFields = [...(analysis.dynFieldReads.get(root) ?? [])];
    const accessorSigs = dynFields
      .map((field) => {
        const f = base.fields.find((bf) => bf.name === field);
        return f ? { field, ty: f.ty } : null;
      })
      .filter((a): a is { field: string; ty: RustType } => a !== null);
    traits.push({
      kind: "trait",
      name: traitName,
      methods: traitMethods,
      accessors: accessorSigs,
    });

    // Rewire every class in this chain (the base + its transitive subclasses).
    for (const c of classByName.values()) {
      if (rootBaseOf(c.name, analysis) !== root) continue;
      const isBase = c.name === root;
      const overrides = new Set<string>();
      if (isBase) {
        // The base supplies the real bodies for every trait method — mark them
        // all as `overrides` so they land in `impl IA for Base` (not the inherent
        // impl). The trait itself declares only signatures.
        for (const m of c.methods) overrides.add(m.name);
        c.overrides = overrides;
      } else {
        // A subclass: its own methods that match a trait method are overrides.
        const forwarders: HirFn[] = [];
        for (const m of c.methods) {
          if (traitMethodNames.has(m.name)) overrides.add(m.name);
        }
        // Forward every non-overridden trait method to the embedded base.
        for (const tm of traitMethods) {
          if (overrides.has(tm.name)) continue;
          overrides.add(tm.name);
          forwarders.push(makeForwarder(tm));
        }
        c.methods = [...c.methods, ...forwarders];
        c.overrides = overrides;
      }
      // Accessors: the projection to the field on *this* class. On the base it
      // is `self.x`; on a subclass it hops through `.base` to the owner.
      if (accessorSigs.length > 0) {
        c.accessors = accessorSigs.map(({ field, ty }) => ({
          field,
          ty,
          proj: accessorProjection(c.name, field, analysis),
        }));
      }
    }
  }
  return traits;
}

/**
 * Interface-inheritance trait synthesis (series 059). For each extended base
 * interface `A`, build `trait IA` with a by-value getter per A-field, and give the
 * base struct + every derived interface struct an `impl IA` (the base's fields are
 * flattened into each, so `self.x.clone()` always resolves). This is what lets a
 * `B` pass where an `A` is expected — a base-typed param is `&impl IA`.
 */
export function synthesizeInterfaceTraits(
  items: HirItem[],
  analysis: ModuleAnalysis,
): HirTrait[] {
  const structByName = new Map<string, HirStruct>();
  for (const it of items) {
    if (it.kind === "struct") structByName.set(it.name, it);
  }
  const traits: HirTrait[] = [];
  for (const base of analysis.baseInterfaces) {
    const baseStruct = structByName.get(base);
    if (!baseStruct) continue;
    const getters = baseStruct.fields.map((f) => ({ field: f.name, ty: f.ty }));
    const traitName = traitNameOf(base);
    traits.push({
      kind: "trait",
      name: traitName,
      methods: [],
      accessors: [],
      byValueAccessors: getters,
    });
    for (const s of structByName.values()) {
      if (s.name === base || interfaceExtendsBase(s.name, base, analysis)) {
        (s.implTraits ??= []).push({ trait: traitName, getters });
      }
    }
  }
  // Behavioral interfaces (series 071): `trait I<name>` = method sigs + by-value
  // getters for any data fields (mixed). The per-class `impl` blocks are attached
  // in `lowerClass` (`interfaceImpls`), so only the trait item is emitted here.
  for (const name of analysis.behavioralInterfaces) {
    const methods = analysis.interfaceMethods.get(name) ?? [];
    const getters = (analysis.structFields.get(name) ?? []).map((f) => ({
      field: f.name,
      ty: f.ty,
    }));
    traits.push({
      kind: "trait",
      name: traitNameOf(name),
      methods,
      accessors: [],
      byValueAccessors: getters,
    });
  }
  return traits;
}

/** Does interface `name` transitively `extends` `ancestor` (series 059)? */
function interfaceExtendsBase(
  name: string,
  ancestor: string,
  analysis: ModuleAnalysis,
): boolean {
  let cur: string | undefined = analysis.interfaceExtends.get(name);
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = analysis.interfaceExtends.get(cur);
  }
  return false;
}

/** A forwarder trait method `fn m(&self, …) -> R { self.base.m(…) }` (053b). */
function makeForwarder(tm: HirFn): HirFn {
  return {
    kind: "fn",
    name: tm.name,
    isAsync: tm.isAsync,
    params: tm.params,
    ret: tm.ret,
    recv: tm.recv ?? "ref",
    body: [
      {
        kind: "return",
        value: {
          kind: "method",
          receiver: {
            kind: "field",
            object: { kind: "ident", name: "self" },
            name: "base",
          },
          name: tm.name,
          args: tm.params.map((p) => ({ kind: "ident", name: p.name })),
        },
      },
    ],
  };
}

/**
 * Is a base-typed array literal *heterogeneous* (series 053c)? True when it
 * holds a `new C(...)` whose class `C` is a *subclass* of the base (a class name
 * ≠ the base). A literal of only base instances stays a homogeneous `Vec<A>`.
 */
export function isHeterogeneous(
  arr: ArrayExpression,
  base: string,
  analysis: ModuleAnalysis,
): boolean {
  return arr.elements.some((e) => {
    if (!e || e.type !== "NewExpression") return false;
    const callee = (e as NewExpression).callee;
    if (callee.type !== "Identifier") return false;
    const name = (callee as Identifier).name;
    return name !== base && analysis.classes.has(name);
  });
}

/** The `&self` projection reaching `field` on `cls` — `self.x` or `self.base.x` … */
function accessorProjection(
  cls: string,
  field: string,
  analysis: ModuleAnalysis,
): HirExpr {
  const hops = baseHopsToField(cls, field, analysis);
  let obj: HirExpr = { kind: "ident", name: "self" };
  for (let i = 0; i < hops; i++) {
    obj = { kind: "field", object: obj, name: "base" };
  }
  return { kind: "field", object: obj, name: field };
}

/** The root (top-most) base of a class in its `extends` chain (itself if none). */
export function rootBaseOf(name: string, analysis: ModuleAnalysis): string {
  let cur = name;
  let up = analysis.superclass.get(cur);
  while (up && analysis.classes.has(up)) {
    cur = up;
    up = analysis.superclass.get(cur);
  }
  return cur;
}

/** Is this a `[Symbol.dispose]() { … }` method (→ the class's `Drop` impl)? */
function isDisposeMethod(member: MethodDefinition): boolean {
  if (!member.computed) return false;
  const key = member.key as unknown as Expression;
  if (key.type !== "MemberExpression") return false;
  const m = key as MemberExpression;
  return (
    m.object.type === "Identifier" &&
    (m.object as Identifier).name === "Symbol" &&
    m.property.type === "Identifier" &&
    (m.property as Identifier).name === "dispose"
  );
}

/**
 * Lower a `constructor(params) { this.f = e; … }` to an associated
 * `fn new(params) -> Name` returning a struct literal. The body must be a
 * sequence of `this.<field> = <expr>;` assignments covering exactly the declared
 * fields (a Rust struct literal is total) — anything else throws. Params are
 * taken by value (moved into the fields).
 */
function lowerConstructor(
  fn: FunctionExpression,
  className: string,
  fields: { name: string; ty: RustType }[],
  analysis: ModuleAnalysis,
  baseName?: string,
  fieldPlans: ClassFieldPlan[] = [],
): HirFn {
  const structs = analysis.structs;
  // A parameter property (`public x: T`) both declares a field (added in
  // `lowerClass`) and initializes it from the moved-in argument — seed that
  // field-init here and unwrap the binding to an ordinary param.
  const assigned = new Map<string, HirExpr>();
  const params = (fn.params as unknown as Param[]).map((p) => {
    if (p.type === "TSParameterProperty") {
      assigned.set(p.parameter.name, {
        kind: "ident",
        name: p.parameter.name,
      });
      return lowerParam(p.parameter, undefined, structs, analysis.typeParams);
    }
    return lowerParam(p, undefined, structs, analysis.typeParams);
  });
  if (!fn.body) {
    throw new UnsupportedError({ type: "constructor without a body" });
  }
  const isFallible = analysis.fallibleCtors.has(className);
  // Field-init assignments are folded into the returned struct literal; any other
  // statement is a *guard* (`if (…) throw …`), allowed only in a fallible ctor
  // (which returns `Result`), emitted as leading statements before the return.
  const leading: HirStmt[] = [];
  let sawSuper = false;
  for (const stmt of fn.body.body) {
    // Class inheritance (series 053a): `super(args)` in a subclass constructor
    // initializes the synthetic `base: A` embed via `A::new(args)`.
    const superCall = constructorSuperCall(stmt, analysis);
    if (superCall) {
      if (!baseName) {
        throw new UnsupportedError({
          type: "`super(...)` in a class with no base (extends) clause",
        });
      }
      sawSuper = true;
      assigned.set("base", {
        kind: "call",
        callee: `${baseName}::new`,
        args: superCall.map((expr) => ({ borrow: "owned", expr })),
      });
      continue;
    }
    const init = constructorFieldInit(stmt, analysis);
    if (init) {
      assigned.set(init.field, init.value);
      continue;
    }
    if (!isFallible) {
      throw new UnsupportedError({
        type: "constructor body beyond `this.field = expr` initialization",
      });
    }
    leading.push(...lowerStatement(stmt, analysis, `${className}.constructor`));
  }
  // A subclass constructor with no `super(...)` would leave `base` uninitialized
  // — struct-literal totality (INH6). Fail loud.
  if (baseName && !sawSuper) {
    throw new UnsupportedError({
      type: "subclass constructor without a `super(...)` call (base field uninitialized)",
    });
  }
  // Series 070: a partial constructor — one that leaves fields unassigned — fills
  // each gap from its field plan (initializer default, else `None`). The synthetic
  // `base` embed (053) has no plan and must be assigned via `super(...)`.
  const planByName = new Map(fieldPlans.map((p) => [p.name, p]));
  const litFields = fields.map((f) => {
    const value = assigned.get(f.name);
    if (value) return { name: f.name, value };
    const plan = planByName.get(f.name);
    if (!plan) {
      throw new UnsupportedError({
        type: `constructor does not initialize field '${f.name}'`,
      });
    }
    return { name: f.name, value: constructionValue(plan, analysis) };
  });
  const structLit: HirExpr = {
    kind: "structLit",
    name: className,
    fields: litFields,
  };
  if (isFallible) {
    return {
      kind: "fn",
      name: "new",
      isAsync: false,
      params,
      ret: resultType(
        { kind: "struct", name: className },
        programErrType(analysis),
      ),
      body: [
        ...leading,
        { kind: "return", value: { kind: "ok", value: structLit } },
      ],
    };
  }
  return {
    kind: "fn",
    name: "new",
    isAsync: false,
    params,
    ret: { kind: "struct", name: className },
    body: [{ kind: "return", value: structLit }],
  };
}

/**
 * The construction value for a field the constructor doesn't directly assign
 * (series 070): an `initializer`-source field lowers its default *against its own
 * type* (so an `Option`-typed default is `Some`-wrapped); a `none`-source field
 * is `None`. A `ctor`-source field never reaches here (it's assigned in the body).
 */
function constructionValue(
  plan: ClassFieldPlan,
  analysis: ModuleAnalysis,
): HirExpr {
  if (plan.source === "none") return { kind: "none" };
  if (plan.source === "initializer" && plan.init) {
    return lowerTyped(plan.init, plan.ty, analysis);
  }
  throw new UnsupportedError({
    type: `field '${plan.name}' has no construction value`,
  });
}

/**
 * Synthesize a zero-parameter `new()` for a class with no explicit constructor
 * (series 070): every field is filled from its plan — an initializer default or
 * `None`. (A ctor-source field cannot occur without a constructor, so only
 * `initializer`/`none` sources appear here.)
 */
function synthesizeConstructor(
  className: string,
  fields: { name: string; ty: RustType }[],
  fieldPlans: ClassFieldPlan[],
  analysis: ModuleAnalysis,
): HirFn {
  const planByName = new Map(fieldPlans.map((p) => [p.name, p]));
  const litFields = fields.map((f) => {
    const plan = planByName.get(f.name);
    if (!plan) {
      throw new UnsupportedError({
        type: `synthesized constructor cannot initialize field '${f.name}'`,
      });
    }
    return { name: f.name, value: constructionValue(plan, analysis) };
  });
  const structLit: HirExpr = {
    kind: "structLit",
    name: className,
    fields: litFields,
  };
  return {
    kind: "fn",
    name: "new",
    isAsync: false,
    params: [],
    ret: { kind: "struct", name: className },
    body: [{ kind: "return", value: structLit }],
  };
}

/**
 * A constructor statement `super(args);` — the lowered argument expressions, or
 * null if the statement is not a bare `super(...)` call (series 053a).
 */
function constructorSuperCall(
  stmt: Statement,
  analysis: ModuleAnalysis,
): HirExpr[] | null {
  if (stmt.type !== "ExpressionStatement") return null;
  const e = (stmt as ExpressionStatement).expression;
  if (e.type !== "CallExpression") return null;
  const call = e as CallExpression;
  if (call.callee.type !== "Super") return null;
  return call.arguments.map((a) => lowerExpr(a as Expression, analysis));
}

/** A constructor statement `this.<field> = <expr>;`, or null if it is anything else. */
function constructorFieldInit(
  stmt: Statement,
  analysis: ModuleAnalysis,
): { field: string; value: HirExpr } | null {
  if (stmt.type !== "ExpressionStatement") return null;
  const e = (stmt as ExpressionStatement).expression;
  if (e.type !== "AssignmentExpression") return null;
  const assign = e as AssignmentExpression;
  if (assign.operator !== "=") return null;
  const left = assign.left;
  if (left.type !== "MemberExpression") return null;
  const m = left as MemberExpression;
  if (m.computed || m.object.type !== "ThisExpression") return null;
  if (m.property.type !== "Identifier") return null;
  return {
    field: (m.property as Identifier).name,
    value: lowerExpr(assign.right, analysis),
  };
}
