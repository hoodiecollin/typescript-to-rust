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

import {
  type ModuleAnalysis,
  SCRIPT_SCOPE,
  analyzeModule,
  isErrorSubclass,
} from "./analysis";
import { refineArena } from "./arena";
import { isTypePartialEq } from "./derives";
import type { SourceModule } from "./crate";
import type { StdShimName } from "./std-shim";
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
  FunctionDeclaration,
  FunctionExpression,
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
  ReturnStatement,
  Statement,
  SwitchStatement,
  TSEnumDeclaration,
  TSInterfaceDeclaration,
  TSType,
  TSTypeAnnotation,
  ThrowStatement,
  TryStatement,
  VariableDeclaration,
  VariableDeclarator,
  WhileStatement,
} from "./ast";
import { DialectError, UnsupportedError } from "./errors";
import { translateRegex, translateReplacement } from "./regex-translate";
import type {
  Borrow,
  ElemMode,
  GenericParam,
  HirArg,
  HirCatchArm,
  HirClass,
  HirEnum,
  HirErrorEnum,
  HirExpr,
  HirFn,
  HirGenerator,
  HirItem,
  HirMatchArm,
  HirMod,
  HirModule,
  HirParam,
  HirStmt,
  HirStruct,
  HirStructKey,
  HirTrait,
  HirUnionEnum,
  MapBuildPart,
  RustType,
  SelfRecv,
  Vis,
} from "./hir";
import { refineBitwise } from "./bitwise";
import { refineNumerics } from "./numeric";
import { refineOwnership } from "./ownership";
import { refineTaskEscape } from "./task-escape";
import { refineRc } from "./rc";
import { computeAutoRc } from "./alias-escape";
import { refineStrAppend } from "./str-append";
import { refineStrings } from "./strings";
import { refineIterFusion } from "./iter-fusion";
import { refineSplitLazy } from "./split-lazy";
import {
  createCrateTypeOracle,
  createTypeOracle,
  type OracleFile,
} from "./type-oracle";
import { validate } from "./validate";
import {
  anonDiscUnionName,
  anonNamedUnionName,
  anonNonDiscUnionName,
  anonPrimUnionName,
  anonUnionName,
  classifyDiscriminatedUnion,
  classifyLiteralUnion,
  classifyNamedDiscriminatedUnion,
  classifyNonDiscriminatedUnion,
  classifyPrimitiveUnion,
  type DiscriminatedUnion,
  extractPropSignatures,
  fnv1a,
  isMixedLiteralObjectUnion,
  isNullishMember,
  literalVariants,
  type LiteralMember,
  namedRef,
  type NamedDiscriminatedUnion,
  type NonDiscriminatedUnion,
  type PrimMember,
  type PrimitiveUnion,
  type PropSig,
  sanitizeVariantIdent,
} from "./unions";

// Compat re-export for test/external importers that still say `from "./lower"`
// (and the emitter's own re-export). Both classes live in ./errors; the src
// siblings (numeric/bitwise/emitter) import them from there directly, so this is
// no longer a cycle — just a convenience surface. Migrating the remaining
// importers to ./errors and dropping this is a Phase-2 cleanup candidate.
export { DialectError, UnsupportedError };

const UNIT: RustType = { kind: "unit" };
/** The default fallible error type: the `Error` message as a `String`. */
const ERR_STRING: RustType = { kind: "String" };

/**
 * A `<T, U extends I>` type-parameter declaration on a class/method/fn (series
 * 081) — the oxc `TSTypeParameterDeclaration` shape we read: each param's name and
 * its (optional) `extends` constraint.
 */
interface TSTypeParamDecl {
  params: {
    name: { name: string };
    constraint?: TSType | null;
  }[];
}

/** Wrap an ok-type in `Result<ok, err>`. */
function resultType(ok: RustType, err: RustType): RustType {
  return { kind: "result", ok, err };
}

/**
 * The program-wide error type: the synthesized `AppError` enum when any custom
 * error class is declared (series 049), else `String`. Uniform across every
 * fallible function so `?` composes.
 */
function programErrType(analysis: ModuleAnalysis): RustType {
  return analysis.errorClasses.size > 0 ? { kind: "appError" } : ERR_STRING;
}

/**
 * Synthesize the one whole-program `AppError` enum (series 049) from the declared
 * custom error classes (each a struct variant, `message: String` first, then its
 * declared typed fields) plus a fixed `Other { message: String }` catch-all.
 * Returns `null` when no custom error class is declared (`E` stays `String`, no
 * enum emitted — the 022-no-custom compat path). `#[error("{message}")]` is
 * option (A): Display shows only the message, mirroring JS `String(err)`.
 */
function synthesizeErrorEnum(analysis: ModuleAnalysis): HirErrorEnum | null {
  if (analysis.errorClasses.size === 0) return null;
  const variants = [...analysis.errorClasses.values()].map((c) => ({
    name: c.name,
    fields: [
      { name: "message", ty: ERR_STRING },
      ...c.fields.map((f) => ({ name: f.name, ty: f.ty })),
    ],
    display: "{message}",
  }));
  variants.push({
    name: "Other",
    fields: [{ name: "message", ty: ERR_STRING }],
    display: "{message}",
  });
  return { kind: "errorEnum", variants };
}

/**
 * Lower a whole program to HIR.
 * @throws {UnsupportedError} on any construct outside the implemented dialect.
 */
/** A Copy scalar payload (#70) needs no `Rc` wrapper around a value default. */
function isScalarType(t: RustType): boolean {
  return (
    t.kind === "f64" ||
    t.kind === "i64" ||
    t.kind === "i128" ||
    t.kind === "usize" ||
    t.kind === "bool"
  );
}

export function lower(
  program: Program,
  source?: string,
  crateNamespaces?: ReadonlySet<string>,
  crateOracleFiles?: OracleFile[],
  crateDefaults?: CrateDefaults,
): HirModule {
  // Extract `namespace Foo { … }` blocks (series 050d, Axis 4) **before** the
  // dialect gate — each lowers recursively to an inline `mod Foo { pub … }` below,
  // and pulling them out keeps `validate` from seeing the namespace wrapper or its
  // inner `export`s. The remaining program is namespace-free.
  const nsExtract = extractNamespaces(program);
  const nsProgram = nsExtract.program;
  // All path-root names (import aliases + this program's namespaces) — a member
  // access `X.y` on any of these routes to the Rust path `X::y`.
  const pathRoots = new Set<string>(crateNamespaces ?? []);
  for (const ns of nsExtract.namespaces) pathRoots.add(ns.name);
  // Step 2: reject input forbidden by the dialect (`any`/`unknown`, …) — fail
  // loud with `DialectError`, distinct from the "not yet implemented" gate below.
  validate(nsProgram);
  // Normalize a top-level `const f = (…) => …` arrow into a synthetic function
  // declaration *before* analysis, so ownership, fallibility, and lowering treat
  // it identically to a `function` (see normalizeArrows).
  const normalized = normalizeArrows(nsProgram);
  const analysis = analyzeModule(normalized);
  // Namespace / import-alias path roots (series 050d, Axis 4): the crate layer
  // passes its `import * as ns` aliases; a `namespace Foo {}` adds `Foo`. So
  // `ns.f()` / `Foo.bar()` route to the module path `ns::f()` / `Foo::bar()`.
  for (const n of pathRoots) analysis.namespaces.add(n);
  // Enum names are nominal types too — resolve them like structs in `lowerType`
  // (the emitter renders both as the bare name). They stay in `analysis.enums`
  // as well, so a member access `E.Variant` still lowers to a path, not a field.
  for (const e of analysis.enums) analysis.structs.add(e);
  // Union types (series 093): synthesize a `HirUnionEnum` per `type X = A | B`
  // alias and inline/anonymous union, merging their names into `structs` — before
  // `structFields`/`bindingTypes` so a union reference resolves nominally.
  collectUnions(normalized, analysis);
  // TypeScript-checker-backed type oracle (series 082, spike #44). Built only
  // when the caller threads the original source text; the struct set is complete
  // here (enums merged), so a struct-typed Map key/elem resolves nominally. When
  // absent, `collectionOf` falls back to the `bindingTypes` path alone (exactly
  // pre-082 behavior), so every existing `lower(program)` call site is unchanged.
  if (crateOracleFiles) {
    // Crate lowering (#68): one oracle over ALL crate sources so tsc resolves
    // `./`-relative imports — a cross-module untyped binding infers *through* the
    // import. Built here (not in `lowerCrate`) so `structs` is the crate-global set.
    analysis.typeOracle = createCrateTypeOracle(crateOracleFiles, analysis.structs);
  } else if (source !== undefined) {
    analysis.typeOracle = createTypeOracle(source, analysis.structs);
  }
  // Struct field types (series 032) — a pre-pass so a struct object literal can
  // recurse into a struct-typed field / array element wherever it appears.
  analysis.structFields = collectStructFields(normalized, analysis.structs);
  // Binding → type map (series 048): every `const`/`let`/`var` and function param
  // resolved to a `RustType`, so callback lifting can type a forwarded free var
  // and a receiver's element type. Needs `lowerType`, so it runs here, not in
  // `analyzeModule`.
  analysis.bindingTypes = collectBindingTypes(normalized, analysis.structs);
  // Value `export default` pre-pass (#70): infer each lazy static's payload type
  // via the crate oracle (available now), then seed every consumer default-import
  // local with that type and mark it for deref. `lazyInfo` feeds the item loop.
  const lazyInfo = new Map<
    string,
    { ty: RustType; rc: boolean; init: Expression }
  >();
  if (crateDefaults) {
    for (const stmt of normalized.body) {
      if (stmt.type !== "VariableDeclaration") continue;
      for (const dcl of (stmt as VariableDeclaration).declarations) {
        const nm = (dcl.id as { name?: string }).name;
        if (!nm || !crateDefaults.lazyNames.has(nm) || !dcl.init) continue;
        const init = dcl.init;
        // A bare primitive literal confuses tsc's `getTypeAtLocation` under
        // `export default` (it reports `any`), so type it straight from the AST;
        // everything else (array, `new X()`, a call, …) goes through the oracle.
        let ty: RustType | null = null;
        if (init.type === "Literal") {
          const v = (init as Literal).value;
          if (typeof v === "number") ty = { kind: "f64" };
          else if (typeof v === "string") ty = { kind: "String" };
          else if (typeof v === "boolean") ty = { kind: "bool" };
        }
        if (!ty) {
          ty =
            analysis.typeOracle?.inferredRustType(init.start, init.end) ?? null;
        }
        if (!ty) {
          throw new UnsupportedError({
            type: "value `export default` whose type can't be inferred (annotate the value, or default-export a named fn/class)",
            start: init.start,
          });
        }
        // `Rc` can't live in a `static` (not `Sync`); the bare payload (`Vec`,
        // `String`, a data struct) is `Sync + Send`, so store `LazyLock<T>` directly
        // and deep-clone on an owned use. `rc` stays false (kept for a future `Arc`).
        lazyInfo.set(nm, { ty, rc: false, init });
      }
    }
    for (const [local, modKey] of crateDefaults.importLocals) {
      const sym = crateDefaults.symByMod.get(modKey);
      const info = sym ? lazyInfo.get(sym) : undefined;
      if (info) analysis.bindingTypes.set(local, info.ty);
      analysis.lazyDefaultLocals.add(local);
    }
    // A non-scalar value default is a `LazyLock<T>` accessed by deref — reads
    // borrow fine, but an **owned move** (`const x = def`, `return def`, `x = def`,
    // an object/array element) can't move out of the cell. Rather than emit code
    // cargo rejects (E0507), fail loud with guidance. A borrow (`def[i]`, `def.m()`,
    // `console.log(def)`) is unaffected. (Owned-move support is a follow-on.)
    const isOwnedMoveOfLazy = (e: unknown): string | null => {
      const n = e as { type?: string; name?: string } | null;
      if (!n || n.type !== "Identifier" || !n.name) return null;
      if (!analysis.lazyDefaultLocals.has(n.name)) return null;
      const ty = analysis.bindingTypes.get(n.name);
      return ty && !isScalarType(ty) ? n.name : null;
    };
    const failOwned = (name: string): never => {
      throw new UnsupportedError({
        type: `owned move of the value \`export default\` import '${name}' (a LazyLock value can't be moved out — read its fields/elements in place, or default-export a named fn/class)`,
      });
    };
    const guardOwned = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const el of node) guardOwned(el);
        return;
      }
      const rec = node as Record<string, unknown> & { type?: string };
      const check = (slot: unknown): void => {
        const nm = isOwnedMoveOfLazy(slot);
        if (nm) failOwned(nm);
      };
      switch (rec.type) {
        case "VariableDeclarator":
          check(rec.init);
          break;
        case "ReturnStatement":
          check(rec.argument);
          break;
        case "AssignmentExpression":
          check(rec.right);
          break;
        case "Property":
          check(rec.value);
          break;
        case "ArrayExpression":
          for (const el of (rec.elements as unknown[]) ?? []) check(el);
          break;
      }
      for (const k in rec) {
        if (k === "start" || k === "end") continue;
        const v = rec[k];
        if (v && typeof v === "object") guardOwned(v);
      }
    };
    guardOwned(normalized);
  }
  // Manual-`step()` generator consumers (series 075): a whole-program scan for
  // `it.next()` / `g().next()`, `const [a, b] = g()`, and `const r = yield* inner()`
  // that forces the referenced generator to the state-machine struct (the surface
  // that carries `step()` / `Steppable`), never the straight-line fast path. Needs
  // the generator names and the binding→generator map, so it runs here.
  collectSteppedGenerators(normalized, analysis);
  // Generator name → declared completion type `R` (series 075) — the 2nd
  // `Generator<Y, R>` type arg. Used to type a read `yield*` delegate's `Steppable`
  // box. Absent 2nd arg → unit (a value-less delegate).
  for (const stmt of normalized.body) {
    if (
      stmt.type === "FunctionDeclaration" &&
      (stmt as { generator?: boolean }).generator === true
    ) {
      const gname = (stmt as { id?: { name?: string } }).id?.name;
      const gann = (stmt as FunctionDeclaration).returnType?.typeAnnotation;
      const gref =
        gann?.type === "TSTypeReference"
          ? (gann as Extract<TSType, { type: "TSTypeReference" }>)
          : null;
      const yAnn = gref?.typeArguments?.params?.[0];
      const rAnn = gref?.typeArguments?.params?.[1];
      // The 3rd `Generator<Y, R, TNext>` arg (series 076): the resume-in type that
      // types `resume(&mut self, sent: TNext)`. Absent for a non-bidirectional
      // generator (a read yield result over one → fail-loud in the state machine).
      const nAnn = gref?.typeArguments?.params?.[2];
      if (gname && yAnn) {
        analysis.generatorItemTypes.set(
          gname,
          lowerType(yAnn, analysis.structs),
        );
      }
      if (gname && rAnn) {
        analysis.generatorRetTypes.set(gname, lowerType(rAnn, analysis.structs));
      }
      if (gname && nAnn) {
        analysis.generatorNextTypes.set(
          gname,
          lowerType(nAnn, analysis.structs),
        );
      }
    }
  }
  // Struct `Map` keys / `Set` elements: an `f64`-free struct derives
  // `Hash, PartialEq, Eq` (series 061); a struct with a *direct* `f64` field gets
  // a synthesized SameValueZero key newtype (series 074); an `f64` nested in a
  // sub-struct field is fail-loud. Needs the resolved map/set types
  // (`bindingTypes`), so it runs here.
  {
    const { hashEq, structKey } = collectHashEqStructs(analysis);
    analysis.hashEqStructs = hashEq;
    analysis.structKeyStructs = structKey;
    // Rewrite the resolved binding types (series 074): a `Map`/`Set` whose key /
    // element is an f64-bearing key struct keys on the synthesized newtype, not
    // the struct itself. Done before any body is lowered, so `collectionOf` →
    // `wrapKey` sees `structKey` and wraps/unwraps at every boundary.
    if (structKey.size > 0) {
      for (const ty of analysis.bindingTypes.values()) {
        retargetStructKey(ty, structKey);
      }
    }
  }
  // `readonly` field names per struct (series 059) — assignment to one is a
  // `DialectError` (construction stays allowed).
  analysis.readonlyFields = collectReadonlyFields(normalized);
  // Interface inheritance (series 059): which interfaces are `extends`ed (→ a
  // getter trait) and each derived interface's base.
  for (const stmt of normalized.body) {
    if (stmt.type !== "TSInterfaceDeclaration") continue;
    const decl = stmt as TSInterfaceDeclaration;
    for (const h of decl.extends as { expression?: { name?: string } }[]) {
      const baseName = h.expression?.name;
      if (baseName) {
        analysis.baseInterfaces.add(baseName);
        analysis.interfaceExtends.set(decl.id.name, baseName);
      }
    }
    // Behavioral interface (series 071): ≥1 method signature → a synthesized
    // `trait I<name>` carrying the method sigs (+ 059 getters for data fields).
    const methodSigs = interfaceMethodSigs(decl, analysis.structs);
    if (methodSigs.length > 0) {
      analysis.behavioralInterfaces.add(decl.id.name);
      analysis.interfaceMethods.set(decl.id.name, methodSigs);
    }
  }
  // Error-class shapes (series 049b): validate each `class X extends Error` and
  // collect its ordered typed fields into `analysis.errorClasses`, *before* any
  // function body is lowered — a `throw new X(…)` inside a body constructs the
  // `AppError::X` variant and needs the field order. Needs `lowerType`, so it
  // runs here (like `structFields`), not in `analyzeModule`.
  for (const stmt of normalized.body) {
    if (stmt.type === "ClassDeclaration" && isErrorSubclass(stmt)) {
      const shape = lowerErrorClass(stmt as ClassDeclaration, analysis.structs);
      analysis.errorClasses.set(shape.name, shape);
    }
  }
  const items: HirItem[] = [];
  const script: Statement[] = [];

  // The one synthesized `AppError` enum (series 049) leads the items when any
  // custom error class is declared; nothing when none is (E stays String).
  const errorEnum = synthesizeErrorEnum(analysis);
  if (errorEnum) items.push(errorEnum);

  for (const stmt of normalized.body) {
    if (stmt.type === "ImportDeclaration") {
      // The `@ttr/std` import (series 084) is recognition-only — its bindings
      // were collected into `analysis.stdShim`; it lowers to no Rust. The
      // validator already rejected every other import specifier.
      continue;
    }
    if (stmt.type === "FunctionDeclaration") {
      // A sync generator (`function* g()`, series 025d) lowers to a
      // `fn -> impl Iterator`; a plain function to a normal `fn`.
      items.push(
        (stmt as { generator?: boolean }).generator === true
          ? lowerGenerator(stmt as FunctionDeclaration, analysis)
          : lowerFunction(stmt as FunctionDeclaration, analysis),
      );
    } else if (stmt.type === "TSInterfaceDeclaration") {
      const lowered = lowerInterface(
        stmt as TSInterfaceDeclaration,
        analysis.structs,
        analysis,
      );
      // A behavioral interface (series 071) lowers to no struct (trait only).
      if (lowered) items.push(lowered);
    } else if (stmt.type === "TSEnumDeclaration") {
      items.push(lowerEnum(stmt as TSEnumDeclaration));
    } else if (stmt.type === "TSTypeAliasDeclaration") {
      // A `type X = …` alias emits no statement — its union enum (if any) was
      // synthesized by `collectUnions` and is pushed with the items below.
    } else if (stmt.type === "ClassDeclaration") {
      // A `class X extends Error` is a custom error type — its shape was
      // collected into the synthesized enum above, so nothing is emitted per
      // class here. A plain data class becomes a `struct` + `impl`.
      if (!isErrorSubclass(stmt)) {
        items.push(lowerClass(stmt as ClassDeclaration, analysis));
      }
    } else if (
      stmt.type === "VariableDeclaration" &&
      lazyInfo.has(
        ((stmt as VariableDeclaration).declarations[0]?.id as { name?: string })
          ?.name ?? "",
      )
    ) {
      // A synthesized value `export default` (#70) → a module-level `LazyLock`
      // static. Its payload type was inferred in the pre-pass; lower the value.
      const dcl = (stmt as VariableDeclaration).declarations[0]!;
      const name = (dcl.id as Identifier).name;
      const info = lazyInfo.get(name)!;
      items.push({
        kind: "lazyStatic",
        name,
        ty: info.ty,
        rc: info.rc,
        init: lowerTyped(info.init, null, analysis),
      });
    } else {
      script.push(stmt);
    }
  }

  let main: HirStmt[] = [];
  let mainRet: RustType | undefined;
  let mainAsync: boolean | undefined;
  if (script.length > 0) {
    if (items.some((f) => f.kind === "fn" && f.name === "main")) {
      // No sound single lowering mixes script with a user-defined `main`.
      throw new UnsupportedError({
        type: "top-level statements alongside a user-defined main()",
      });
    }
    main = lowerStatements(
      takeDirectives(script, { panicAllowed: true }),
      analysis,
      SCRIPT_SCOPE,
    );
    // A script that propagates a throwing call (or throws) makes `main` fallible:
    // `fn main() -> Result<(), String>`, returns wrapped in `Ok`, trailing `Ok(())`.
    if (analysis.fallible.has(SCRIPT_SCOPE)) {
      main = makeFallible(main, UNIT);
      mainRet = resultType(UNIT, programErrType(analysis));
    }
    // A script that `await`s needs an async runtime entry: `#[tokio::main] async
    // fn main()` (composes with `mainRet` if the script also throws).
    if (hirHasAwait(main)) mainAsync = true;
  }

  // Callback lifting (series 048) collected the synthesized `__cb_*` fns during
  // lowering (of both the item bodies above and the script `main`); append them
  // as top-level items now, *before* the refine chain, so the passes below type
  // and refine them like any other fn.
  items.push(...analysis.liftedFns);
  // Union-type enums (series 093) — one `HirUnionEnum` per registered union.
  items.push(...analysis.unionEnums.values());
  // Object-literal interface synthesis (series 071 increment 2): the per-literal
  // `struct <Interface>__litN` + its `impl I<Interface>` synthesized when an
  // object literal was typed as a behavioral interface during lowering.
  items.push(...analysis.litStructs);
  // Anonymous object-rest structs (series 097): one `HirStruct` per distinct
  // remaining-field shape (`__anonymous_struct_<hash>`), synthesized when a
  // `const { x, ...rest } = obj` was lowered.
  items.push(...analysis.restStructs.values());

  // Class inheritance (series 053b/c): synthesize the shared `trait IA` for each
  // extended base and rewire each participating class's `impl IA` (overrides +
  // forwarders + on-demand accessors). Runs after all bodies are lowered so
  // `analysis.dynFieldReads` (populated by polymorphic field reads) is complete.
  items.push(...synthesizeTraits(items, analysis));
  // Interface inheritance (series 059): synthesize a by-value getter trait for each
  // extended base interface and give the base + every derived interface struct an
  // `impl I<Base>`. Preserves TS subtype polymorphism (pass a `B` where an `A` is
  // expected, via `&impl IA`).
  items.push(...synthesizeInterfaceTraits(items, analysis));

  // f64-bearing struct keys (series 074): synthesize a SameValueZero key newtype
  // `<Struct>Key(<Struct>)` per distinct f64-bearing key struct, and retarget every
  // remaining `Map`/`Set` key/element type on the items (struct fields, fn
  // params/returns) to the newtype — the `mapNew`/`setNew` construction nodes and
  // `bindingTypes` were already retargeted above.
  if (analysis.structKeyStructs.size > 0) {
    for (const name of analysis.structKeyStructs) {
      items.push(synthesizeStructKey(name, analysis.structFields));
    }
    for (const item of items) retargetItemTypes(item, analysis.structKeyStructs);
  }

  // Final gate steps: refine `number` → `usize` where indexing demands it, then
  // read-only `string` params (`&String`) → the idiomatic `&str`, then the
  // ownership-model directives — `"use rc"` scopes → `Rc<RefCell<T>>` (028b) and
  // `"use arena"` scopes → `bumpalo` bump allocation (028c) — and *finally*
  // use-after-move → `.clone()`. Ownership runs **last** so it sees the HIR after
  // the directives have imposed their own ownership model: an `rc` alias is already
  // `Rc::clone` (not a bare move) and an arena `Vec` is already un-annotated, so the
  // clone pass leaves both alone and only fills the remaining plain-move gaps (037).
  // The task-escape pass (series 051c increment 2) runs **before**
  // `refineOwnership`: it rewrites shared spawn-arg captures to `Arc::clone`
  // handles and the parent's later uses to `.lock().unwrap()`, so by the time the
  // clone-inserting ownership pass runs, those sites are `arcClone`/`lockAccess`
  // nodes (not bare movable idents) and it leaves them alone — no spurious
  // `.clone()`. It runs *after* lowering has baked each callee param's `refMut`
  // ownership signal into its `HirParam.ty` (the `Arc` vs `Arc<Mutex>` input), and
  // after the numeric/string/rc/arena refinements so the wrapped inner types are
  // final.
  const module: HirModule = { items, main, mainRet, mainAsync };
  // Both-present divergence warning (series 066, design C): a union carrying *both*
  // `null` and `undefined` collapses to one `Option::None`, but print / `===` /
  // coercion semantics diverge from JS there. Non-fatal — recorded on the 056-style
  // `warnings` channel, not fail-loud. A single-spelling union warns nothing.
  {
    const w = collectBothPresentWarnings(normalized);
    if (w.length > 0) module.warnings = [...(module.warnings ?? []), ...w];
  }
  // Series 062/069: escaping shared-mutable aliasing auto-promotes to `Rc<RefCell<T>>`
  // (surgical, per-binding), decoupled from the `"use rc"` directive. Series 068
  // (issue #35) folds one more edge into the same pass: a consuming (`fn m(self)`)
  // call whose receiver is live afterward force-promotes that receiver — so
  // `computeAutoRc` also finalizes which candidate methods emit consuming.
  const autoRc = computeAutoRc(
    module,
    analysis.classes,
    analysis.mutatingMethods,
    analysis.consumingCandidates,
  );
  // Retag the finalized consuming methods with an owned receiver (`fn m(self)`)
  // *before* `refineOwnership` — its `selfParams` then types `self` as the owned
  // struct, so the `return self.field` move-out drops the 038 clone. Runs after
  // `computeAutoRc` (which decides consuming vs demoted).
  applyOwnedSelf(module, autoRc.consumingMethods);
  // `refineIterFusion` (series 104) runs **last** — on the fully-refined module, so it
  // sees final adapter/element-mode shapes and settled ownership before fusing single-
  // use map/filter/reduce chains. `refineSplitLazy` (series 107, #88/2c) wraps it,
  // rewriting a non-retaining `split` consumer to stream `str::split` (no `Vec`) on the
  // fully-settled `forIn` shapes.
  const result = refineSplitLazy(
    refineIterFusion(
    fixKeyBorrows(
      fixStringScrutinees(
        refineOwnership(
          refineTaskEscape(
            refineArena(
              refineRc(
                refineStrAppend(
                  refineStrings(refineNumerics(refineBitwise(module))),
                ),
                {
                  rcScopes: analysis.rcScopes,
                  autoRc,
                  classes: analysis.classes,
                  mutatingMethods: analysis.mutatingMethods,
                },
              ),
              analysis.arenaScopes,
            ),
          ),
        ),
      ),
    ),
    ),
  );
  // Namespaces (series 050d, Axis 4): lower each extracted block **recursively**
  // to an inline `mod` — its members run the full pipeline on their own, and an
  // `export`ed member is `pub` so a `Foo.bar()` (routed to `Foo::bar()` above)
  // resolves. Reopened blocks were already coalesced by `extractNamespaces`. The
  // path-root set is threaded through so a namespace member can reference another
  // namespace (`Bar.x`). A namespace body carries only declarations (no top-level
  // statements — enforced in extraction), so its `main` is always empty.
  if (nsExtract.namespaces.length > 0) {
    const nsMods: HirMod[] = [];
    for (const ns of nsExtract.namespaces) {
      const lowered = lower(
        { type: "Program", body: ns.members, start: 0, end: 0 },
        undefined,
        pathRoots,
      );
      for (const item of lowered.items) {
        const nm = (item as { name?: string }).name;
        if (nm && ns.exported.has(nm)) (item as { vis?: Vis }).vis = "pub";
      }
      nsMods.push({
        kind: "mod",
        name: ns.name,
        modPath: [ns.name],
        uses: lowered.uses ?? [],
        items: lowered.items,
        inline: true,
      });
    }
    result.mods = [...(result.mods ?? []), ...nsMods];
  }
  return result;
}

/**
 * The reserved Rust symbol a TS `export default` maps to (series 050, Axis 4,
 * re-decided 2026-07-17). A `default` export is nameless in TS; on the Rust side
 * it becomes an ordinary **named** item `__default_export` (anonymous fn/class) or
 * a `pub(crate) use self::<name> as __default_export;` alias (named fn/class), and
 * a default import binds it via `use crate::<mod>::__default_export as <local>;`.
 */
const DEFAULT_EXPORT_SYM = "__default_export";

/** A short deterministic FNV-1a hash (base-36) — used to give each module's value
 *  default a unique item name (#70), aliased back to `__default_export`. */
function shortHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * What a crate's value-`export default`s (#70) need threaded from `lowerCrate` into
 * `lower`: the synthesized lazy-static item names to build, the consumer import
 * locals that bind them (→ deref + typed binding), and each module's default sym.
 */
export interface CrateDefaults {
  /** Synthesized `const <sym> = <value>` names that become `HirLazyStatic` items. */
  lazyNames: Set<string>;
  /** A default-import local name → the `modKey` whose value default it binds. */
  importLocals: Map<string, string>;
  /** `modKey` → its value default's synthesized sym (for the item's inferred type). */
  symByMod: Map<string, string>;
}

/** The exported / crate-root name of a top-level declaration (series 050). */
function crateDeclName(stmt: Statement): string | undefined {
  const t = stmt.type;
  if (
    t === "FunctionDeclaration" ||
    t === "ClassDeclaration" ||
    t === "TSInterfaceDeclaration" ||
    t === "TSEnumDeclaration" ||
    t === "TSTypeAliasDeclaration" ||
    t === "TSModuleDeclaration"
  ) {
    return (stmt as { id?: { name?: string } }).id?.name;
  }
  return undefined;
}

/**
 * A `namespace Foo { export … }` block extracted from a program (series 050d,
 * Axis 4) — its name, its member declarations (unwrapped from any `export`), and
 * the set of member names that were `export`ed (→ `pub` inside the `mod`). A
 * reopened namespace (declared twice) is coalesced into one block by name.
 */
interface NsBlock {
  name: string;
  members: Statement[];
  exported: Set<string>;
}

/**
 * Pull every top-level `namespace Foo { … }` (`TSModuleDeclaration`) out of a
 * program (series 050d, Axis 4), returning the namespace-free program plus the
 * coalesced blocks. Run **before** `validate` so the whole-tree gate never sees the
 * namespace wrapper or its inner `export`s — each block's members are plain
 * declarations (modeled) that lower recursively into an inline `mod`. A reopened
 * `namespace Foo` merges into one block (Rust `mod` can't reopen). A namespace
 * member that is not a named declaration (a top-level statement, a bare `const`, a
 * re-export) has no `mod`-item analog → fail-loud.
 */
function extractNamespaces(program: Program): {
  program: Program;
  namespaces: NsBlock[];
} {
  const kept: Statement[] = [];
  const byName = new Map<string, NsBlock>();
  const order: string[] = [];
  const blockFor = (name: string): NsBlock => {
    let b = byName.get(name);
    if (!b) {
      b = { name, members: [], exported: new Set() };
      byName.set(name, b);
      order.push(name);
    }
    return b;
  };
  for (const stmt of program.body) {
    if (stmt.type !== "TSModuleDeclaration") {
      kept.push(stmt);
      continue;
    }
    const decl = stmt as unknown as {
      id: { type: string; name: string };
      body?: { type: string; body: Statement[] } | null;
    };
    // A qualified `namespace A.B {}` (nested id) or a `declare`/ambient module has
    // no `TSModuleBlock` body → no sound `mod` mapping.
    if (decl.id.type !== "Identifier" || decl.body?.type !== "TSModuleBlock") {
      throw new UnsupportedError({
        type: "namespace form (only `namespace <Ident> { … }` with a block body is modeled)",
      });
    }
    const block = blockFor(decl.id.name);
    for (const inner of decl.body.body) {
      if (inner.type === "ExportNamedDeclaration") {
        const exp = inner as unknown as {
          declaration: Statement | null;
          source: unknown;
        };
        if (!exp.declaration || exp.source) {
          throw new UnsupportedError({
            type: "namespace member (only `export <decl>` / a bare decl; no re-export or specifier list)",
          });
        }
        const name = crateDeclName(exp.declaration);
        if (!name) {
          throw new UnsupportedError({
            type: `namespace member must be a named declaration (${exp.declaration.type})`,
          });
        }
        block.exported.add(name);
        block.members.push(exp.declaration);
      } else {
        const name = crateDeclName(inner);
        if (!name) {
          throw new UnsupportedError({
            type: `namespace member must be a declaration, not a top-level statement (${inner.type})`,
          });
        }
        block.members.push(inner);
      }
    }
  }
  return {
    program: { ...program, body: kept },
    namespaces: order.map((n) => byName.get(n)!),
  };
}

/**
 * The `mod prelude { pub(crate) use … }` re-export lines (series 050d, Axis 5):
 * every crate-visible (`pub`/`pub(crate)`) item across the library (non-entry,
 * non-facade, non-inline) module files, gathered so each file can `use
 * crate::prelude::*;` and cut `use` noise. Name-routing only → differential-neutral.
 * A name exported by **more than one** module is ambiguous in a single prelude
 * module (E0252), so it is dropped — those keep their explicit per-file `use`. The
 * re-export is `pub(crate) use` (not `pub use`): the items are `pub(crate)`, and
 * Rust forbids `pub use` re-exporting one beyond the crate (E0364).
 */
function buildPrelude(mods: HirMod[]): string[] {
  const byName = new Map<string, string[] | null>();
  for (const m of mods) {
    if (m.facade || m.inline) continue;
    for (const it of m.items) {
      const name = (it as { name?: string }).name;
      const vis = (it as { vis?: string }).vis;
      if (!name || (vis !== "pub" && vis !== "pub(crate)")) continue;
      byName.set(name, byName.has(name) ? null : m.modPath);
    }
  }
  const lines: string[] = [];
  for (const [name, modPath] of byName) {
    if (modPath) lines.push(`pub(crate) use ${["crate", ...modPath].join("::")}::${name};`);
  }
  return lines;
}

/**
 * A **pure barrel** (series 050d, Axis 3): a non-entry module whose body is *only*
 * `./`-relative re-exports (`export { x } from "./y"` / `export * from "./y"`), no
 * runtime logic or own declarations. It translates to a generated `pub use` facade
 * module (differential-neutral name routing). A **mixed** file (a re-export plus
 * any other statement) is NOT a pure barrel → it stays fail-loud.
 */
function isPureBarrel(program: Program): boolean {
  if (program.body.length === 0) return false;
  return program.body.every((stmt) => {
    const s = stmt as { type: string; source?: { value?: unknown } | null };
    return (
      (s.type === "ExportNamedDeclaration" ||
        s.type === "ExportAllDeclaration") &&
      !!s.source &&
      typeof s.source.value === "string"
    );
  });
}

/**
 * The `pub use crate::<target>::…;` facade line(s) for one re-export statement in a
 * pure barrel. `export { a, b as c } from "./y"` → `pub use crate::y::a;` +
 * `pub use crate::y::b as c;`; `export * from "./y"` → `pub use crate::y::*;`.
 */
function facadeUseLines(
  stmt: Statement,
  targetMod: string[],
): string[] {
  // `pub(crate) use` (not `pub use`): the re-exported items are `pub(crate)` (the
  // crate's visibility granularity), and Rust forbids `pub use` re-exporting a
  // `pub(crate)` item beyond the crate (E0364). The facade routes names crate-wide.
  const path = ["crate", ...targetMod].join("::");
  if (stmt.type === "ExportAllDeclaration") return [`pub(crate) use ${path}::*;`];
  const exp = stmt as unknown as {
    specifiers: { local: { name: string }; exported: { name: string } }[];
  };
  return exp.specifiers.map((sp) =>
    sp.local.name === sp.exported.name
      ? `pub(crate) use ${path}::${sp.local.name};`
      : `pub(crate) use ${path}::${sp.local.name} as ${sp.exported.name};`,
  );
}

/** `use crate::<modPath>::<imported>[ as <local>];` for an import specifier. */
function crateUseLine(
  modPath: string[],
  imported: string,
  local: string,
): string {
  const path = ["crate", ...modPath].join("::");
  return imported === local
    ? `use ${path}::${imported};`
    : `use ${path}::${imported} as ${local};`;
}

/**
 * Collect the **nominal** names a `RustType` (transitively) references — a struct /
 * key-newtype `name` and a trait-object / `impl Trait` `trait`. A generic deep-walk
 * (every HIR node is a `kind`-tagged plain object), so it stays total as `RustType`
 * grows; a scalar (`f64`, `String`, …) contributes nothing.
 */
function nominalNamesOf(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) nominalNamesOf(n, out);
    return;
  }
  if (node !== null && typeof node === "object") {
    const k = (node as { kind?: string }).kind;
    const name = (node as { name?: unknown }).name;
    const trait = (node as { trait?: unknown }).trait;
    if ((k === "struct" || k === "structKey") && typeof name === "string") {
      out.add(name);
    }
    if ((k === "dyn" || k === "implTrait") && typeof trait === "string") {
      out.add(trait);
    }
    for (const v of Object.values(node)) nominalNamesOf(v, out);
  }
}

/** The nominal names appearing in an item's **signature** (not its body). */
function signatureRefs(item: HirItem): Set<string> {
  const out = new Set<string>();
  const fromFn = (fn: HirFn): void => {
    for (const p of fn.params) nominalNamesOf(p.ty, out);
    nominalNamesOf(fn.ret, out);
  };
  switch (item.kind) {
    case "fn":
      fromFn(item);
      break;
    case "struct":
      for (const f of item.fields) nominalNamesOf(f.ty, out);
      break;
    case "structKey":
      out.add(item.struct);
      break;
    case "class":
      for (const f of item.fields) nominalNamesOf(f.ty, out);
      if (item.ctor) fromFn(item.ctor);
      for (const m of item.methods) fromFn(m);
      if (item.base) nominalNamesOf(item.base.ty, out);
      break;
    case "unionEnum":
      for (const v of item.variants) {
        for (const f of v.fields) nominalNamesOf(f.ty, out);
        if (v.newtype) nominalNamesOf(v.newtype, out);
      }
      break;
    case "trait":
      for (const m of item.methods) fromFn(m);
      for (const a of item.accessors) nominalNamesOf(a.ty, out);
      for (const a of item.byValueAccessors ?? []) nominalNamesOf(a.ty, out);
      break;
    case "generator":
      nominalNamesOf(item.item, out);
      nominalNamesOf(item.retTy, out);
      for (const p of item.params) nominalNamesOf(p.ty, out);
      for (const f of item.localFields) nominalNamesOf(f.ty, out);
      break;
    case "lazyStatic":
      // A value default's payload type (#70) — keep a referenced struct reachable.
      nominalNamesOf(item.ty, out);
      break;
    // `enum` (C-like, unit variants) and `errorEnum` (synthesized, crate-root)
    // reference no other nominal type.
    default:
      break;
  }
  return out;
}

/**
 * Infer crate visibility (series 050, Axis 1) — `pub(crate)` granularity. Every
 * item named in an `export` is `pub(crate)`; so is any item **reachable from an
 * exported signature** (an exported fn's param/return type, an exported struct's
 * field type, transitively) — Rust forbids a private type in a `pub(crate)`
 * signature (`private_interfaces`), so the closure must widen them. A purely local
 * item (neither exported nor signature-reachable) stays private. Mutates each
 * reached item's `vis` (and a reached struct/class's fields + ctor/methods, so a
 * cross-module literal / call reaches them).
 */
function inferCrateVisibility(items: HirItem[], exported: Set<string>): void {
  const byName = new Map<string, HirItem>();
  for (const it of items) {
    const n = (it as { name?: string }).name;
    if (n && !byName.has(n)) byName.set(n, it);
  }
  // BFS the signature-reachability closure from the exported seed.
  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const n of exported) {
    if (byName.has(n)) {
      reachable.add(n);
      queue.push(n);
    }
  }
  while (queue.length > 0) {
    const item = byName.get(queue.shift()!)!;
    for (const ref of signatureRefs(item)) {
      if (byName.has(ref) && !reachable.has(ref)) {
        reachable.add(ref);
        queue.push(ref);
      }
    }
  }
  // Widen every reached item (and its members) to `pub(crate)`.
  for (const name of reachable) {
    const item = byName.get(name)!;
    (item as { vis?: Vis }).vis = "pub(crate)";
    if (item.kind === "struct" || item.kind === "class") {
      for (const f of item.fields) f.vis = "pub(crate)";
    }
    if (item.kind === "class") {
      if (item.ctor) item.ctor.vis = "pub(crate)";
      for (const m of item.methods) m.vis = "pub(crate)";
    }
  }
}

/**
 * Lower a resolved multi-file **crate** (series 050) to a single `HirModule` whose
 * non-entry files are carried in `mods`.
 *
 * The whole crate compiles as **one unit**, so instead of running (and merging)
 * analysis per file, we splice every module's declarations into one synthetic
 * `Program` and lower it through {@link lower} — every cross-module function,
 * struct, class, and enum reference then resolves by construction (`analysis.fns`,
 * `structs`, `methodNames` are all global). We only strip the module *plumbing*
 * first: `./`-relative imports become each file's `use crate::…;` prelude, `export`
 * marks a name's visibility, and each declaration is remembered against its owning
 * module. After lowering, the flat item list is **partitioned back** to its files
 * by declaration name; synthesized items (the `AppError` enum, lifted callbacks,
 * anonymous unions) have no owner and stay at the crate root. Only the entry file
 * may carry top-level statements (→ `fn main`); a statement in an imported module
 * is fail-loud (import-time side effects have no sound Rust analog). The `@ttr/std`
 * shim import is kept in the merged program (it is recognized by lowering, not a
 * module edge).
 */
/**
 * Add `delta` to every `start`/`end` in an oxc AST subtree (#68) — used to shift a
 * crate module's spans into its disjoint offset window so a merged node routes back
 * to its file in the crate oracle. A `WeakSet` guards against any shared/cyclic
 * reference; `delta === 0` (the entry module) short-circuits.
 */
function shiftSpans(node: unknown, delta: number, seen?: WeakSet<object>): void {
  if (delta === 0 || node === null || typeof node !== "object") return;
  const visited = seen ?? new WeakSet<object>();
  if (visited.has(node)) return;
  visited.add(node);
  if (Array.isArray(node)) {
    for (const el of node) shiftSpans(el, delta, visited);
    return;
  }
  const rec = node as Record<string, unknown>;
  if (typeof rec.start === "number" && typeof rec.end === "number") {
    rec.start += delta;
    rec.end += delta;
  }
  for (const k in rec) {
    if (k === "start" || k === "end") continue;
    const v = rec[k];
    if (v !== null && typeof v === "object") shiftSpans(v, delta, visited);
  }
}

export function lowerCrate(modules: SourceModule[]): HirModule {
  const entry = modules.find((m) => m.isEntry);
  if (!entry) throw new UnsupportedError({ type: "crate has no entry module" });

  // Give each module a disjoint offset window and shift its AST spans into it (#68),
  // so a merged node's *global* span routes back to its owning file + file-local
  // span in the crate oracle. tsc parses each file's ORIGINAL source, so the windows
  // only touch the merged oxc AST — never the oracle's SourceFiles. The entry gets
  // base 0 (a no-op shift), keeping its nodes at their source offsets.
  const crateOracleFiles: OracleFile[] = [];
  let spanBase = 0;
  for (const m of modules) {
    shiftSpans(m.program, spanBase);
    crateOracleFiles.push({ key: m.key, source: m.source, base: spanBase });
    spanBase += m.source.length + 1;
  }

  const mergedBody: Statement[] = [];
  /** Declaration name → owning module's `modPath` (`[]` = crate root/entry). */
  const nameToModPath = new Map<string, string[]>();
  /** Names carried in some module's `export` set → widened to `pub(crate)`. */
  const exportedNames = new Set<string>();
  /** modPath.join("/") → the module's `use crate::…;` prelude lines. */
  const usesByMod = new Map<string, string[]>();
  const modKeyOf = (m: SourceModule): string => m.modPath.join("/");
  const usesFor = (key: string): string[] => {
    const cur = usesByMod.get(key);
    if (cur) return cur;
    const fresh: string[] = [];
    usesByMod.set(key, fresh);
    return fresh;
  };

  /** modPath keys of pure-barrel modules → emitted as `pub use` facades. */
  const facadeKeys = new Set<string>();

  /** `import * as ns` alias names (050d) → seed the merged lowering's path roots. */
  const crateNamespaces = new Set<string>();

  // ── Re-export lineage (#71) ───────────────────────────────────────────────
  // A **mixed** file (own logic + `export { x } from "./y"`) is no longer fail-loud.
  // Record each named re-export edge (`modKey → exportedName → real source`) so a
  // consumer importing a re-exported name routes to the module that actually
  // *defines* it, bypassing the re-exporter (which emits only its own decls). The
  // chain is followed through mixed intermediaries; `export * from` in a mixed file
  // stays fail-loud (glob is ambiguous — handled in the merge loop below).
  const reexportEdges = new Map<
    string,
    Map<string, { targetMod: string[]; sourceName: string }>
  >();
  for (const m of modules) {
    if (m.isEntry || isPureBarrel(m.program)) continue;
    for (const stmt of m.program.body) {
      const s = stmt as unknown as {
        type: string;
        source: { value: string } | null;
        specifiers?: { local: { name: string }; exported: { name: string } }[];
      };
      if (s.type !== "ExportNamedDeclaration" || !s.source || !s.specifiers) {
        continue;
      }
      const targetMod = m.resolved.get(s.source.value);
      if (!targetMod) {
        throw new UnsupportedError({
          type: `unresolved re-export '${s.source.value}'`,
        });
      }
      const key = modKeyOf(m);
      const edges =
        reexportEdges.get(key) ??
        reexportEdges.set(key, new Map()).get(key)!;
      for (const sp of s.specifiers) {
        edges.set(sp.exported.name, { targetMod, sourceName: sp.local.name });
      }
    }
  }
  /** Chase a re-export chain to the module that actually defines `name`, bypassing
   *  mixed intermediaries (#71). A cycle in the chain is fail-loud. */
  const resolveReexport = (
    modPath: string[],
    name: string,
  ): { modPath: string[]; name: string } => {
    let mod = modPath;
    let nm = name;
    const seen = new Set<string>();
    for (;;) {
      const step = `${mod.join("/")}::${nm}`;
      if (seen.has(step)) {
        throw new UnsupportedError({
          type: `re-export cycle resolving '${name}'`,
        });
      }
      seen.add(step);
      const edge = reexportEdges.get(mod.join("/"))?.get(nm);
      if (!edge) return { modPath: mod, name: nm };
      mod = edge.targetMod;
      nm = edge.sourceName;
    }
  };

  // ── Value `export default` pre-pass (#70) ─────────────────────────────────
  // A default whose declaration is neither a fn/class nor an arrow (a literal,
  // array, object, call, …) has no item analog → it becomes a module-level
  // `LazyLock` static. Detect them up front (a consumer may import one before its
  // defining module is merged) so a default-import can bind + deref it.
  const crateDefaults: CrateDefaults = {
    lazyNames: new Set(),
    importLocals: new Map(),
    symByMod: new Map(),
  };
  const valueDefaultSym = (m: SourceModule): string =>
    `${DEFAULT_EXPORT_SYM}_${shortHash(modKeyOf(m) || "root")}`;
  for (const m of modules) {
    for (const stmt of m.program.body) {
      if (stmt.type !== "ExportDefaultDeclaration") continue;
      const d = (stmt as unknown as { declaration: { type: string } })
        .declaration;
      if (
        d.type === "FunctionDeclaration" ||
        d.type === "ClassDeclaration" ||
        d.type === "ArrowFunctionExpression"
      ) {
        continue;
      }
      crateDefaults.symByMod.set(modKeyOf(m), valueDefaultSym(m));
    }
  }

  for (const m of modules) {
    const uses = usesFor(modKeyOf(m));
    // A pure barrel (Axis 3) → a generated `pub use` facade module; it declares no
    // items of its own, so it never contributes to the merged program.
    if (!m.isEntry && isPureBarrel(m.program)) {
      facadeKeys.add(modKeyOf(m));
      for (const stmt of m.program.body) {
        const src = (stmt as unknown as { source: { value: string } }).source
          .value;
        const targetMod = m.resolved.get(src);
        if (!targetMod) {
          throw new UnsupportedError({ type: `unresolved re-export '${src}'` });
        }
        uses.push(...facadeUseLines(stmt, targetMod));
      }
      continue;
    }
    for (const stmt of m.program.body) {
      const t = stmt.type;
      if (t === "ImportDeclaration") {
        const imp = stmt as unknown as {
          source: { value: string };
          specifiers: { type: string; imported?: { name: string }; local: { name: string } }[];
        };
        // The `@ttr/std` shim is not a module edge — keep it for lowering to see.
        if (imp.source.value === "@ttr/std") {
          mergedBody.push(stmt);
          continue;
        }
        const targetMod = m.resolved.get(imp.source.value);
        if (!targetMod) {
          throw new UnsupportedError({
            type: `unresolved import '${imp.source.value}'`,
          });
        }
        for (const spec of imp.specifiers) {
          if (spec.type === "ImportSpecifier" && spec.imported) {
            // Route through re-export lineage (#71): if the imported name is a
            // re-export of the target module, bind directly to the REAL source
            // module (bypassing the mixed re-exporter) and mark the real definition
            // crate-visible so `use crate::<src>::<name>` resolves.
            const real = resolveReexport(targetMod, spec.imported.name);
            exportedNames.add(real.name);
            uses.push(crateUseLine(real.modPath, real.name, spec.local.name));
          } else if (spec.type === "ImportDefaultSpecifier") {
            // Default import → the reserved `__default_export` symbol, bound to the
            // local name via `as` (Axis 4, re-decided 2026-07-17).
            uses.push(
              crateUseLine(targetMod, DEFAULT_EXPORT_SYM, spec.local.name),
            );
            // A default that is a VALUE (#70) binds a `LazyLock` — record the local
            // so `lower` types it + derefs its uses.
            if (crateDefaults.symByMod.has(targetMod.join("/"))) {
              crateDefaults.importLocals.set(
                spec.local.name,
                targetMod.join("/"),
              );
            }
          } else if (spec.type === "ImportNamespaceSpecifier") {
            // Namespace import → a Rust **module alias** (Axis 4, re-decided
            // 2026-07-17): `import * as ns from "./n"` → `use crate::n as ns;`, and
            // `ns.f()` routes to the path `ns::f()` (registered below). TS `import *`
            // is *qualified* access (not an unqualified glob), so there is no capture.
            uses.push(`use ${["crate", ...targetMod].join("::")} as ${spec.local.name};`);
            crateNamespaces.add(spec.local.name);
          } else {
            throw new UnsupportedError({
              type: `unsupported import specifier (${spec.type})`,
            });
          }
        }
        continue;
      }
      if (t === "ExportNamedDeclaration") {
        const exp = stmt as unknown as {
          declaration: Statement | null;
          specifiers: { local: { name: string }; exported: { name: string } }[];
          source: { value: string } | null;
        };
        if (exp.source) {
          // A named re-export (`export { x } from "./y"`) in a mixed file (#71) —
          // its lineage was recorded in the pre-pass; consumers route to the real
          // source, so the re-exporter itself emits nothing for it here.
          continue;
        }
        if (exp.declaration) {
          const name = crateDeclName(exp.declaration);
          if (!name) {
            throw new UnsupportedError({
              type: `unsupported \`export\` form (${exp.declaration.type})`,
            });
          }
          nameToModPath.set(name, m.modPath);
          exportedNames.add(name);
          mergedBody.push(exp.declaration);
        } else {
          // `export { a, b as c }` — mark each local exported. A rename with no
          // declaration emits a `pub use self::… as …;` alias (series 050d); the
          // plain case just widens visibility.
          for (const spec of exp.specifiers) {
            exportedNames.add(spec.local.name);
          }
        }
        continue;
      }
      if (t === "ExportDefaultDeclaration") {
        const d = (stmt as unknown as { declaration: Statement }).declaration;
        if (
          d.type === "FunctionDeclaration" ||
          d.type === "ClassDeclaration"
        ) {
          // A fn/class default → a named Rust item (Axis 4, re-decided 2026-07-17).
          const decl = d as unknown as {
            id: { type: string; name: string; start: number; end: number } | null;
          };
          if (decl.id?.name) {
            // Named: keep its own name, alias it as the reserved default symbol.
            nameToModPath.set(decl.id.name, m.modPath);
            exportedNames.add(decl.id.name);
            mergedBody.push(d);
            uses.push(
              `pub(crate) use self::${decl.id.name} as ${DEFAULT_EXPORT_SYM};`,
            );
          } else {
            // Anonymous: name the item the reserved symbol directly.
            decl.id = {
              type: "Identifier",
              name: DEFAULT_EXPORT_SYM,
              start: 0,
              end: 0,
            };
            nameToModPath.set(DEFAULT_EXPORT_SYM, m.modPath);
            exportedNames.add(DEFAULT_EXPORT_SYM);
            mergedBody.push(d);
          }
          continue;
        }
        // A non-fn/class default (#70). Synthesize `const <sym> = <value>` and
        // alias `<sym>` as the reserved default symbol. An **arrow** → a fn (via
        // `normalizeArrows`); any other **value** → a module-level `LazyLock` static
        // (built in `lower`, its type inferred by the crate oracle).
        const span = d as unknown as { start: number; end: number };
        const sym = valueDefaultSym(m);
        const synthConst = {
          type: "VariableDeclaration",
          kind: "const",
          start: span.start,
          end: span.end,
          declarations: [
            {
              type: "VariableDeclarator",
              start: span.start,
              end: span.end,
              id: { type: "Identifier", name: sym, start: 0, end: 0 },
              init: d,
            },
          ],
        } as unknown as Statement;
        nameToModPath.set(sym, m.modPath);
        exportedNames.add(sym);
        uses.push(`pub(crate) use self::${sym} as ${DEFAULT_EXPORT_SYM};`);
        if (d.type !== "ArrowFunctionExpression") {
          // A value → a lazy static (an arrow flows through as a fn instead).
          crateDefaults.lazyNames.add(sym);
        }
        mergedBody.push(synthConst);
        continue;
      }
      if (t === "ExportAllDeclaration") {
        throw new UnsupportedError({
          type: "re-export outside a pure barrel (a mixed logic + re-export file is ambiguous)",
        });
      }
      // A plain declaration or a top-level statement.
      const name = crateDeclName(stmt);
      if (name) {
        nameToModPath.set(name, m.modPath);
        mergedBody.push(stmt);
      } else if (m.isEntry) {
        // Entry-only: a top-level statement (→ `fn main`) or a script `const`.
        mergedBody.push(stmt);
      } else {
        throw new UnsupportedError({
          type: "top-level statement in an imported module (declarations only)",
        });
      }
    }
  }

  // Lower the whole crate as one unit — every cross-module name resolves here.
  const merged: Program = {
    type: "Program",
    body: mergedBody,
    start: 0,
    end: 0,
  };
  const lowered = lower(
    merged,
    undefined,
    crateNamespaces,
    crateOracleFiles,
    crateDefaults,
  );

  // Infer visibility across the whole crate (Axis 1): exported names + everything
  // signature-reachable from them → `pub(crate)`; purely local items stay private.
  inferCrateVisibility(lowered.items, exportedNames);

  // Partition the flat items back to their owning module files. Un-owned
  // (synthesized) items stay at the root.
  const rootItems: HirItem[] = [];
  const itemsByMod = new Map<string, HirItem[]>();
  for (const item of lowered.items) {
    const name = (item as { name?: string }).name;
    const owner = name ? nameToModPath.get(name) : undefined;
    if (!owner || owner.length === 0) {
      rootItems.push(item);
      continue;
    }
    const key = owner.join("/");
    const bucket = itemsByMod.get(key);
    if (bucket) bucket.push(item);
    else itemsByMod.set(key, [item]);
  }

  const mods: HirMod[] = [];
  for (const m of modules) {
    if (m.isEntry) continue;
    const key = modKeyOf(m);
    mods.push({
      kind: "mod",
      name: m.modPath[m.modPath.length - 1] ?? key,
      modPath: m.modPath,
      uses: usesByMod.get(key) ?? [],
      items: itemsByMod.get(key) ?? [],
      facade: facadeKeys.has(key) || undefined,
    });
  }
  // Inline `namespace` mods (series 050d, Axis 4) surfaced by the merged lowering
  // are carried through at crate-root scope (a namespace declared in any crate file
  // routes as `Foo::bar` crate-wide). They render within the root file, not as
  // their own source file.
  if (lowered.mods) mods.push(...lowered.mods);

  // Prelude generation (series 050d, Axis 5): gather the library modules' crate-
  // visible items into an inline `mod prelude { pub(crate) use … }` and glob it
  // into each library module file (`use crate::prelude::*;`), cutting `use` noise.
  // A local definition shadows the same-named glob (glob is lower priority), so the
  // re-import is harmless; the prelude drops cross-module name collisions. Emitted
  // only when there is something to gather.
  const preludeLines = buildPrelude(mods);
  if (preludeLines.length > 0) {
    for (const mm of mods) {
      if (mm.facade || mm.inline) continue;
      mm.uses = ["use crate::prelude::*;", ...mm.uses];
    }
    mods.push({
      kind: "mod",
      name: "prelude",
      modPath: ["prelude"],
      uses: preludeLines,
      items: [],
      inline: true,
    });
  }

  return {
    ...lowered,
    items: rootItems,
    mods,
    uses: usesByMod.get("") ?? [],
  };
}

/**
 * `&str`-key borrow fix (series 083). A `Map`/`Set` lookup wraps its key with
 * `refExpr(..)`, so a **`string` param** key (`refineStrings` made it `&str`)
 * becomes `m.get(&k)` → `&(&str)` = `&&str`, which `IndexMap::get` (`&Q where
 * String: Borrow<Q>`) rejects (E0277: `String: Borrow<&str>` doesn't hold). Runs
 * **after** `refineStrings` so param types are final: for `.get`/`.contains_key`/
 * `.contains`/`.shift_remove` whose single arg is `&<ident>` and `<ident>` is a
 * `&str`/`str` param, drop the borrow → bare `k` (relies on `String: Borrow<str>`,
 * no allocation). An owned `String`/literal/`OrderedFloat`/`structKey` key keeps
 * its `&`-wrapped path exactly.
 */
function fixKeyBorrows(module: HirModule): HirModule {
  const LOOKUP = new Set(["get", "contains_key", "contains", "shift_remove"]);
  const doBody = (params: HirParam[], stmts: HirStmt[]): void => {
    const strRefParams = new Set<string>();
    for (const p of params) {
      if (
        p.ty.kind === "str" ||
        (p.ty.kind === "ref" && p.ty.inner.kind === "str")
      ) {
        strRefParams.add(p.name);
      }
    }
    walkKeyBorrows(stmts as unknown, strRefParams, LOOKUP);
  };
  for (const item of module.items) {
    if (item.kind === "fn") doBody(item.params, item.body);
    else if (item.kind === "class") {
      if (item.ctor) doBody(item.ctor.params, item.ctor.body);
      for (const m of item.methods) doBody(m.params, m.body);
    }
  }
  doBody([], module.main);
  return module;
}

/** Recursively unborrow `<lookup>(&k)` → `<lookup>(k)` for a `&str` param `k`. */
function walkKeyBorrows(
  node: unknown,
  strRefParams: Set<string>,
  lookup: Set<string>,
): void {
  if (!node || typeof node !== "object") return;
  const n = node as { kind?: string; name?: string; args?: HirExpr[] };
  if (
    n.kind === "method" &&
    typeof n.name === "string" &&
    lookup.has(n.name) &&
    Array.isArray(n.args) &&
    n.args.length === 1
  ) {
    const arg = n.args[0] as
      | { kind?: string; mut?: boolean; expr?: HirExpr }
      | undefined;
    if (
      arg &&
      arg.kind === "ref" &&
      arg.mut === false &&
      arg.expr &&
      (arg.expr as { kind?: string }).kind === "ident" &&
      strRefParams.has((arg.expr as { name: string }).name)
    ) {
      n.args[0] = arg.expr;
    }
  }
  for (const v of Object.values(node as Record<string, unknown>)) {
    if (Array.isArray(v)) for (const c of v) walkKeyBorrows(c, strRefParams, lookup);
    else if (v && typeof v === "object")
      walkKeyBorrows(v, strRefParams, lookup);
  }
}

/**
 * Retag every consuming method (series 068) with an **owned** receiver (`recv:
 * "owned"` → `fn m(self)`). Only a currently-`&self` method is retagged (a
 * `&mut self` method is never a consuming candidate); the change flows to the
 * emitter and to `refineOwnership`'s `selfParams`, which together drop the 038
 * field clone.
 */
function applyOwnedSelf(
  module: HirModule,
  consuming: ReadonlySet<string>,
): void {
  if (consuming.size === 0) return;
  for (const item of module.items) {
    if (item.kind !== "class") continue;
    for (const m of item.methods) {
      if (m.recv === "ref" && consuming.has(m.name)) m.recv = "owned";
    }
  }
}

/**
 * String-scrutinee fixup (series 064). `lowerSwitch` renders a `String`-typed
 * scrutinee as `match <s>.as_str() { "a" => … }`. `.as_str()` is stable on an
 * owned `String`, but *unstable* on a `&str` — and `refineStrings` turns a
 * read-only string *param* into `&str`. So, once param types are final, unwrap
 * `<s>.as_str()` back to a bare `<s>` when `<s>` is a `&str`/`str` parameter (a
 * `&str` matches string-literal patterns directly). Owned-`String` scrutinees keep
 * `.as_str()`. Mutates the module in place.
 */
function fixStringScrutinees(module: HirModule): HirModule {
  const doBody = (params: HirParam[], stmts: HirStmt[]): void => {
    const strRefParams = new Set<string>();
    for (const p of params) {
      if (
        p.ty.kind === "str" ||
        (p.ty.kind === "ref" && p.ty.inner.kind === "str")
      ) {
        strRefParams.add(p.name);
      }
    }
    walkMatchDiscs(stmts, strRefParams);
  };
  for (const item of module.items) {
    if (item.kind === "fn") doBody(item.params, item.body);
    else if (item.kind === "class") {
      if (item.ctor) doBody(item.ctor.params, item.ctor.body);
      for (const m of item.methods) doBody(m.params, m.body);
    }
  }
  doBody([], module.main);
  return module;
}

/** Recursively unwrap `<s>.as_str()` match scrutinees where `s` is a `&str` param. */
function walkMatchDiscs(stmts: HirStmt[], strRefParams: Set<string>): void {
  for (const s of stmts) {
    if (s.kind === "match") {
      const d = s.disc;
      if (
        d.kind === "method" &&
        d.name === "as_str" &&
        d.args.length === 0 &&
        d.receiver.kind === "ident" &&
        strRefParams.has(d.receiver.name)
      ) {
        s.disc = d.receiver;
      }
      for (const arm of s.arms) walkMatchDiscs(arm.body, strRefParams);
    } else if (s.kind === "if") {
      walkMatchDiscs(s.conseq, strRefParams);
      if (s.alt) walkMatchDiscs(s.alt, strRefParams);
    } else if (
      s.kind === "while" ||
      s.kind === "forIn" ||
      s.kind === "forRange" ||
      s.kind === "block"
    ) {
      walkMatchDiscs(s.body, strRefParams);
    } else if (s.kind === "tryCatch") {
      walkMatchDiscs(s.tryBody, strRefParams);
      walkMatchDiscs(s.catchBody, strRefParams);
      if (s.finallyBody) walkMatchDiscs(s.finallyBody, strRefParams);
    }
  }
}

// ── Arrow normalization ──────────────────────────────────────────────────────

/**
 * A captured container's owned TS type annotation, synthesized (series 079) from a
 * declarator so a lifted `__arrow_*` fn can take it as a leading param. Reuses the
 * declaration's own `Array<T>` / `Set<T>` / `Map<K,V>` annotation when present, else
 * synthesizes one from the initializer (`new Set<T>()` / `new Map<K,V>()` / an array
 * literal / a string literal). Returns null when it can't be resolved to a container
 * — the capture then is not a threadable container (→ scalar fail-loud).
 */
function containerAnnotationOf(decl: {
  annotation?: unknown;
  init?: unknown;
}): TSTypeAnnotation | null {
  // A declared annotation for a container type carries straight through as the
  // param annotation (the borrow is inferred from body use, like any param).
  const ann = decl.annotation as { typeAnnotation?: unknown } | undefined;
  const inner = ann?.typeAnnotation as { type?: string; typeName?: { name?: string } } | undefined;
  if (inner?.type === "TSTypeReference") {
    const n = inner.typeName?.name;
    if (n === "Array" || n === "Set" || n === "Map" || n === "ReadonlyArray") {
      return ann as TSTypeAnnotation;
    }
  }
  if (inner?.type === "TSStringKeyword") return ann as TSTypeAnnotation;
  // No usable annotation → synthesize a `TSTypeReference` from the initializer.
  const init = decl.init as
    | { type?: string; callee?: { name?: string }; typeArguments?: unknown; elements?: unknown[]; value?: unknown }
    | undefined;
  if (!init) return null;
  const mkRef = (name: string, typeArguments: unknown): TSTypeAnnotation =>
    ({
      type: "TSTypeAnnotation",
      typeAnnotation: {
        type: "TSTypeReference",
        typeName: { type: "Identifier", name },
        typeArguments,
      },
    }) as unknown as TSTypeAnnotation;
  if (init.type === "NewExpression" && init.callee?.name) {
    const name = init.callee.name;
    if ((name === "Set" || name === "Map") && init.typeArguments) {
      return mkRef(name, init.typeArguments);
    }
    return null; // an un-parameterized `new Set()` can't be typed → fail-loud
  }
  if (init.type === "ArrayExpression") {
    const first = (init.elements ?? [])[0] as { type?: string; value?: unknown } | undefined;
    // Only a numeric array literal can be typed at this pre-analysis stage; a
    // heterogeneous / empty un-annotated array stays fail-loud (no element type).
    if (first?.type === "Literal" && typeof first.value === "number") {
      return mkRef("Array", {
        type: "TSTypeParameterInstantiation",
        params: [{ type: "TSNumberKeyword" }],
      });
    }
    return null;
  }
  if (init.type === "Literal" && typeof init.value === "string") {
    return { type: "TSTypeAnnotation", typeAnnotation: { type: "TSStringKeyword" } } as unknown as TSTypeAnnotation;
  }
  return null;
}

/** Plain-object AST walk (no `isAstNode`, which is defined later) — series 079. */
function astWalk(node: unknown, visit: (n: { type: string; [k: string]: unknown }) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const c of node) astWalk(c, visit);
    return;
  }
  const n = node as { type?: string; [k: string]: unknown };
  if (typeof n.type === "string") visit(n as { type: string; [k: string]: unknown });
  for (const k in n) {
    if (k === "type") continue;
    astWalk(n[k], visit);
  }
}

/**
 * Collect every identifier name bound by a binding pattern (series 079): a plain
 * `Identifier`, an object pattern `{ x, y }` (incl. renames / defaults / rest), an
 * array pattern `[a, b]`, a default `x = …`, or a rest `...xs`. Used to exclude a
 * closure's own params (destructured or not) and its body locals from the free set.
 */
function collectBoundNames(pat: unknown, out: Set<string>): void {
  if (!pat || typeof pat !== "object") return;
  const n = pat as { type?: string; [k: string]: unknown };
  switch (n.type) {
    case "Identifier":
      out.add(n.name as string);
      return;
    case "ObjectPattern":
      for (const prop of (n.properties as unknown[]) ?? []) {
        const p = prop as { type?: string; value?: unknown; argument?: unknown };
        if (p.type === "RestElement") collectBoundNames(p.argument, out);
        else collectBoundNames(p.value, out);
      }
      return;
    case "ArrayPattern":
      for (const el of (n.elements as unknown[]) ?? []) collectBoundNames(el, out);
      return;
    case "AssignmentPattern":
      collectBoundNames(n.left, out);
      return;
    case "RestElement":
      collectBoundNames(n.argument, out);
      return;
    default:
      return;
  }
}

/**
 * Classify a stored arrow's captures (series 079, issue #46). Walks the arrow body
 * for free identifiers not bound by its own params; each free var that a
 * `containerAnnotationOf` resolves to a container is a **threadable capture**; a
 * scalar capture (an `=`/`++`/`--` on a free var, a wholesale rebind of a captured
 * container `s = …`, or a free var that is not a resolvable container) is fail-loud.
 * Returns the captured container names in first-occurrence order (a stable param
 * order for the sig and every rewritten call site), or `null` for a non-capturing
 * arrow (the existing lift is unchanged).
 *
 * @throws {UnsupportedError} on a scalar mutable capture, a wholesale-reassigned
 *   captured container, or a captured free var that is not a threadable container.
 */
function classifyStoredCapture(
  arrow: ArrowFunctionExpression,
  declInfoOf: (name: string) => { annotation?: unknown; init?: unknown } | undefined,
  topLevelFns: ReadonlySet<string>,
): string[] | null {
  // Names bound by the arrow itself (its params, incl. destructured `{x, y}` /
  // `[a, b]` patterns) plus any binding declared *inside* the body (`const h = …`,
  // `let n = …`, a for-of/catch binding) — none of these is a free capture.
  const bound = new Set<string>();
  for (const p of arrow.params) collectBoundNames(p, bound);
  astWalk(arrow.body, (n) => {
    if (n.type === "VariableDeclarator") collectBoundNames(n.id, bound);
    if (n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression") {
      // A nested closure's own params are bound in its scope, not the outer one —
      // but the outer walk still visits them; a two-level capture is a residual, so
      // treating a nested param as bound here is safe (it can't be an outer capture).
      for (const p of ((n as { params?: unknown[] }).params ?? [])) collectBoundNames(p, bound);
    }
  });
  const captured: string[] = [];
  const seen = new Set<string>();
  // A free identifier is a candidate capture unless it is bound (param / local), a
  // top-level fn, or a known callback global (`console`, `Math`, …).
  const isFree = (name: string): boolean =>
    !bound.has(name) && !topLevelFns.has(name) && !CB_GLOBALS.has(name);

  let scalarCapture = false;
  astWalk(arrow.body, (n) => {
    // A wholesale rebind of a free var (`s = …`, `n++`) is a scalar-style capture —
    // fail-loud (unchanged 048 for a scalar; a captured container reassigned
    // wholesale is out of scope, per the 079 residuals).
    if (n.type === "AssignmentExpression") {
      const left = n.left as { type?: string; name?: string };
      if (left?.type === "Identifier" && left.name && isFree(left.name)) scalarCapture = true;
    }
    if (n.type === "UpdateExpression") {
      const arg = n.argument as { type?: string; name?: string };
      if (arg?.type === "Identifier" && arg.name && isFree(arg.name)) scalarCapture = true;
    }
  });
  if (scalarCapture) {
    throw new UnsupportedError({
      type: "mutable capture in a closure (a captured scalar reassignment / a container rebound wholesale — lift to a named fn taking the state as an explicit param)",
    });
  }

  // A free identifier read (`arr[0]`, `s.add(...)`, a bare `x`) contributes a capture.
  // A resolvable container captures cleanly; any other free read (a scalar, an
  // un-typeable binding) is the 048 scalar-capture residual → fail-loud.
  const collect = (name: string): void => {
    if (!isFree(name) || seen.has(name)) return;
    seen.add(name);
    const info = declInfoOf(name);
    if (info && containerAnnotationOf(info)) {
      captured.push(name);
    } else {
      throw new UnsupportedError({
        type: `capture of '${name}' in a closure is not a threadable container (only Set/Map/Array/String captures thread; a captured scalar stays fail-loud)`,
      });
    }
  };
  // A context-aware walk: a non-computed member **property** name (`s.add` → `add`) is
  // a field, not a free var, so it is not descended into as an identifier read. A
  // nested arrow is not descended into (capture-through-two-levels is a fail-loud
  // residual — a nested capturing arrow is rejected on its own turn).
  const walkExpr = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) walkExpr(c);
      return;
    }
    const n = node as { type?: string; [k: string]: unknown };
    if (n.type === "Identifier") {
      collect(n.name as string);
      return;
    }
    if (n.type === "MemberExpression") {
      walkExpr(n.object);
      if (n.computed) walkExpr(n.property); // `arr[i]` — `i` is a read
      return; // a static `.prop` is a field name, not a free var
    }
    if (n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression") {
      return; // don't descend into a nested closure (two-level capture → fail-loud)
    }
    for (const k in n) {
      if (k === "type") continue;
      walkExpr(n[k]);
    }
  };
  walkExpr(arrow.body);
  return captured.length > 0 ? captured : null;
}

/**
 * Escape check (series 079): a captured-container stored closure `add` is
 * non-escaping iff **every** use of `add` in the program is a direct call
 * (`add(...)`). A use as an argument, a return value, a field/array store, or a
 * reassignment means the bound environment would outlive the call — env-threading
 * can't represent it, so fail-loud.
 *
 * @throws {UnsupportedError} when `add` escapes.
 */
function assertNonEscaping(name: string, body: Statement[]): void {
  // Every free read of `name` must be the callee of a direct call. A context-aware
  // walk (like the capture walk): a non-computed member **property** named `add`
  // (`s.add`) is a field, not a use of the binding; a `VariableDeclarator` id
  // (`const add = …`) is the declaration, not a use. Any other read of `name` — an
  // argument, a return value, a store, a rebind — is an escape.
  let escaped = false;
  const walk = (node: unknown, asDeclId: boolean): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) walk(c, false);
      return;
    }
    const n = node as { type?: string; [k: string]: unknown };
    if (n.type === "Identifier") {
      if (n.name === name && !asDeclId) escaped = true; // a bare read that isn't a callee
      return;
    }
    if (n.type === "CallExpression") {
      const callee = n.callee as { type?: string; name?: string } | undefined;
      // A direct call `add(...)` is the allowed use — don't flag its callee.
      if (!(callee?.type === "Identifier" && callee.name === name)) walk(n.callee, false);
      walk(n.arguments, false);
      return;
    }
    if (n.type === "MemberExpression") {
      walk(n.object, false);
      if (n.computed) walk(n.property, false); // a static `.prop` is a field name
      return;
    }
    if (n.type === "VariableDeclarator") {
      walk(n.id, true); // the binding id is the declaration, not a use
      walk(n.init, false);
      return;
    }
    for (const k in n) {
      if (k === "type") continue;
      walk(n[k], false);
    }
  };
  walk(body, false);
  if (escaped) {
    throw new UnsupportedError({
      type: `closure '${name}' captures a container and escapes (returned, stored, or passed as a value) — env-threading requires it be invoked directly only (fail-loud residual, series 079)`,
    });
  }
}

/**
 * Rewrite each `add(args)` call site of a threaded stored closure to
 * `__arrow_n(cap1, …, args)` (series 079): the captured containers become leading
 * args (bare identifiers; the call-site borrow `&`/`&mut` is folded in later by
 * `lowerCall` from the lifted fn's inferred param ownership). Mutates the AST in
 * place over the whole program body.
 */
function rewriteThreadedCalls(
  body: unknown,
  binding: string,
  fnName: string,
  captures: readonly string[],
): void {
  astWalk(body, (n) => {
    if (n.type !== "CallExpression") return;
    const callee = (n as { callee?: { type?: string; name?: string } }).callee;
    if (callee?.type === "Identifier" && callee.name === binding) {
      callee.name = fnName;
      const capArgs = captures.map((c) => ({ type: "Identifier", name: c }));
      const node = n as unknown as { arguments: unknown[] };
      node.arguments = [...capArgs, ...(node.arguments ?? [])];
    }
  });
}

/**
 * Rewrite each top-level `const f = (…) => …` (a single-declarator `const` bound
 * to an arrow, `async` or not) into a synthetic `FunctionDeclaration`, leaving
 * every other statement untouched. Run before analysis so a normalized arrow's
 * parameter ownership and call-site borrows are inferred, and calls to it adapt
 * their arguments, exactly as for a `function`. An `async` arrow normalizes to an
 * `async` fn (series 054b). A non-normalized arrow (`let`/`var`-bound,
 * value-position, nested) stays an expression and is rejected downstream in
 * `lowerExpr` — the documented deferral boundary.
 */
function normalizeArrows(program: Program): Program {
  // Top-level fn signatures — used to synthesize the `fn`-pointer annotation of a
  // fn-*value* binding (`const op = add`, series 058 Fork 1 case B).
  const fnSigs = new Map<string, FunctionDeclaration>();
  for (const stmt of program.body) {
    if (stmt.type === "FunctionDeclaration" && (stmt as FunctionDeclaration).id) {
      const f = stmt as FunctionDeclaration;
      if (f.id) fnSigs.set(f.id.name, f);
    }
  }
  // Container-capture threading (series 079/086, issue #46): a stored arrow that
  // captures a container needs, per captured var, its declaration (for the threaded
  // param's owned type annotation). Aliasing is **not** decided here — the shared/aliased
  // `Rc<RefCell>` promotion (series 086) is made by the post-lowering `computeAutoRc`
  // union-find, so the lift just threads the container either way. Program-wide, collected
  // once here.
  const declInfo = collectDeclInfo(program.body);
  const topLevelFns = new Set<string>(fnSigs.keys());
  const ctx: LiftCtx = {
    hoisted: [],
    counter: { n: 0 },
    fnSigs,
    reassigned: collectReassignedNames(program.body),
    declInfo,
    topLevelFns,
    threadedRewrites: [],
    programBody: program.body,
    scopeVars: declaredNamesOf(program.body),
  };
  const body = liftStmts(program.body, ctx, true);
  // Apply the call-site rewrites (`add(a)` → `__arrow_n(env, a)`) across the whole
  // resulting body, including the hoisted `__arrow_*` fns (a call site can sit inside
  // another lifted arrow).
  const full = [...body, ...ctx.hoisted];
  for (const rw of ctx.threadedRewrites) {
    rewriteThreadedCalls(full, rw.binding, rw.fnName, rw.captures);
  }
  return { ...program, body: full };
}

/** A declarator's annotation + init, keyed by binding name (series 079). */
function collectDeclInfo(
  stmts: Statement[],
): Map<string, { annotation?: unknown; init?: unknown }> {
  const out = new Map<string, { annotation?: unknown; init?: unknown }>();
  astWalk(stmts, (n) => {
    if (n.type !== "VariableDeclarator") return;
    const id = n.id as { type?: string; name?: string; typeAnnotation?: unknown };
    if (id?.type === "Identifier" && id.name) {
      out.set(id.name, { annotation: id.typeAnnotation, init: n.init });
    }
  });
  return out;
}

/** State threaded through the arrow-lift transform (series 058). */
interface LiftCtx {
  /** `__arrow_n` fns extracted from inline arrows, appended at module scope. */
  hoisted: FunctionDeclaration[];
  counter: { n: number };
  /** Top-level fn declarations, for typing a fn-value binding as a `fn`-pointer. */
  fnSigs: Map<string, FunctionDeclaration>;
  /** Every identifier reassigned somewhere (`x = …`) — a reassigned arrow binding
   * can't be a direct `fn`, so it takes the `fn`-pointer path. */
  reassigned: Set<string>;
  /** Binding name → its declaration (annotation + init), for a captured container's
   * threaded param type (series 079). */
  declInfo: Map<string, { annotation?: unknown; init?: unknown }>;
  /** Top-level fn names (excluded from a closure's free-var set). */
  topLevelFns: Set<string>;
  /** Deferred call-site rewrites for threaded stored closures (series 079), applied
   * once over the whole body after lifting. */
  threadedRewrites: { binding: string; fnName: string; captures: string[] }[];
  /** The original (pre-lift) program body — for the whole-program escape check. */
  programBody: Statement[];
  /**
   * Names in scope at the current lift point (series 086): the top-level declarations
   * plus, when lifting inside a `function`/arrow body, that scope's params + local
   * declarations. A container-capturing stored closure whose captured container is
   * **not** in this set is a **two-level** (or otherwise out-of-scope) capture — the
   * env-threaded call site can't reach the container → fail-loud. Reset per scope in
   * `liftStmts` (see `withScope`).
   */
  scopeVars: Set<string>;
}

/**
 * Arrow-binding lift (series 058). Rewrite each `const`/`let`/`var` declarator
 * whose init is a non-capturing arrow, at any scope:
 *   - A **top-level, non-reassigned** arrow binding promotes to a direct free `fn`
 *     (the shipped 015 behavior, now also for `let`/`var` and `async`).
 *   - Any **other** arrow binding (nested scope, or reassigned) hoists the arrow to
 *     a top-level `fn __arrow_n` and keeps a `fn`-pointer binding (`let f:
 *     fn(..)->.. = __arrow_n`), synthesizing the pointer annotation from the arrow.
 *   - A **fn-value** binding (`const op = add`) gets the same synthesized pointer
 *     annotation so it needs no user annotation.
 * Multiple declarators split into per-binding statements. `async` in the
 * `fn`-pointer path fails loud (no `fn`-pointer form for a future-returning fn).
 */
function liftStmts(
  stmts: Statement[],
  ctx: LiftCtx,
  topLevel: boolean,
): Statement[] {
  const out: Statement[] = [];
  for (const stmt of stmts) {
    const recursed = liftNested(stmt, ctx);
    if (recursed.type === "VariableDeclaration") {
      out.push(...liftVarDecl(recursed as VariableDeclaration, ctx, topLevel));
    } else {
      out.push(recursed);
    }
  }
  return out;
}

/**
 * The names declared directly in a statement list (series 086): each `const`/`let`/`var`
 * binding id (a plain `Identifier`) and each nested `function`/`class` name. Used to seed
 * the `scopeVars` in-scope set so a container-capturing closure can verify its captured
 * container is reachable at the lift point (else it is a two-level capture → fail-loud).
 * Shallow (does not descend nested bodies — those are separate scopes).
 */
function declaredNamesOf(stmts: Statement[]): Set<string> {
  const names = new Set<string>();
  for (const s of stmts) {
    if (s.type === "VariableDeclaration") {
      for (const d of (s as VariableDeclaration).declarations) {
        const id = d.id as { type?: string; name?: string };
        if (id?.type === "Identifier" && id.name) names.add(id.name);
      }
    }
    const named = s as { type?: string; id?: { name?: string } };
    if (
      (named.type === "FunctionDeclaration" || named.type === "ClassDeclaration") &&
      named.id?.name
    ) {
      names.add(named.id.name);
    }
  }
  return names;
}

/**
 * Run `fn` with `scopeVars` **replaced** by an inner function scope's own params + local
 * declarations (series 086). `scopeVars` tracks only the **immediately-enclosing function
 * scope**, not the transitive outer chain: a container-capturing closure can thread its
 * captured container only when the container is a param/local of the same function scope
 * the closure sits in — a container from a further-out scope (`inner` inside `outer`
 * capturing a top-level `s`) is a two-level capture env-threading can't reach → fail-loud.
 */
function withScope(
  ctx: LiftCtx,
  params: readonly unknown[],
  body: Statement[],
  fn: () => void,
): void {
  const prev = ctx.scopeVars;
  const inner = new Set<string>();
  for (const p of params) collectBoundNames(p, inner);
  for (const n of declaredNamesOf(body)) inner.add(n);
  ctx.scopeVars = inner;
  try {
    fn();
  } finally {
    ctx.scopeVars = prev;
  }
}

/** Recurse the transform into a statement's nested scopes (fn bodies, blocks, …). */
function liftNested(stmt: Statement, ctx: LiftCtx): Statement {
  switch (stmt.type) {
    case "FunctionDeclaration": {
      const f = stmt as FunctionDeclaration;
      if (f.body) {
        withScope(ctx, f.params ?? [], f.body.body, () => {
          f.body = { ...(f.body as BlockStatement), body: liftStmts((f.body as BlockStatement).body, ctx, false) };
        });
      }
      return f;
    }
    case "BlockStatement": {
      const b = stmt as BlockStatement;
      return { ...b, body: liftStmts(b.body, ctx, false) };
    }
    case "IfStatement": {
      const s = stmt as IfStatement;
      return {
        ...s,
        consequent: liftNested(s.consequent, ctx),
        alternate: s.alternate ? liftNested(s.alternate, ctx) : null,
      };
    }
    case "WhileStatement":
    case "ForStatement":
    case "ForOfStatement": {
      const s = stmt as WhileStatement | ForStatement | ForOfStatement;
      return { ...s, body: liftNested(s.body, ctx) };
    }
    case "TryStatement": {
      const s = stmt as TryStatement;
      return {
        ...s,
        block: liftNested(s.block, ctx) as BlockStatement,
        handler: s.handler
          ? { ...s.handler, body: liftNested(s.handler.body, ctx) as BlockStatement }
          : s.handler,
        finalizer: s.finalizer
          ? (liftNested(s.finalizer, ctx) as BlockStatement)
          : null,
      };
    }
    default:
      return stmt;
  }
}

/** Transform one `const`/`let`/`var` declaration into per-declarator statements. */
function liftVarDecl(
  decl: VariableDeclaration,
  ctx: LiftCtx,
  topLevel: boolean,
): Statement[] {
  const out: Statement[] = [];
  for (const d of decl.declarations) {
    const init = d.init;
    if (init?.type === "ArrowFunctionExpression") {
      const arrow = init as ArrowFunctionExpression;
      const name = (d.id as Identifier).name;
      // Container-capture threading (series 079, issue #46). A stored arrow that
      // captures a container (read or method-mutated) can't be a plain free `fn` (it
      // would reference an out-of-scope binding). Thread the captured containers as
      // leading params of a hoisted `__arrow_n` and rewrite every call site to pass
      // them; `analyzeFunction` infers each param's `&`/`&mut` from body use and
      // `lowerCall` folds the borrow in at the (rewritten) call sites. A scalar
      // capture, a wholesale rebind, an aliased owner (→ Rc row), or an escaping
      // binding all fail loud inside `classifyStoredCapture` / the checks below.
      const captures = classifyStoredCapture(
        arrow,
        (n) => ctx.declInfo.get(n),
        ctx.topLevelFns,
      );
      if (captures) {
        threadStoredCapture(d, arrow, decl, captures, ctx, out);
        continue;
      }
      if (topLevel && !ctx.reassigned.has(name)) {
        // Direct promotion → a free `fn` (async carries over); recurse to lift any
        // arrows nested in its body.
        out.push(liftNested(arrowToFunctionDecl(d.id as Identifier, arrow), ctx));
      } else {
        // `fn`-pointer path: hoist the arrow, keep a typed pointer binding.
        if (arrow.async) {
          throw new UnsupportedError({
            type: "a nested or reassigned `async` arrow binding (no fn-pointer form)",
          });
        }
        const fnName = `__arrow_${ctx.counter.n++}`;
        const id: Identifier = { ...(d.id as Identifier), name: fnName };
        ctx.hoisted.push(
          liftNested(arrowToFunctionDecl(id, arrow), ctx) as FunctionDeclaration,
        );
        out.push(
          singleDecl(decl.kind, {
            ...d,
            id: annotateAsFn(d.id as Identifier, arrow.params, arrow.returnType),
            init: { type: "Identifier", name: fnName, start: init.start, end: init.end },
          }),
        );
      }
    } else if (
      init?.type === "Identifier" &&
      !(d.id as Identifier).typeAnnotation &&
      ctx.fnSigs.has((init as Identifier).name)
    ) {
      // Fn-value binding (`const op = add`) → synthesize the fn-pointer annotation.
      const sig = ctx.fnSigs.get((init as Identifier).name) as FunctionDeclaration;
      out.push(
        singleDecl(decl.kind, {
          ...d,
          id: annotateAsFn(d.id as Identifier, sig.params, sig.returnType ?? null),
        }),
      );
    } else {
      out.push(singleDecl(decl.kind, d));
    }
  }
  return out;
}

/**
 * Thread a stored closure's captured containers as leading params of a hoisted
 * `__arrow_n` fn and record the call-site rewrite (series 079). The binding itself is
 * dropped — a container-capturing closure carries a bound environment, so it is no
 * longer a plain fn-pointer value; every use must be a direct call (checked by
 * `assertNonEscaping`). Fails loud on an aliased owner (deferred `Rc` row), an
 * escaping use, or an `async` closure (no env-threaded async form).
 */
function threadStoredCapture(
  d: VariableDeclarator,
  arrow: ArrowFunctionExpression,
  _decl: VariableDeclaration,
  captures: string[],
  ctx: LiftCtx,
  _out: Statement[],
): void {
  const binding = (d.id as Identifier).name;
  if (arrow.async) {
    throw new UnsupportedError({
      type: "an `async` closure capturing a container (no env-threaded async form, series 079)",
    });
  }
  // Two-level (out-of-scope) capture guard (series 086): env-threading can only thread a
  // captured container that is a param/local of the **same** function scope the closure
  // sits in. A container declared further out (`inner` inside `outer` capturing a
  // top-level `s`) has no threadable path — the intermediate scope would have to
  // re-thread it. Fail-loud (the 079 two-level residual).
  for (const cap of captures) {
    if (!ctx.scopeVars.has(cap)) {
      throw new UnsupportedError({
        type: `closure captures container '${cap}' from an enclosing scope more than one level out (two-level capture) — env-threading can't reach it (fail-loud residual, series 086)`,
      });
    }
  }
  // A captured container is threaded as a leading param **regardless** of whether its
  // owner is aliased (series 086, issue #46). The owned-mutable case keeps 079's by-need
  // `&mut` borrow; the **shared/aliased** case (`const t = s`) instead promotes the
  // whole alias closure to `Rc<RefCell<T>>` — but that decision is made **later**, by the
  // post-lowering `computeAutoRc` union-find (it sees the alias edge, the bare-ident
  // collection mutator inside `__arrow_n`, and the arg→param thread), not here. So the
  // pre-analysis lift produces the ordinary `__arrow_n(s, a)` shape either way and lets
  // `refineRc` splice the `Rc::clone` / `.borrow_mut()` in for the promoted case. The
  // ≥2-member alias gate keeps a lone owned container on the `&mut` path (no regression).
  // Escape check: every use of the binding must be a direct call. Run over the whole
  // program (a call site can precede or follow the declaration in source order).
  assertNonEscaping(binding, ctx.programBody);

  // The threaded leading params: each captured container by its owned type annotation
  // (borrow inferred from body use), then the arrow's own params unchanged.
  const capParams: Identifier[] = captures.map((cap) => {
    const info = ctx.declInfo.get(cap);
    const ann = info ? containerAnnotationOf(info) : null;
    if (!ann) {
      // Unreachable: `classifyStoredCapture` only admitted captures `containerAnnotationOf`
      // resolves. Kept as a fail-loud guard rather than a silent untyped param.
      throw new UnsupportedError({
        type: `cannot synthesize a threaded param type for captured container '${cap}' (series 079)`,
      });
    }
    return {
      type: "Identifier",
      name: cap,
      typeAnnotation: ann,
    } as unknown as Identifier;
  });

  const fnName = `__arrow_${ctx.counter.n++}`;
  const id: Identifier = { ...(d.id as Identifier), name: fnName };
  const fn = arrowToFunctionDecl(id, arrow);
  fn.params = [...capParams, ...(arrow.params as Identifier[])];
  ctx.hoisted.push(liftNested(fn, ctx) as FunctionDeclaration);
  ctx.threadedRewrites.push({ binding, fnName, captures });
  // No binding statement is emitted — the closure is now a bound-env fn, not a value.
}

/** Wrap one declarator in its own single-declarator `VariableDeclaration`. */
function singleDecl(
  kind: VariableDeclaration["kind"],
  d: VariableDeclarator,
): VariableDeclaration {
  return {
    type: "VariableDeclaration",
    kind,
    declarations: [d],
    start: d.start,
    end: d.end,
  };
}

/** Attach a synthesized `(P…) => R` type annotation to a binding id (series 058). */
function annotateAsFn(
  id: Identifier,
  params: Identifier[],
  returnType: TSTypeAnnotation | null | undefined,
): Identifier {
  if (id.typeAnnotation) return id;
  const fnType = {
    type: "TSFunctionType",
    params,
    returnType: returnType ?? null,
    start: id.start,
    end: id.end,
  } as unknown as TSType;
  return {
    ...id,
    typeAnnotation: {
      type: "TSTypeAnnotation",
      typeAnnotation: fnType,
      start: id.start,
      end: id.end,
    },
  };
}

/** Collect every identifier name that is the target of an assignment (`x = …`). */
function collectReassignedNames(stmts: Statement[]): Set<string> {
  const names = new Set<string>();
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    const node = n as { type?: string; left?: { type?: string; name?: string } };
    if (node.type === "AssignmentExpression" && node.left?.type === "Identifier") {
      if (node.left.name) names.add(node.left.name);
    }
    for (const v of Object.values(n as Record<string, unknown>)) walk(v);
  };
  walk(stmts);
  return names;
}

/**
 * Build the synthetic `FunctionDeclaration` for a normalized arrow: the binding
 * name becomes the fn `id`; `params`/`returnType`/`async` carry over unchanged;
 * the body is the arrow's `BlockStatement` verbatim, or `{ return <expr>; }` for
 * an expression body (the `=> expr` desugar). Spans are inherited from the arrow
 * so any downstream diagnostic still points at the source.
 */
function arrowToFunctionDecl(
  name: Identifier,
  arrow: ArrowFunctionExpression,
): FunctionDeclaration {
  const body: BlockStatement =
    arrow.body.type === "BlockStatement"
      ? (arrow.body as BlockStatement)
      : {
          type: "BlockStatement",
          body: [
            {
              type: "ReturnStatement",
              argument: arrow.body as Expression,
              start: arrow.body.start,
              end: arrow.body.end,
            } satisfies ReturnStatement,
          ],
          start: arrow.body.start,
          end: arrow.body.end,
        };
  return {
    type: "FunctionDeclaration",
    id: name,
    async: arrow.async,
    params: arrow.params,
    returnType: arrow.returnType ?? null,
    body,
    start: arrow.start,
    end: arrow.end,
  };
}

// ── Directives (series 028) ──────────────────────────────────────────────────

/**
 * Consume the leading string-literal *directives* of a scope, validating each,
 * and return the remaining statements. `"use panic"` (028a) is consumed here —
 * its semantics already live in `analysis.panicScopes` — as are `"use rc"` (028b,
 * `analysis.rcScopes`, applied by `refineRc`), `"use arena"` (028c,
 * `analysis.arenaScopes`, applied by `refineArena`), and the JS-standard
 * `"use strict"` no-op. Any other `"use …"` string fails loud (`DialectError`,
 * never a silent no-op). A non-`use` leading string is not a directive and is
 * left in place.
 *
 * @throws {DialectError} on an unrecognized `"use …"` directive.
 * @throws {UnsupportedError} on a strategy directive (`"use panic"`/`"use rc"`/
 *   `"use arena"`) outside a free fn / script.
 */
function takeDirectives(
  stmts: Statement[],
  opts?: { panicAllowed?: boolean },
): Statement[] {
  let i = 0;
  for (; i < stmts.length; i++) {
    const s = stmts[i];
    if (!s || s.type !== "ExpressionStatement") break;
    const e = (s as ExpressionStatement).expression;
    if (e.type !== "Literal" || typeof (e as Literal).value !== "string") break;
    const d = (e as Literal).value as string;
    if (d === "use panic") {
      if (!opts?.panicAllowed) {
        throw new UnsupportedError({
          type: "`use panic` outside a free function or the top-level script",
        });
      }
      continue;
    }
    if (d === "use strict") continue; // JS prologue, a no-op for us
    if (d === "use rc") {
      // 028b: consumed here — its semantics live in `analysis.rcScopes`, applied
      // by the `refineRc` pass. Like `"use panic"`, only on a free fn / script.
      if (!opts?.panicAllowed) {
        throw new UnsupportedError({
          type: "`use rc` outside a free function or the top-level script",
        });
      }
      continue;
    }
    if (d === "use arena") {
      // 028c: consumed here — semantics live in `analysis.arenaScopes`, applied
      // by the `refineArena` pass. Like `"use rc"`, only on a free fn / script.
      if (!opts?.panicAllowed) {
        throw new UnsupportedError({
          type: "`use arena` outside a free function or the top-level script",
        });
      }
      continue;
    }
    if (d.startsWith("use ")) {
      throw new DialectError(`unrecognized directive "${d}"`);
    }
    break; // a non-`use` leading string literal is not a directive
  }
  return stmts.slice(i);
}

// ── Items ────────────────────────────────────────────────────────────────────

/**
 * Collect a **method/function's own** generic type params (series 081): the `<U>`
 * of `first<U>(xs: U[]): U`. Unbounded only in slice 1 — a bound on a fn/method
 * type param is fail-loud (deferred; class-level `<T extends I>` is where bounds
 * land). Returns the bare names, and pushes them onto `analysis.typeParams` (the
 * caller pops via `withFnGenerics`).
 */
function fnGenericNames(
  fn: { typeParameters?: TSTypeParamDecl | null },
): string[] {
  const tp = fn.typeParameters;
  if (!tp) return [];
  return tp.params.map((param) => {
    if (param.constraint) {
      throw new UnsupportedError({
        type: `a bound on the method/function type parameter '${param.name.name}' (a bounded generic is only supported on a class type parameter '<T extends I>')`,
      });
    }
    return param.name.name;
  });
}

/**
 * Run `body` with `names` added to the in-scope generic type-param set (series
 * 081), restoring the prior set after. Used for a generic method/fn's signature +
 * body; the class's own `<T>` is already in scope (pushed by `lowerClass`).
 */
function withFnGenerics<T>(
  analysis: ModuleAnalysis,
  names: string[],
  body: () => T,
): T {
  if (names.length === 0) return body();
  const prev = analysis.typeParams;
  analysis.typeParams = new Set([...prev, ...names]);
  try {
    return body();
  } finally {
    analysis.typeParams = prev;
  }
}

function lowerFunction(
  func: FunctionDeclaration,
  analysis: ModuleAnalysis,
): HirFn {
  if (!func.id) throw new UnsupportedError(func);
  const generics = fnGenericNames(func as { typeParameters?: TSTypeParamDecl | null });
  return withFnGenerics(analysis, generics, () =>
    lowerFunctionInner(func, analysis, generics),
  );
}

function lowerFunctionInner(
  func: FunctionDeclaration,
  analysis: ModuleAnalysis,
  generics: string[],
): HirFn {
  const name = (func.id as Identifier).name;
  const info = analysis.fns.get(name);
  const genericsOpt = generics.length > 0 ? generics : undefined;

  const params = func.params.map((p, i) =>
    lowerParam(p, info?.params[i], analysis.structs, analysis.typeParams),
  );
  // Class inheritance (series 053b, INH10): a base-typed param is monomorphic —
  // `impl IA` (static dispatch, zero-cost). Rewrites the param type and records
  // it as a `dyn` binding so a `.method()` dispatches through the trait and a
  // `.field` read routes through an accessor.
  applyBaseParamTraits(params, analysis);
  // A missing return type used to default silently to `-> ()`; it now fails loud
  // (series 046c). An explicit `: void` annotation still lowers to `UNIT` via
  // `lowerType`, so genuinely unit-returning functions annotate `: void`.
  let ret: RustType;
  if (!func.returnType) {
    // Series 099 inference tier: infer the return type via the oracle's signature
    // resolution (robust to multi-return / implicit `undefined`), re-validate to
    // a modeled `RustType`. Null (out of surface, or no oracle) keeps the throw.
    const inferred = analysis.typeOracle
      ? analysis.typeOracle.inferredReturnRustType(func.start, func.end)
      : null;
    if (!inferred) {
      throw new UnsupportedError({
        type: `function '${name}' without a return type annotation`,
        start: func.id?.start,
      });
    }
    ret = inferred;
  } else {
    ret = lowerType(
      func.returnType.typeAnnotation,
      analysis.structs,
      analysis.typeParams,
    );
  }

  if (!func.body)
    throw new UnsupportedError({ type: "function without a body" });
  // The function name is its own scope key for mutability lookups. Leading
  // directives (`"use panic"`, 028a) are consumed here — panic semantics already
  // live in `analysis.panicScopes`; stripping keeps the string out of the body.
  const body = [
    ...defaultParamPreludes(
      func.params as unknown as { type?: string }[],
      analysis,
    ),
    ...lowerStatements(
      takeDirectives(func.body.body, { panicAllowed: true }),
      analysis,
      name,
    ),
  ];

  // A fallible function (it throws, or calls something that throws) returns
  // `Result<ret, String>`: wrap its returns in `Ok`, keep its `throw`s as `Err`.
  // An `async` fallible fn composes both — `async fn … -> Result<…>` — and an
  // awaited fallible call propagates with `.await?` (see lowerAwait).
  if (analysis.fallible.has(name)) {
    return {
      kind: "fn",
      name,
      isAsync: func.async,
      params,
      ret: resultType(ret, programErrType(analysis)),
      body: makeFallible(body, ret),
      generics: genericsOpt,
    };
  }

  return { kind: "fn", name, isAsync: func.async, params, ret, body, generics: genericsOpt };
}

/**
 * Lower a sync generator (`function* g(): Generator<T> { yield a; yield b; … }`,
 * series 025d) to a `fn g(…) -> impl Iterator<Item = T>` that returns a fixed
 * sequence: `vec![a, b, …].into_iter()`. This first slice handles the
 * **straight-line finite-yield** shape — a body that is exactly a sequence of
 * `yield <expr>;` statements. Anything else (a `yield` inside a loop / `if` /
 * `switch`, a `yield*` delegation, a non-`yield` statement, an `async` generator,
 * or a missing/again-`Generator` return annotation) is a real state-machine
 * transform and stays fail-loud (`UnsupportedError`) until a later increment.
 *
 * The item type comes from the `Generator<T>` / `IterableIterator<T>` return
 * annotation; `for (const x of g())` consumes the result directly (see
 * `lowerForOf`).
 */
function lowerGenerator(
  func: FunctionDeclaration,
  analysis: ModuleAnalysis,
): HirFn | HirGenerator {
  if (!func.id) throw new UnsupportedError(func);
  const name = func.id.name;
  const info = analysis.fns.get(name);
  const params = func.params.map((p, i) =>
    lowerParam(p, info?.params[i], analysis.structs),
  );

  // The element type is the first type argument of the `Generator<T>` /
  // `IterableIterator<T>` return annotation. A bare/absent annotation is fail-loud
  // — an item type can't be inferred soundly for `impl Iterator`.
  const ann = func.returnType?.typeAnnotation;
  const ref =
    ann?.type === "TSTypeReference"
      ? (ann as Extract<TSType, { type: "TSTypeReference" }>)
      : null;
  const genNames = new Set(["Generator", "IterableIterator", "Iterable"]);
  if (!ref || !genNames.has(ref.typeName.name)) {
    throw new UnsupportedError({
      type: "generator without a `Generator<T>` / `IterableIterator<T>` return annotation",
    });
  }
  const itemAnn = ref.typeArguments?.params?.[0];
  if (!itemAnn)
    throw new UnsupportedError({ type: "generator without an item type" });
  const item = lowerType(itemAnn, analysis.structs);

  // The completion type `R` (series 075) — the 2nd `Generator<Y, R>` type arg. When
  // absent it is inferred at the state-machine build (from a `return <value>`);
  // bare `return` / fall-off is unit. An explicit `R` here overrides inference.
  const retAnn = ref.typeArguments?.params?.[1];
  const declaredRetTy = retAnn ? lowerType(retAnn, analysis.structs) : null;

  if (!func.body)
    throw new UnsupportedError({ type: "generator without a body" });

  // Shape dispatch (series 052). A **straight-line all-`yield`** body keeps the
  // 035 `vec![…].into_iter()` lowering (no state machine); anything with loops,
  // branches, or non-`yield` statements interleaved with yields becomes a
  // resumable state machine (`buildGeneratorStateMachine`). A `yield*` / bare
  // `yield` makes the body non-straight-line, so it falls to the state-machine
  // path, which keeps them fail-loud residuals.
  const straightLineBody = func.body.body.every((s) => {
    if (s.type !== "ExpressionStatement") return false;
    const e = (s as ExpressionStatement).expression as unknown as {
      type: string;
      delegate?: boolean;
      argument?: Expression;
    };
    return e.type === "YieldExpression" && !e.delegate && !!e.argument;
  });
  // A generator consumed by a manual `step()` surface (manual `.next()`,
  // destructure, or a read `yield*` completion value — series 075) must lower to
  // the state-machine struct, which carries `step()` / `Steppable`. The
  // straight-line `vec![…].into_iter()` fast path has no struct, so force the
  // machine for those consumers even when the body is straight-line.
  const isStraightLine =
    straightLineBody && !analysis.steppedGenerators.has(name);

  if (isStraightLine) {
    // `vec![e1, …].into_iter()` is an idiomatic `impl Iterator<Item = T>` — no
    // state machine needed for the finite case.
    const elements: HirExpr[] = func.body.body.map((s) => {
      const y = (s as ExpressionStatement).expression as unknown as {
        argument: Expression;
      };
      return lowerExpr(y.argument, analysis);
    });
    const body: HirStmt[] = [
      {
        kind: "return",
        value: {
          kind: "method",
          receiver: { kind: "array", elements },
          name: "into_iter",
          args: [],
        },
      },
    ];
    return {
      kind: "fn",
      name,
      isAsync: false,
      params,
      ret: { kind: "implIterator", item },
      body,
    };
  }

  return buildGeneratorStateMachine(
    func,
    name,
    params,
    item,
    declaredRetTy,
    analysis,
  );
}

// ── Generator state machines (series 052) ────────────────────────────────────
//
// A `function*` with loops / branches / non-`yield` statements lowers to a
// resumable state machine (`HirGenerator`): a `struct` (`state: u32` + carried
// params + across-yield locals) with `impl Iterator { fn next() { loop { match
// self.state { … } } } }`. The transform is two passes over a small intra-fn
// CFG: (1) build basic blocks split at every `yield` and control-flow join;
// (2) backward live-variable analysis to find locals **live across a yield** —
// those become struct fields (params always are). The suspend primitive is a
// nameable `yieldReturn` HIR node and the CFG/liveness are agnostic to `next`
// vs a future `poll_next`, so an async-generator (`Stream`) series can reuse
// this wholesale (see the 051↔052 overlap spike).

/** A basic-block terminator in the generator CFG (AST-level conditions/values). */
type GenTerm =
  | { kind: "goto"; target: number }
  | { kind: "branch"; cond: Expression; then: number; else: number }
  // `resultTarget` is the binding of a **read** yield result (`const x = yield e`,
  // series 076) — the resumed arm binds `x` to the sent value; `null` is a pure
  // `yield e;` statement (052, no result read).
  | { kind: "yield"; value: Expression; resume: number; resultTarget: string | null }
  // `yield*` delegation; `resultTarget` is the binding of a read completion value
  // (`const r = yield* inner()`, series 075), else `null` (065's unread form).
  | { kind: "yieldStar"; iter: Expression; resume: number; resultTarget: string | null }
  // `done` with an optional `return <value>` payload (series 075): the completion
  // value carried to `GenStep::Return`. `null` is a bare `return` / fall-off (`R = ()`).
  | { kind: "done"; value?: Expression | null };

/** A basic block: straight-line leaf statements then a terminator. */
interface GenBlock {
  id: number;
  stmts: Statement[];
  term: GenTerm;
}

function buildGeneratorStateMachine(
  func: FunctionDeclaration,
  name: string,
  params: HirParam[],
  item: RustType,
  declaredRetTy: RustType | null,
  analysis: ModuleAnalysis,
): HirGenerator {
  // A borrowed param can't be captured owned in the struct (it would need a
  // lifetime-bearing generator struct) — the owned Option-A model can't express
  // it. In scope all generator params are `Copy` scalars; this stays fail-loud.
  for (const p of params) {
    if (p.ty.kind === "ref") {
      throw new UnsupportedError({
        type: "state-machine generator with a borrowed (non-owned) parameter",
      });
    }
  }
  const body = func.body!;

  // ── Pass 1: build the CFG ──────────────────────────────────────────────────
  const blocks: GenBlock[] = [];
  const newBlock = (): number => {
    const id = blocks.length;
    blocks.push({ id, stmts: [], term: { kind: "done" } });
    return id;
  };
  /** Every index here comes from `newBlock()`, so the block always exists. */
  const bat = (i: number): GenBlock => blocks[i] as GenBlock;
  const loopStack: { brk: number; cont: number }[] = [];

  const buildStmt = (s: Statement, cur: number): number | null => {
    switch (s.type) {
      case "ExpressionStatement": {
        const e = (s as ExpressionStatement).expression as unknown as {
          type: string;
          delegate?: boolean;
          argument?: Expression;
        };
        if (e.type === "YieldExpression") {
          if (!e.argument) {
            throw new UnsupportedError({ type: "bare `yield` (no value)" });
          }
          const resume = newBlock();
          // `yield* <iter>` (series 065) → a delegating state; a plain `yield v` →
          // a suspend state (052).
          bat(cur).term = e.delegate
            ? { kind: "yieldStar", iter: e.argument, resume, resultTarget: null }
            : { kind: "yield", value: e.argument, resume, resultTarget: null };
          return resume;
        }
        bat(cur).stmts.push(s);
        return cur;
      }
      case "VariableDeclaration": {
        // `const r = yield* inner()` (series 075) — a read `yield*` completion
        // value: a delegating state that binds the delegate's `GenStep::Return`
        // payload to `r`. A single declarator only (the common shape).
        const decls = (s as VariableDeclaration).declarations;
        const d0 = decls[0] as
          | { id?: { type?: string; name?: string }; init?: unknown }
          | undefined;
        const init0 = d0?.init as
          | { type?: string; delegate?: boolean; argument?: Expression }
          | undefined;
        if (
          decls.length === 1 &&
          d0?.id?.type === "Identifier" &&
          d0.id.name &&
          init0?.type === "YieldExpression" &&
          init0.delegate &&
          init0.argument
        ) {
          const resume = newBlock();
          bat(cur).term = {
            kind: "yieldStar",
            iter: init0.argument,
            resume,
            resultTarget: d0.id.name,
          };
          return resume;
        }
        // `const x = yield e` (series 076) — a **read** yield result: a suspend
        // state whose resumed arm binds `x` to the sent value. This makes the
        // generator bidirectional (a `resume(&mut self, sent)` method). A single
        // identifier declarator only (the common shape).
        if (
          decls.length === 1 &&
          d0?.id?.type === "Identifier" &&
          d0.id.name &&
          init0?.type === "YieldExpression" &&
          !init0.delegate &&
          init0.argument
        ) {
          const resume = newBlock();
          bat(cur).term = {
            kind: "yield",
            value: init0.argument,
            resume,
            resultTarget: d0.id.name,
          };
          return resume;
        }
        bat(cur).stmts.push(s);
        return cur;
      }
      case "IfStatement": {
        const iff = s as IfStatement;
        // A yield-free `if` is an ordinary leaf statement — keep it whole so the
        // CFG cost is paid only for branches that actually suspend.
        if (!containsYield(iff)) {
          bat(cur).stmts.push(s);
          return cur;
        }
        const thenEntry = newBlock();
        const hasElse = !!iff.alternate;
        const elseEntry = hasElse ? newBlock() : null;
        const cont = newBlock();
        bat(cur).term = {
          kind: "branch",
          cond: iff.test,
          then: thenEntry,
          else: hasElse ? (elseEntry as number) : cont,
        };
        const thenExit = buildSeq(blockBody(iff.consequent), thenEntry);
        if (thenExit !== null)
          bat(thenExit).term = { kind: "goto", target: cont };
        if (hasElse) {
          const elseExit = buildSeq(
            blockBody(iff.alternate as Statement),
            elseEntry as number,
          );
          if (elseExit !== null)
            bat(elseExit).term = { kind: "goto", target: cont };
        }
        return cont;
      }
      case "ForStatement": {
        const f = s as ForStatement;
        if (!containsYield(f)) {
          bat(cur).stmts.push(s);
          return cur;
        }
        if (f.init) {
          bat(cur).stmts.push(
            f.init.type === "VariableDeclaration"
              ? (f.init as unknown as Statement)
              : exprStmt(f.init as Expression),
          );
        }
        const test = newBlock();
        const bodyB = newBlock();
        const update = newBlock();
        const cont = newBlock();
        bat(cur).term = { kind: "goto", target: test };
        bat(test).term = f.test
          ? { kind: "branch", cond: f.test, then: bodyB, else: cont }
          : { kind: "goto", target: bodyB };
        loopStack.push({ brk: cont, cont: update });
        const bodyExit = buildSeq(blockBody(f.body), bodyB);
        loopStack.pop();
        if (bodyExit !== null)
          bat(bodyExit).term = { kind: "goto", target: update };
        if (f.update) bat(update).stmts.push(exprStmt(f.update));
        bat(update).term = { kind: "goto", target: test };
        return cont;
      }
      case "WhileStatement": {
        const w = s as WhileStatement;
        if (!containsYield(w)) {
          bat(cur).stmts.push(s);
          return cur;
        }
        const test = newBlock();
        const bodyB = newBlock();
        const cont = newBlock();
        bat(cur).term = { kind: "goto", target: test };
        bat(test).term = {
          kind: "branch",
          cond: w.test,
          then: bodyB,
          else: cont,
        };
        loopStack.push({ brk: cont, cont: test });
        const bodyExit = buildSeq(blockBody(w.body), bodyB);
        loopStack.pop();
        if (bodyExit !== null)
          bat(bodyExit).term = { kind: "goto", target: test };
        return cont;
      }
      case "BlockStatement":
        return buildSeq((s as BlockStatement).body, cur);
      case "BreakStatement": {
        if ((s as BreakStatement).label) {
          throw new UnsupportedError({ type: "labeled break" });
        }
        const top = loopStack[loopStack.length - 1];
        if (!top) {
          throw new UnsupportedError({
            type: "`break` outside a loop in a generator",
          });
        }
        bat(cur).term = { kind: "goto", target: top.brk };
        return null;
      }
      case "ContinueStatement": {
        if ((s as ContinueStatement).label) {
          throw new UnsupportedError({ type: "labeled continue" });
        }
        const top = loopStack[loopStack.length - 1];
        if (!top) {
          throw new UnsupportedError({
            type: "`continue` outside a loop in a generator",
          });
        }
        bat(cur).term = { kind: "goto", target: top.cont };
        return null;
      }
      case "ReturnStatement": {
        // `return <value>` (series 075) carries the completion value to the
        // terminal as the `GenStep::Return` payload; a bare `return` is `R = ()`.
        const arg = (s as { argument?: Expression | null }).argument ?? null;
        bat(cur).term = { kind: "done", value: arg };
        return null;
      }
      default:
        throw new UnsupportedError({
          type: `unsupported statement in a state-machine generator: ${s.type}`,
        });
    }
  };

  function buildSeq(stmts: Statement[], startBlock: number): number | null {
    let cur: number | null = startBlock;
    for (const s of stmts) {
      if (cur === null) {
        throw new UnsupportedError({
          type: "unreachable statement after return/break/continue in a generator",
        });
      }
      cur = buildStmt(s, cur);
    }
    return cur;
  }

  const entry = newBlock(); // state 0
  const exit = buildSeq(body.body, entry);
  if (exit !== null) bat(exit).term = { kind: "done" };
  const terminal = blocks.length; // the reserved `_ => None` state

  // The completion type `R` (series 075): an explicit `Generator<Y, R>` arg wins;
  // otherwise inferred from the first `return <value>`; bare `return` / fall-off is
  // unit. `hasReturnValue` drives the `__ret: Option<R>` field + `step()` `take()`.
  const returnValueExprs = blocks
    .map((b) => (b.term.kind === "done" ? b.term.value ?? null : null))
    .filter((v): v is Expression => v !== null);
  const hasReturnValue = returnValueExprs.length > 0;
  let retTy: RustType = declaredRetTy ?? UNIT;
  if (!declaredRetTy && hasReturnValue) {
    // Infer `R` from the first `return <value>` — type its lowered form with the
    // param context (across-yield locals aren't in scope for a numeric return, the
    // common case). An unresolved type is fail-loud (annotate `Generator<Y, R>`).
    const ctx = new Map<string, RustType>();
    for (const p of params) ctx.set(p.name, p.ty);
    const inferred = typeCbBody(
      lowerExpr(returnValueExprs[0] as Expression, analysis),
      ctx,
    );
    if (!inferred || inferred.kind === "unit") {
      throw new UnsupportedError({
        type: "generator `return <value>` whose completion type can't be inferred — annotate `Generator<Y, R>`",
      });
    }
    retTy = inferred;
  }

  // ── Pass 2: liveness → which locals become struct fields ───────────────────
  const paramNames = new Set(params.map((p) => p.name));
  const declaredLocals = collectDeclaredLocals(body.body); // source order
  const universe = new Set<string>([...paramNames, ...declaredLocals]);

  // `use[b]` is the **upward-exposed** reads (read before being defined within
  // the block); `def[b]` is the locals declared in the block. Walking the block
  // in order and killing a name at its declaration keeps a define-then-yield
  // local (e.g. `const doubled = i*2; yield doubled;`) out of `use[b]`, so its
  // liveness doesn't spuriously flow around a loop back-edge and promote it.
  const useSet: Set<string>[] = [];
  const defSet: Set<string>[] = [];
  for (const b of blocks) {
    const uses = new Set<string>();
    const defs = new Set<string>();
    const killed = new Set<string>();
    const addUpwardReads = (node: unknown): void => {
      const reads = new Set<string>();
      collectRefs(node, universe, reads);
      for (const r of reads) if (!killed.has(r)) uses.add(r);
    };
    for (const s of b.stmts) {
      addUpwardReads(s); // reads (a declarator's init, an assignment's operands)
      const declared = new Set<string>();
      collectDeclaredLocalsInto(s, declared);
      for (const d of declared) {
        defs.add(d);
        killed.add(d);
      }
    }
    // The terminator's reads run after every statement in the block.
    if (b.term.kind === "branch") addUpwardReads(b.term.cond);
    if (b.term.kind === "yield") addUpwardReads(b.term.value);
    if (b.term.kind === "yieldStar") addUpwardReads(b.term.iter);
    if (b.term.kind === "done" && b.term.value) addUpwardReads(b.term.value);
    useSet.push(uses);
    defSet.push(defs);
  }
  const succ = (b: GenBlock): number[] => {
    switch (b.term.kind) {
      case "goto":
        return [b.term.target];
      case "branch":
        return [b.term.then, b.term.else];
      case "yield":
        return [b.term.resume];
      case "yieldStar":
        return [b.term.resume];
      case "done":
        return [];
    }
  };

  const liveIn = blocks.map(() => new Set<string>());
  const liveOut = blocks.map(() => new Set<string>());
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const out = new Set<string>();
      for (const sc of succ(bat(i)))
        for (const v of liveIn[sc] as Set<string>) out.add(v);
      const inn = new Set(useSet[i]);
      const defs = defSet[i] as Set<string>;
      for (const v of out) if (!defs.has(v)) inn.add(v);
      if (
        !setEq(out, liveOut[i] as Set<string>) ||
        !setEq(inn, liveIn[i] as Set<string>)
      ) {
        liveOut[i] = out;
        liveIn[i] = inn;
        changed = true;
      }
    }
  }

  // A local live-out of any *yielding* block must survive suspend → a field.
  // Params are always fields (captured at construction).
  const fieldNames = new Set<string>(paramNames);
  for (const b of blocks) {
    // A `yield*` state can also suspend mid-delegation, so its live-out locals
    // must survive too (series 065).
    if (b.term.kind === "yield" || b.term.kind === "yieldStar") {
      for (const v of liveOut[b.id] as Set<string>) {
        if (declaredLocals.includes(v)) fieldNames.add(v);
      }
    }
  }

  // A read `yield*` completion binding (`const r = yield* inner()`, series 075) is
  // written in the delegating arm and read afterward — always a carried field, typed
  // by the delegate generator's declared `R`.
  const fieldTypes = new Map<string, RustType>();
  for (const b of blocks) {
    if (b.term.kind === "yieldStar" && b.term.resultTarget !== null) {
      fieldNames.add(b.term.resultTarget);
      const delegateRet = isGeneratorCall(b.term.iter, analysis)
        ? (analysis.generatorRetTypes.get(
            ((b.term.iter as CallExpression).callee as Identifier).name,
          ) ?? UNIT)
        : UNIT;
      fieldTypes.set(b.term.resultTarget, delegateRet);
    }
  }

  // A **read** yield result (`const x = yield e`, series 076) makes the generator
  // bidirectional. Its `TNext` (the 3rd `Generator<Y, R, TNext>` type arg) types
  // the resumed binding and the `resume(sent: TNext)` param; unannotated → fail-loud
  // (can't type `sent`). Each such binding is written in its resumed arm and read
  // afterward → a carried field.
  const bidirectional = blocks.some(
    (b) => b.term.kind === "yield" && b.term.resultTarget !== null,
  );
  const nextTy = analysis.generatorNextTypes.get(name) ?? null;
  if (bidirectional && !nextTy) {
    throw new UnsupportedError({
      type: "generator reads a `yield` result (`const x = yield e`) but declares no resume-in type — annotate `Generator<Y, R, TNext>` (fail-loud residual, series 076)",
    });
  }
  for (const b of blocks) {
    if (b.term.kind === "yield" && b.term.resultTarget !== null) {
      fieldNames.add(b.term.resultTarget);
      fieldTypes.set(b.term.resultTarget, nextTy as RustType);
    }
  }

  // ── Lower each block's leaf statements (field-aware `let` → assign) ─────────
  for (const p of params) fieldTypes.set(p.name, p.ty);

  const loweredBlocks = blocks.map((b) => {
    const out: HirStmt[] = [];
    for (const s of b.stmts) {
      for (const st of lowerStatement(s, analysis, name)) {
        // A field local's `let` becomes an assignment to `self.<field>` (the
        // field-ref rewrite below turns the bare target into `self.x`); its
        // declared type seeds the struct field.
        if (st.kind === "let" && !st.names && fieldNames.has(st.name)) {
          if (st.ty) fieldTypes.set(st.name, st.ty);
          out.push({
            kind: "expr",
            expr: {
              kind: "assign",
              op: "=",
              target: { kind: "ident", name: st.name },
              value: st.init,
            },
          });
        } else {
          out.push(st);
        }
      }
    }
    return out;
  });

  // A resumed arm of a **read** yield (`const x = yield e`, series 076) binds the
  // sent value to `x` at its head: `self.<x> = self.__sent.take().unwrap();`. `resume`
  // stashes `__sent` before the loop; the initial state (state 0) has no pending
  // yield, so the first-resume value is discarded (matching JS).
  const resumeBindings = new Map<number, string>();
  for (const b of blocks) {
    if (b.term.kind === "yield" && b.term.resultTarget !== null) {
      resumeBindings.set(b.term.resume, b.term.resultTarget);
    }
  }

  // ── Assemble the `match` arms (append each block's terminator) ──────────────
  const delegateFields: {
    name: string;
    steppable: boolean;
    delegateRet: RustType;
  }[] = [];
  const states = blocks.map((b) => {
    const arm: HirStmt[] = [...(loweredBlocks[b.id] as HirStmt[])];
    const sentBind = resumeBindings.get(b.id);
    if (sentBind !== undefined) {
      // Bind the sent value at the head of the resumed arm (field-ref rewritten
      // below to `self.<sentBind>`). `genResumeBind` takes the stashed `__sent`.
      arm.unshift({ kind: "genResumeBind", target: sentBind });
    }
    switch (b.term.kind) {
      case "goto":
        arm.push({ kind: "gotoState", state: b.term.target });
        break;
      case "branch":
        arm.push({
          kind: "if",
          cond: lowerExpr(b.term.cond, analysis),
          conseq: [{ kind: "gotoState", state: b.term.then }],
          alt: [{ kind: "gotoState", state: b.term.else }],
        });
        break;
      case "yield":
        arm.push({
          kind: "yieldReturn",
          value: lowerExpr(b.term.value, analysis),
          resumeState: b.term.resume,
        });
        break;
      case "yieldStar": {
        // `yield* <iter>` (065/075): a delegating state with its own boxed iterator
        // field. Unread (065): `<iter>.into_iter()` boxed as `dyn Iterator`, pumped
        // to exhaustion. Read completion (075, `const r = yield*`): the delegate must
        // be a known generator (its struct impls `Steppable`) — box the call directly
        // as `dyn Steppable` and pump `.step()`, binding the `Return` payload.
        const field = `__delegate_${b.id}`;
        const readResult = b.term.resultTarget !== null;
        if (readResult && !isGeneratorCall(b.term.iter, analysis)) {
          throw new UnsupportedError({
            type: "read `yield*` completion value over a non-generator iterable (no completion value exists — only a generator delegate carries one)",
          });
        }
        const delegateRet = readResult
          ? (analysis.generatorRetTypes.get(
              ((b.term.iter as CallExpression).callee as Identifier).name,
            ) ?? UNIT)
          : UNIT;
        delegateFields.push({ name: field, steppable: readResult, delegateRet });
        arm.push({
          kind: "yieldStarStep",
          field,
          iter: readResult
            ? lowerExpr(b.term.iter, analysis)
            : {
                kind: "method",
                receiver: lowerExpr(b.term.iter, analysis),
                name: "into_iter",
                args: [],
              },
          resumeState: b.term.resume,
          readResult: readResult || undefined,
          resultTarget: b.term.resultTarget ?? undefined,
        });
        break;
      }
      case "done":
        arm.push({
          kind: "genDone",
          terminal,
          retValue: b.term.value
            ? lowerExpr(b.term.value, analysis)
            : undefined,
          hasRet: hasReturnValue,
        });
        break;
    }
    return { id: b.id, body: rewriteFieldRefs(arm, fieldNames) };
  });

  const localFields = declaredLocals
    .filter((n) => fieldNames.has(n))
    .map((n) => ({
      name: n,
      ty: fieldTypes.get(n) ?? ({ kind: "f64" } as RustType),
    }));

  // A `TNext` is **defaultable** (series 076) when it carries the 066 undefined
  // model — i.e. lowers to `Option<T>` (default `None`, faithful to JS's `undefined`
  // sent by `for-of`/spread). Then the generator keeps `impl Iterator` / `step()`
  // (routed through `resume(<default>)`); a non-defaultable `TNext` is `resume`-only
  // (for-of / collect over it → fail-loud at the consumption site).
  const nextDefaultable = bidirectional && (nextTy as RustType).kind === "option";

  return {
    kind: "generator",
    name,
    structName: capitalizeAscii(name) + "Gen",
    item,
    retTy,
    exposesStep: analysis.steppedGenerators.has(name),
    hasReturnValue,
    params,
    localFields,
    states,
    terminal,
    delegateFields,
    bidirectional,
    nextTy: bidirectional ? (nextTy as RustType) : UNIT,
    nextDefaultable,
  };
}

/** `{ type: "ExpressionStatement", expression: e }` — wrap an expr as a stmt. */
function exprStmt(e: Expression): Statement {
  return { type: "ExpressionStatement", expression: e } as unknown as Statement;
}

/** A statement's contained statement list (`{ … }` body, or a single statement). */
function blockBody(s: Statement): Statement[] {
  return s.type === "BlockStatement"
    ? (s as BlockStatement).body
    : [s];
}

/** Does this subtree contain a `yield` (not descending into nested functions)? */
function containsYield(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as { type?: string };
  if (n.type === "YieldExpression") return true;
  if (
    n.type === "FunctionDeclaration" ||
    n.type === "FunctionExpression" ||
    n.type === "ArrowFunctionExpression"
  ) {
    return false; // an inner function's `yield` isn't ours
  }
  for (const key in node) {
    if (key === "type") continue;
    const v = (node as Record<string, unknown>)[key];
    if (Array.isArray(v)) {
      for (const el of v) if (containsYield(el)) return true;
    } else if (containsYield(v)) {
      return true;
    }
  }
  return false;
}

/** All local names declared (via `let`/`const`/`var`) anywhere in `stmts`, in
 * source order, deduped. Descends through control flow (not nested functions). */
function collectDeclaredLocals(stmts: Statement[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const set = new Set<string>();
  for (const s of stmts) collectDeclaredLocalsInto(s, set, order, seen);
  return order;
}

function collectDeclaredLocalsInto(
  node: unknown,
  out: Set<string>,
  order?: string[],
  seen?: Set<string>,
): void {
  if (!node || typeof node !== "object") return;
  const n = node as { type?: string };
  if (
    n.type === "FunctionDeclaration" ||
    n.type === "FunctionExpression" ||
    n.type === "ArrowFunctionExpression"
  ) {
    return;
  }
  if (n.type === "VariableDeclaration") {
    for (const d of (n as unknown as { declarations: { id: unknown }[] })
      .declarations) {
      const id = d.id as { type?: string; name?: string };
      if (id.type === "Identifier" && id.name) {
        out.add(id.name);
        if (order && seen && !seen.has(id.name)) {
          seen.add(id.name);
          order.push(id.name);
        }
      }
    }
  }
  for (const key in node) {
    if (key === "type") continue;
    const v = (node as Record<string, unknown>)[key];
    if (Array.isArray(v)) {
      for (const el of v) collectDeclaredLocalsInto(el, out, order, seen);
    } else {
      collectDeclaredLocalsInto(v, out, order, seen);
    }
  }
}

/** Collect identifier *reads* in `node` whose name is in `universe`. Skips
 * member property names (`o.f` — `f` is not a variable), a `VariableDeclarator`'s
 * binding `id` (a declaration is a write, not a read — only its `init` is read),
 * and nested functions. */
function collectRefs(
  node: unknown,
  universe: Set<string>,
  out: Set<string>,
): void {
  if (!node || typeof node !== "object") return;
  const n = node as { type?: string };
  if (n.type === "Identifier") {
    const nm = (n as { name?: string }).name;
    if (nm && universe.has(nm)) out.add(nm);
    return;
  }
  if (
    n.type === "FunctionDeclaration" ||
    n.type === "FunctionExpression" ||
    n.type === "ArrowFunctionExpression"
  ) {
    return;
  }
  if (n.type === "VariableDeclarator") {
    collectRefs((n as unknown as { init: unknown }).init, universe, out);
    return; // the binding `id` is a write, not a read
  }
  if (n.type === "MemberExpression") {
    const m = n as unknown as {
      object: unknown;
      property: unknown;
      computed: boolean;
    };
    collectRefs(m.object, universe, out);
    if (m.computed) collectRefs(m.property, universe, out); // `o[e]` reads `e`
    return; // a non-computed `.prop` name is not a variable read
  }
  for (const key in node) {
    if (key === "type") continue;
    const v = (node as Record<string, unknown>)[key];
    if (Array.isArray(v)) {
      for (const el of v) collectRefs(el, universe, out);
    } else {
      collectRefs(v, universe, out);
    }
  }
}

/** Rewrite every `{kind:"ident", name}` whose name is a field to `self.<name>`
 * (a struct-field access). A generic structural walk over the lowered HIR — it
 * never touches string field names, so struct-literal keys / method names are
 * safe; the introduced `self` ident is not a field, so no double-rewrite. */
function rewriteFieldRefs<T>(node: T, fields: Set<string>): T {
  if (Array.isArray(node)) {
    return node.map((n) => rewriteFieldRefs(n, fields)) as unknown as T;
  }
  if (node && typeof node === "object") {
    const obj = node as { kind?: string; name?: string };
    if (obj.kind === "ident" && obj.name && fields.has(obj.name)) {
      return {
        kind: "field",
        object: { kind: "ident", name: "self" },
        name: obj.name,
      } as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const key in node) {
      out[key] = rewriteFieldRefs(
        (node as Record<string, unknown>)[key],
        fields,
      );
    }
    return out as unknown as T;
  }
  return node;
}

/** Set equality (same size + every member of `a` in `b`). */
function setEq(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** Uppercase the first ASCII letter (`range` → `Range`) for a struct name. */
function capitalizeAscii(s: string): string {
  return s.length === 0 ? s : (s[0] as string).toUpperCase() + s.slice(1);
}

// ── Fallibility (throw / Result propagation) ─────────────────────────────────

/** The built-in single-message Error constructors, all erased to `Err(String)`. */
const ERROR_CLASSES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
]);

/**
 * Lower a `throw` to a `throw` HIR stmt (emitted as `return Err(<value>);`).
 * Three shapes map: `throw new <CustomClass>(message, …fields)` → the matching
 * `AppError::<Class>` struct variant (message first, then declared fields);
 * `throw new <BuiltinError>(message)` → `AppError::Other { message }` (the
 * built-in class distinction is erased); and a bare string literal `throw "msg"`
 * → `AppError::Other { message }`. Under the no-custom-class `String` error type
 * the message is carried bare (022 compat). A thrown variable/expression, an
 * unknown class, or any other value is fail-loud.
 */
function lowerThrow(
  stmt: ThrowStatement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt {
  const arg = stmt.argument;
  const hasAppError = analysis.errorClasses.size > 0;
  // In a `"use panic"` scope (028a) a throw aborts with its message; the class
  // (built-in or custom) is erased, exactly as under the `String` error type.
  const panic = analysis.panicScopes.has(scope);
  if (arg.type === "NewExpression") {
    const nw = arg as NewExpression;
    if (nw.callee.type !== "Identifier") {
      throw new UnsupportedError({
        type: "throw of a non-identifier constructor",
      });
    }
    const cname = (nw.callee as Identifier).name;
    const custom = analysis.errorClasses.get(cname);
    if (!custom && !ERROR_CLASSES.has(cname)) {
      throw new UnsupportedError({
        type: "throw of an unknown error class (declare it as `class X extends Error`)",
      });
    }
    const [message] = nw.arguments;
    if (!message) {
      throw new UnsupportedError({
        type: "throw new <Error>() must have at least a message argument",
      });
    }
    const msg = lowerExpr(message, analysis);
    if (panic) return { kind: "throw", value: msg, panic: true };
    if (custom) {
      // `throw new Foo(msg, a, b)` → `AppError::Foo { message: msg, f: a, g: b }`
      // (message first, then declared fields 1:1 with the remaining args).
      const rest = nw.arguments.slice(1);
      if (rest.length !== custom.fields.length) {
        throw new UnsupportedError({
          type: `throw new ${cname}() takes a message plus ${custom.fields.length} field argument(s)`,
        });
      }
      const fields = [
        { name: "message", value: msg },
        ...custom.fields.map((f, i) => ({
          name: f.name,
          value: lowerExpr(rest[i] as Expression, analysis),
        })),
      ];
      return {
        kind: "throw",
        value: { kind: "enumVariant", enumName: "AppError", variant: cname, fields },
      };
    }
    // A built-in `Error` throw → `AppError::Other { message }`, or the bare
    // `String` message under the no-custom-class program error type (022 compat).
    if (nw.arguments.length !== 1) {
      throw new UnsupportedError({
        type: "throw new Error() must have exactly one message argument",
      });
    }
    return { kind: "throw", value: otherOrMessage(msg, hasAppError) };
  }
  // `throw "literal"` — a bare string literal is thrown as its own message.
  if (arg.type === "Literal" && typeof (arg as Literal).value === "string") {
    const msg = lowerExpr(arg, analysis);
    if (panic) return { kind: "throw", value: msg, panic: true };
    return { kind: "throw", value: otherOrMessage(msg, hasAppError) };
  }
  throw new UnsupportedError({
    type: "throw of a non-Error, non-string-literal value",
  });
}

/**
 * A built-in `Error`/string throw's payload: under an `AppError` program error
 * type it constructs the catch-all `AppError::Other { message }` directly (no
 * `.into()` round-trip); under the `String` error type (no custom class) the
 * message is carried bare (022-no-custom compat).
 */
function otherOrMessage(msg: HirExpr, hasAppError: boolean): HirExpr {
  return hasAppError
    ? {
        kind: "enumVariant",
        enumName: "AppError",
        variant: "Other",
        fields: [{ name: "message", value: msg }],
      }
    : msg;
}

/**
 * Lower a `class X extends Error { field: T; …; constructor(message: string,
 * field: T, …) { super(message); this.field = field; … } }` to its `AppError`
 * variant shape `{ name, fields }` (series 049b). The recognized shape:
 *   - members are declared **data fields** (`field: T`) plus exactly one ctor;
 *     any method/getter/setter is fail-loud (ERR10);
 *   - the ctor's first param is the message; the remaining params map 1:1 to the
 *     declared fields, in declaration order;
 *   - the ctor body is `super(message);` followed by **identity** assignments
 *     `this.f = f;` (one per field, RHS the bare matching param ident) — a
 *     computed/reordered/defaulted/extra statement is fail-loud (ERR11).
 * `message` itself is implicit (always the variant's first field); the returned
 * `fields` are the *extra* declared data fields.
 */
function lowerErrorClass(
  decl: ClassDeclaration,
  structs: Set<string>,
): { name: string; fields: { name: string; ty: RustType }[] } {
  const name = decl.id?.name;
  if (!name) throw new UnsupportedError({ type: "anonymous error class" });
  const members = decl.body.body;

  // Declared data fields (`field: T`), in declaration order → variant fields.
  const props = members.filter(
    (m): m is PropertyDefinition => m.type === "PropertyDefinition",
  );
  const fields = props.map((f) => {
    if (f.static || f.computed) {
      throw new UnsupportedError({ type: "static/computed error-class field" });
    }
    if (!f.typeAnnotation) {
      throw new UnsupportedError({
        type: `error-class field '${f.key.name}' without a type`,
      });
    }
    return {
      name: f.key.name,
      ty: lowerType(f.typeAnnotation.typeAnnotation, structs),
    };
  });

  // Anything that is neither a data field nor the constructor is fail-loud
  // (methods, getters/setters — only typed data + the fixed ctor map).
  const extras = members.filter(
    (m) =>
      m.type !== "PropertyDefinition" &&
      !(m.type === "MethodDefinition" && m.kind === "constructor"),
  );
  if (extras.length > 0) {
    throw new UnsupportedError({
      type: "custom error class with a method/getter (only typed data fields are supported)",
    });
  }

  const ctors = members.filter(
    (m): m is MethodDefinition =>
      m.type === "MethodDefinition" && m.kind === "constructor",
  );
  const [ctorDef] = ctors;
  if (ctors.length !== 1 || !ctorDef) {
    throw new UnsupportedError({
      type: "custom error class must have exactly one constructor",
    });
  }
  const ctor = ctorDef.value;
  // First param is the message; the rest map 1:1 (in order) to the fields.
  if (ctor.params.length !== fields.length + 1) {
    throw new UnsupportedError({
      type: "custom error class constructor params must be (message, …fields) 1:1",
    });
  }
  const paramNames = (ctor.params as unknown as Identifier[]).map((p) => p.name);
  fields.forEach((f, i) => {
    if (paramNames[i + 1] !== f.name) {
      throw new UnsupportedError({
        type: `error-class constructor param '${paramNames[i + 1]}' must match field '${f.name}' (reordering unsupported)`,
      });
    }
  });

  // Body: `super(message);` then one identity `this.f = f;` per field, in order.
  const body = ctor.body?.body ?? [];
  if (body.length !== fields.length + 1) {
    throw new UnsupportedError({
      type: "error-class constructor body must be `super(message);` then one `this.f = f;` per field",
    });
  }
  const first = body[0];
  const isSuperCall =
    first?.type === "ExpressionStatement" &&
    (first as ExpressionStatement).expression.type === "CallExpression" &&
    ((first as ExpressionStatement).expression as CallExpression).callee.type ===
      "Super";
  if (!isSuperCall) {
    throw new UnsupportedError({
      type: "error-class constructor body must start with `super(message)`",
    });
  }
  fields.forEach((f, i) => {
    const stmt = body[i + 1];
    if (!isIdentityFieldAssign(stmt, f.name)) {
      throw new UnsupportedError({
        type: `error-class constructor must assign \`this.${f.name} = ${f.name};\` (computed/defaulted/reordered init unsupported)`,
      });
    }
  });

  return { name, fields };
}

/** Is `stmt` exactly `this.<field> = <field>;` (an identity assign of `field`)? */
function isIdentityFieldAssign(
  stmt: Statement | undefined,
  field: string,
): boolean {
  if (!stmt || stmt.type !== "ExpressionStatement") return false;
  const e = (stmt as ExpressionStatement).expression;
  if (e.type !== "AssignmentExpression") return false;
  const a = e as AssignmentExpression;
  if (a.operator !== "=") return false;
  const left = a.left;
  if (
    left.type !== "MemberExpression" ||
    (left as MemberExpression).computed ||
    (left as MemberExpression).object.type !== "ThisExpression" ||
    (left as MemberExpression).property.type !== "Identifier" ||
    ((left as MemberExpression).property as Identifier).name !== field
  ) {
    return false;
  }
  // RHS must be the bare matching param identifier — no `.trim()`, no default.
  return a.right.type === "Identifier" && (a.right as Identifier).name === field;
}

/**
 * Lower a `try`/`catch`/`finally` to a `tryCatch` HIR node (an `if let Err` over
 * a `Result`-returning IIFE closure). Statement-level recovery only: a `catch`
 * handler is required, and neither the `try` nor the `catch` body may `return` /
 * `break` / `continue` past the closure (value-yielding `try`/`catch` is
 * deferred). A `finally` runs after; a re-`throw` in `catch` alongside a
 * `finally` is rejected (the trailing `finally` would be skipped). The `try`
 * body is `makeFallible`-wrapped so its fallible calls/`throw`s get the closure's
 * `Ok(())` tail (there are no returns to wrap — they're rejected).
 */
function lowerTry(
  stmt: TryStatement,
  analysis: ModuleAnalysis,
  scope: string,
): HirStmt {
  const rawTry = lowerStatements(stmt.block.body, analysis, scope);
  const finallyBody = stmt.finalizer
    ? lowerStatements(stmt.finalizer.body, analysis, scope)
    : null;
  const errTy = programErrType(analysis);

  // A `try` body that `await`s (e.g. `try { await fsAsync.readFile(p) } catch`)
  // is fail-loud: recovery lowers to a **sync** `Result`-returning IIFE closure,
  // which cannot host an `.await`. Async error-recovery (an `async` recovery
  // closure) is a separate slice — reject rather than emit a closure that will
  // not compile. The sync fallible catch (IO7) is unaffected.
  if (hirHasAwait(rawTry)) {
    throw new UnsupportedError({
      type: "await inside a try/catch is not yet supported (async error recovery is a later slice — await outside the try, or handle the error via the propagated Result)",
    });
  }

  // `try`/`finally` with no `catch` handler (series 063, graduated): a labeled
  // block captures the `Result`, `finally` runs on both paths, then an error
  // propagates. `finally` + an escaping jump stays fail-loud (carrier-enum
  // follow-on). A bare `try` (no catch, no finally) is meaningless → fail-loud.
  if (!stmt.handler) {
    if (!finallyBody) {
      throw new UnsupportedError({ type: "try without a catch or finally" });
    }
    if (escapesClosure(rawTry, false)) {
      // series 073: a `finally` combined with an escaping jump lowers to a control
      // carrier — the `finally` runs before the escape is replayed.
      return buildCarrierTry(
        rawTry,
        null,
        null,
        finallyBody,
        analysis,
        scope,
        errTy,
      );
    }
    if (!analysis.fallible.has(scope)) {
      throw new UnsupportedError({
        type: "try/finally in a non-fallible scope (nothing to recover — a later slice)",
      });
    }
    const label = `try_${analysis.tryCounter++}`;
    return {
      kind: "tryBlock",
      label,
      tryBody: rewriteTryBreaks(rawTry.map(wrapReturns), label),
      catchParam: null,
      catchBody: null,
      finallyBody,
      errTy,
    };
  }

  const catchBody = lowerStatements(stmt.handler.body.body, analysis, scope);
  // A `try`/`catch` whose `try` or `catch` natively `return`s / `break`s /
  // `continue`s (value-yielding / escaping, series 063) → a labeled-block lowering
  // (native escapes work; the IIFE closure would swallow them). `finally` + escape
  // is fail-loud (carrier-enum follow-on).
  const catchParamName = stmt.handler.param ? stmt.handler.param.name : null;
  if (escapesClosure(rawTry, false) || escapesClosure(catchBody, false)) {
    if (finallyBody) {
      // series 073: finally + an escaping jump in try/catch → the control carrier
      // (the `finally` runs once, before the escape is replayed).
      return buildCarrierTry(
        rawTry,
        catchParamName,
        catchBody,
        finallyBody,
        analysis,
        scope,
        errTy,
        stmt.handler.body.body,
      );
    }
    // A `catch` that fully handles the error may leave the fn *non*-fallible (the
    // error never propagates), so returns are `Ok`-wrapped only when the enclosing
    // scope is fallible. The labeled block still carries `Result<(), E>` internally.
    const wrap = analysis.fallible.has(scope)
      ? (ss: HirStmt[]) => ss.map(wrapReturns)
      : (ss: HirStmt[]) => ss;
    const label = `try_${analysis.tryCounter++}`;
    // A discriminating `instanceof` ladder catch (049c) → native `match` arms over
    // the owned error, with each arm's returns `Ok`-wrapped iff the scope is
    // fallible (series 063 extends the ladder to escaping/value-yielding catches).
    const discriminant =
      catchParamName && analysis.errorClasses.size > 0
        ? recognizeDiscriminant(
            stmt.handler.body.body,
            catchParamName,
            analysis,
            scope,
          )
        : undefined;
    const wrappedDiscriminant = discriminant?.map((arm) => ({
      ...arm,
      body: wrap(arm.body),
    }));
    return {
      kind: "tryBlock",
      label,
      tryBody: rewriteTryBreaks(wrap(rawTry), label),
      catchParam: catchParamName,
      catchBody: wrap(catchBody),
      finallyBody: null,
      errTy,
      discriminant: wrappedDiscriminant,
      // When the try body always diverges (value-yield: it `return`s on the
      // success path), the `Ok(_)` match arm is unreachable → `unreachable!()`.
      okUnreachable: divergesFully(rawTry),
    };
  }
  if (finallyBody && hirHasThrowOrTry(catchBody)) {
    throw new UnsupportedError({
      type: "re-throw inside catch alongside a finally (deferred)",
    });
  }
  // Series 049c: recognize an `instanceof` ladder catch body → a native `match`
  // over the owned bound error (no `downcast_ref`). Non-ladder catches keep the
  // opaque bind. The `escapesClosure` gate above already rejected a per-branch
  // `return` (the #16 boundary), so a recognized ladder is statement-level only.
  const discriminant =
    catchParamName && analysis.errorClasses.size > 0
      ? recognizeDiscriminant(
          stmt.handler.body.body,
          catchParamName,
          analysis,
          scope,
        )
      : undefined;
  return {
    kind: "tryCatch",
    tryBody: makeFallible(rawTry, UNIT),
    catchParam: catchParamName,
    catchBody,
    finallyBody,
    errTy,
    discriminant,
  };
}

/**
 * Build a 073 `carrierTry` node for a `finally` combined with an escaping jump.
 * The `try` (and `catch`) arms are rewritten so each escape records its intent and
 * breaks to the wrapper label (`return v` → `Ctrl::Return(v)`, `break L`/`continue
 * L` → `Ctrl::Break/Continue(target)`, `throw`/`?` → `Ctrl::Err`); the `finally`
 * runs natively before the dispatch replays the recorded escape. `catchAst` is the
 * raw catch handler body (for `instanceof`-ladder recognition), `null` for a
 * `try`/`finally` with no handler.
 */
function buildCarrierTry(
  rawTry: HirStmt[],
  catchParamName: string | null,
  catchBody: HirStmt[] | null,
  finallyBody: HirStmt[],
  analysis: ModuleAnalysis,
  scope: string,
  errTy: RustType,
  catchAst?: Statement[],
): HirStmt {
  const label = `ctrl_${analysis.tryCounter++}`;
  const fallible = analysis.fallible.has(scope);
  const retTy = carrierReturnType(analysis, scope);

  const collector: CarrierEscapes = {
    hasReturn: false,
    hasCarrierErr: false,
    breakTargets: [],
    continueTargets: [],
  };
  // The `try` arm's escapes always feed the carrier (`'<label>`). Its `?`/`throw`
  // feed the carrier `Err` directly when there is *no* handler; with a handler,
  // they route to an inner `'try_N` block (bare `Err`) so the `catch` sees them.
  const innerTryLabel =
    catchBody === null ? null : `try_${analysis.tryCounter++}`;
  const tryErrLabel = innerTryLabel ?? label;
  const tryBody = rewriteCarrierArm(rawTry, {
    carrierLabel: label,
    errLabel: tryErrLabel,
    carrierErr: innerTryLabel === null,
    insideLoop: false,
    esc: collector,
  });
  // The `catch` arm's escapes *and* its `?`/`throw` (a rethrow alongside finally)
  // both feed the carrier.
  const catchOpts = {
    carrierLabel: label,
    errLabel: label,
    carrierErr: true,
    insideLoop: false,
    esc: collector,
  } as const;
  const loweredCatch =
    catchBody === null ? null : rewriteCarrierArm(catchBody, catchOpts);

  // A discriminating `instanceof` ladder catch (049c) lowers to native `match`
  // arms; its arm bodies carry escapes too, so rewrite them into the carrier.
  const discriminant =
    catchAst && catchParamName && analysis.errorClasses.size > 0
      ? recognizeDiscriminant(catchAst, catchParamName, analysis, scope)?.map(
          (arm) => ({
            ...arm,
            body: rewriteCarrierArm(arm.body, catchOpts),
          }),
        )
      : undefined;

  return {
    kind: "carrierTry",
    label,
    innerTryLabel,
    tryBody,
    catchParam: catchParamName,
    catchBody: loweredCatch,
    finallyBody,
    errTy,
    retTy,
    fallible,
    hasReturn: collector.hasReturn,
    // The `Ctrl::Err` variant / dispatch arm exists only when an error escapes the
    // whole construct to the fn's `Result` — a carrier-level error in a *fallible*
    // scope. A `catch` that fully handles the error leaves the scope non-fallible,
    // so no `Err` propagates (and `return Err(..)` would not type-check).
    hasErr: fallible && collector.hasCarrierErr,
    breakTargets: collector.breakTargets,
    continueTargets: collector.continueTargets,
    // The wrapper falls through to `Ctrl::Normal` when a path can complete normally:
    // the `try` completes (no handler / Ok path) or the `catch`/ladder arm does. If
    // every path escapes, the fall-through is unreachable and `Normal` is elided.
    tryFallsThrough:
      !divergesFully(tryBody) ||
      (loweredCatch !== null && !divergesFully(loweredCatch)) ||
      (discriminant?.some((arm) => !divergesFully(arm.body)) ?? false),
    // When the `finally` body itself unconditionally escapes, the native `finally`
    // pre-empts the carrier and the dispatch is dead code — suppress it.
    dispatchDead: divergesFully(finallyBody),
    discriminant,
  };
}

/** The enclosing fn's return **inner** type (the `Ctrl::Return(V)` payload). */
function carrierReturnType(analysis: ModuleAnalysis, scope: string): RustType {
  const retAnn = analysis.fns.get(scope)?.retAnn;
  if (!retAnn) {
    throw new UnsupportedError({
      type: "finally + escape in a scope without a return-type annotation (carrier needs the return type)",
    });
  }
  return lowerType(retAnn, analysis.structs);
}

/** Distinct escape targets accumulated while rewriting the carrier arms. */
interface CarrierEscapes {
  hasReturn: boolean;
  /** A carrier-level error (`Ctrl::Err`) can escape the whole construct. */
  hasCarrierErr: boolean;
  breakTargets: (string | null)[];
  continueTargets: (string | null)[];
}

/**
 * Options for rewriting one carrier arm. `carrierLabel` is the wrapper block an
 * escape (`return`/`break`/`continue`) records into; `errLabel` is the block a
 * `?`/`throw` breaks (the carrier itself for the no-handler / catch arms →
 * `Ctrl::Err`; or an inner `'try` block for a `try` arm *with* a handler →
 * bare `Err`, so the `catch` sees it), selected by `carrierErr`.
 */
interface CarrierOpts {
  carrierLabel: string;
  errLabel: string;
  carrierErr: boolean;
  insideLoop: boolean;
  esc: CarrierEscapes;
}

/**
 * Rewrite one carrier arm (`try` or `catch`) so each escape that would leave the
 * `try`/`catch` records its intent into the carrier and breaks to the wrapper:
 *   - `return v` → `break '<carrier> Ctrl::Return(v)` (`return;` carries `null`);
 *   - `break L`/`continue L` (not bound by a loop nested *inside* the arm) →
 *     `break '<carrier> Ctrl::Break/Continue(target)`, `target` the label or `null`
 *     for the nearest enclosing loop;
 *   - `throw e`/`?` → `errLabel` (carrier `Err`, or the inner `'try` bare `Err`).
 * A `break`/`continue` under a nested loop is that loop's own concern — left
 * native (mirrors `escapesClosure`'s `insideLoop`). Descent stops at a nested
 * `carrierTry`/`tryBlock`/`tryCatch`/`closure`/generator boundary.
 */
function rewriteCarrierArm(stmts: HirStmt[], opts: CarrierOpts): HirStmt[] {
  return stmts.map((s) => rewriteCarrierStmt(s, opts));
}

function rewriteCarrierStmt(s: HirStmt, opts: CarrierOpts): HirStmt {
  const { carrierLabel: label, errLabel, carrierErr, insideLoop, esc } = opts;
  const inner = (loop: boolean): CarrierOpts =>
    loop === insideLoop ? opts : { ...opts, insideLoop: loop };
  switch (s.kind) {
    case "return":
      esc.hasReturn = true;
      // A fallible call in the returned value (`return f()` where `f` throws) must
      // record the error into the carrier (running `finally`), not `?`-propagate
      // past it — retarget its `?`/`throw` before wrapping in `Ctrl::Return`.
      if (carrierErr && s.value && hirHasThrowOrTry(s.value))
        esc.hasCarrierErr = true;
      return {
        kind: "carrierBreak",
        label,
        ctrl: "Return",
        value: s.value ? rewriteTryBreaks(s.value, errLabel, carrierErr) : null,
      };
    case "break":
      if (insideLoop) return s; // bound by a loop nested in the arm — native
      addTarget(esc.breakTargets, s.label ?? null);
      return { kind: "carrierBreak", label, ctrl: "Break", target: s.label ?? null };
    case "continue":
      if (insideLoop) return s;
      addTarget(esc.continueTargets, s.label ?? null);
      return {
        kind: "carrierBreak",
        label,
        ctrl: "Continue",
        target: s.label ?? null,
      };
    case "throw":
      // A non-panic `throw` records the error (carrier `Err`, or the inner `'try`
      // bare `Err`); a `"use panic"` throw is a real abort (untouched).
      if (s.panic) return s;
      if (carrierErr) esc.hasCarrierErr = true; // an error escapes → Ctrl::Err
      return carrierErr
        ? { kind: "carrierErr", label: errLabel, value: s.value }
        : { kind: "breakTry", label: errLabel, value: s.value };
    case "if":
      return {
        kind: "if",
        cond: s.cond,
        conseq: rewriteCarrierArm(s.conseq, opts),
        alt: s.alt ? rewriteCarrierArm(s.alt, opts) : null,
      };
    case "block":
      return { ...s, body: rewriteCarrierArm(s.body, opts) };
    case "match":
      return {
        kind: "match",
        disc: s.disc,
        arms: s.arms.map((a) => ({ ...a, body: rewriteCarrierArm(a.body, opts) })),
      };
    case "while":
    case "forIn":
    case "forRange":
      return { ...s, body: rewriteCarrierArm(s.body, inner(true)) };
    case "ifLet":
      return {
        ...s,
        someBody: rewriteCarrierArm(s.someBody, opts),
        noneBody: s.noneBody ? rewriteCarrierArm(s.noneBody, opts) : null,
      };
    case "carrierTry": {
      // A nested carrier (series 073): its dispatch replays escapes into *this*
      // (outer) carrier so the outer `finally` runs. Redirect its dispatch to the
      // outer wrapper and fold its escape targets into the outer collector. Its own
      // arms already carrier-encode against its own label — untouched. A nested
      // break/continue under a loop nested in this arm stays that loop's concern.
      if (s.hasReturn) esc.hasReturn = true;
      // An inner carrier whose dispatch can re-record `Ctrl::Err` into this outer
      // carrier needs the outer `Err` variant too.
      if (s.hasErr) esc.hasCarrierErr = true;
      if (!insideLoop) {
        s.breakTargets.forEach((t) => addTarget(esc.breakTargets, t));
        s.continueTargets.forEach((t) => addTarget(esc.continueTargets, t));
      }
      // The nested `finally` runs natively and may itself escape — carrier-encode it.
      return {
        ...s,
        outerLabel: label,
        finallyBody: rewriteCarrierArm(s.finallyBody, opts),
      };
    }
    default:
      // `let`/`expr`/`?`/nested try/closure/generator — the `?`/`throw` inside are
      // retargeted (carrier `Err` or inner `'try` bare `Err`) by `rewriteTryBreaks`;
      // a nested try/closure boundary is left to itself there. `carrierBreak`
      // can't appear yet (rewrite runs once).
      if (carrierErr && hirHasThrowOrTry(s)) esc.hasCarrierErr = true;
      return rewriteTryBreaks(s, errLabel, carrierErr);
  }
}

/** Add a distinct escape target (label string, or `null` for the nearest loop). */
function addTarget(targets: (string | null)[], target: string | null): void {
  if (!targets.some((t) => t === target)) targets.push(target);
}

/**
 * Rewrite a `tryBlock`'s `try` body (series 063): each `?` (`{kind:"try"}`) becomes
 * a `tryBreak` (`match … Err => break '<label>`), and each non-panic `throw` becomes
 * a `breakTry` (`break '<label> Err(…)`). Native `return`/`break`/`continue` are
 * left untouched — a labeled block is not a function boundary, so they escape the
 * enclosing fn/loop. Descent stops at a nested `tryCatch`/`tryBlock` (its `?`/throw
 * belong to its own label) and at an inline `closure` (its own boundary).
 *
 * `carrier` (series 073) retargets the error break to `Ctrl::Err(…)` — the `?`
 * becomes `tryBreak{carrier}` and the `throw` becomes `carrierErr` — so a carrier
 * arm's fallible ops feed the control carrier instead of a bare `Err`.
 */
function rewriteTryBreaks<T>(node: T, label: string, carrier = false): T {
  if (Array.isArray(node)) {
    return node.map((n) => rewriteTryBreaks(n, label, carrier)) as unknown as T;
  }
  if (node && typeof node === "object") {
    const kind = (node as { kind?: string }).kind;
    if (
      kind === "tryCatch" ||
      kind === "tryBlock" ||
      kind === "carrierTry" ||
      kind === "closure"
    ) {
      return node;
    }
    if (kind === "try") {
      return {
        kind: "tryBreak",
        label,
        expr: rewriteTryBreaks(
          (node as unknown as { expr: unknown }).expr,
          label,
          carrier,
        ),
        ...(carrier ? { carrier: true } : {}),
      } as unknown as T;
    }
    if (kind === "throw" && !(node as { panic?: boolean }).panic) {
      const value = rewriteTryBreaks(
        (node as unknown as { value: unknown }).value,
        label,
        carrier,
      );
      return (
        carrier
          ? { kind: "carrierErr", label, value }
          : { kind: "breakTry", label, value }
      ) as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const key in node) {
      out[key] = rewriteTryBreaks(
        (node as Record<string, unknown>)[key],
        label,
        carrier,
      );
    }
    return out as unknown as T;
  }
  return node;
}

/**
 * Recognize a discriminating `instanceof` ladder catch body (series 049c) and
 * lower it to `match` arms over the owned bound error. The body must be a single
 * `if`/`else if`/…/`else` chain whose every non-final test is `<catchParam>
 * instanceof <CustomClass>` (a *declared* error class). Returns the arms, or
 * `undefined` when the body is not that shape (the opaque bind is kept — ERR16).
 *   - each `instanceof Foo` branch → `AppError::Foo { <read fields>, .. }`, with
 *     `e.field` reads rewritten to the owned bound `field`;
 *   - a trailing `else` → the wildcard `other => …` (binds the whole error);
 *   - no trailing `else` → an appended `_ => {}` (exhaustiveness; JS swallows
 *     non-matching errors, ERR15).
 * An `instanceof` on a *built-in* error class is fail-loud (no variant to match).
 */
function recognizeDiscriminant(
  body: Statement[],
  catchParam: string,
  analysis: ModuleAnalysis,
  scope: string,
): HirCatchArm[] | undefined {
  if (body.length !== 1 || body[0]?.type !== "IfStatement") return undefined;
  const arms: HirCatchArm[] = [];
  let node: Statement | null = body[0] as IfStatement;
  while (node && node.type === "IfStatement") {
    const iff = node as IfStatement;
    const cls = instanceofTest(iff.test, catchParam);
    if (cls === null) return undefined; // not an `e instanceof X` test → opaque
    if (!analysis.errorClasses.has(cls)) {
      if (ERROR_CLASSES.has(cls)) {
        throw new UnsupportedError({
          type: `\`instanceof ${cls}\` in a catch — built-in error throws collapse into Other (no variant to match)`,
        });
      }
      return undefined; // an unknown class — not a recognized ladder
    }
    // Fields of `cls` read as `e.field` in this branch bind owned; rewrite the
    // reads to the bound `field` ident before lowering the branch body.
    const read = collectFieldReads(iff.consequent, catchParam, analysis, cls);
    const conseq = rewriteFieldReads(iff.consequent, catchParam, read);
    arms.push({
      kind: "variant",
      variant: cls,
      binds: read,
      body: lowerBlock(conseq, analysis, scope),
    });
    node = iff.alternate;
  }
  // A trailing `else { … }` → the `other` wildcard (binds the whole error);
  // no `else` → an appended `_ => {}` for exhaustiveness (JS swallow parity).
  if (node) {
    arms.push({
      kind: "wildcard",
      binder: "other",
      body: lowerBlock(node, analysis, scope),
    });
  } else {
    arms.push({ kind: "wildcard", binder: null, body: [] });
  }
  return arms;
}

/** `<catchParam> instanceof <Class>` → the class name, else `null`. */
function instanceofTest(test: Expression, catchParam: string): string | null {
  if (test.type !== "BinaryExpression") return null;
  const b = test as { operator: string; left: Expression; right: Expression };
  if (b.operator !== "instanceof") return null;
  if (b.left.type !== "Identifier" || (b.left as Identifier).name !== catchParam) {
    return null;
  }
  if (b.right.type !== "Identifier") return null;
  return (b.right as Identifier).name;
}

/**
 * Collect the declared field names of `cls` that the branch reads as
 * `<catchParam>.<field>` (so the match arm binds each owned). `message` is a
 * valid field too. Order follows the variant's field order for stable output.
 */
function collectFieldReads(
  branch: Statement,
  catchParam: string,
  analysis: ModuleAnalysis,
  cls: string,
): string[] {
  const shape = analysis.errorClasses.get(cls);
  const candidates = ["message", ...(shape?.fields.map((f) => f.name) ?? [])];
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isAstNode(node)) return;
    if (node.type === "MemberExpression") {
      const m = node as unknown as MemberExpression;
      if (
        !m.computed &&
        m.object.type === "Identifier" &&
        (m.object as Identifier).name === catchParam &&
        m.property.type === "Identifier"
      ) {
        found.add((m.property as Identifier).name);
      }
    }
    for (const key in node) {
      if (key === "type") continue;
      walk((node as Record<string, unknown>)[key]);
    }
  };
  walk(branch);
  return candidates.filter((c) => found.has(c));
}

/**
 * Rewrite each `<catchParam>.<field>` member access (for a field in `binds`) to a
 * bare `<field>` identifier, so a lowered branch reads the match-arm-bound owned
 * field. A structural clone — the source AST is untouched.
 */
function rewriteFieldReads<T>(node: T, catchParam: string, binds: string[]): T {
  if (Array.isArray(node)) {
    return node.map((n) => rewriteFieldReads(n, catchParam, binds)) as unknown as T;
  }
  if (!isAstNode(node)) return node;
  const n = node as unknown as MemberExpression;
  if (
    n.type === "MemberExpression" &&
    !n.computed &&
    n.object.type === "Identifier" &&
    (n.object as Identifier).name === catchParam &&
    n.property.type === "Identifier" &&
    binds.includes((n.property as Identifier).name)
  ) {
    return {
      type: "Identifier",
      name: (n.property as Identifier).name,
      start: n.start,
      end: n.end,
    } as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const key in node as Record<string, unknown>) {
    out[key] = rewriteFieldReads(
      (node as Record<string, unknown>)[key],
      catchParam,
      binds,
    );
  }
  return out as T;
}

/**
 * Does a statement list contain a control-flow jump that would escape the `try`
 * IIFE closure? A `return` anywhere escapes it; a `break`/`continue` escapes only
 * when it is *not* bound by a loop nested inside the try (`insideLoop`). Descends
 * `if`/`block`/`match` and into loops (to catch a `return` there), but a
 * `break`/`continue` under a nested loop is that loop's own concern.
 */
function escapesClosure(stmts: HirStmt[], insideLoop: boolean): boolean {
  for (const s of stmts) {
    switch (s.kind) {
      case "return":
        return true;
      case "break":
      case "continue":
        if (!insideLoop) return true;
        break;
      case "if":
        if (escapesClosure(s.conseq, insideLoop)) return true;
        if (s.alt && escapesClosure(s.alt, insideLoop)) return true;
        break;
      case "block":
        if (escapesClosure(s.body, insideLoop)) return true;
        break;
      case "match":
        for (const arm of s.arms)
          if (escapesClosure(arm.body, insideLoop)) return true;
        break;
      case "while":
      case "forIn":
      case "forRange":
        if (escapesClosure(s.body, true)) return true;
        break;
      case "carrierTry":
        // A nested 073 carrier's dispatch replays its escape *in this context* — a
        // `Return` re-escapes, and a `Break`/`Continue` re-escapes unless bound by a
        // loop nested here. Its `finally` runs natively too, so a self-escaping
        // `finally` escapes as well.
        if (s.hasReturn) return true;
        if (!insideLoop && (s.breakTargets.length > 0 || s.continueTargets.length > 0))
          return true;
        if (escapesClosure(s.finallyBody, insideLoop)) return true;
        break;
    }
  }
  return false;
}

/**
 * Rewrite a fallible function's body so every normal `return v` yields `Ok(v)`
 * (and `return;` → `Ok(())`), leaving `throw`s to emit `Err`. A `void` body that
 * can fall through the end gets a trailing `return Ok(());` — the non-throwing
 * path must still produce `Ok`. `throw`s are untouched here (the emitter renders
 * them as `return Err`).
 */
function makeFallible(stmts: HirStmt[], okTy: RustType): HirStmt[] {
  const wrapped = stmts.map(wrapReturns);
  if (okTy.kind === "unit" && !diverges(wrapped)) {
    wrapped.push({ kind: "return", value: { kind: "ok", value: null } });
  }
  return wrapped;
}

/** Recursively wrap each `return v` in `Ok`, descending into control-flow bodies. */
function wrapReturns(stmt: HirStmt): HirStmt {
  switch (stmt.kind) {
    case "return":
      return { kind: "return", value: { kind: "ok", value: stmt.value } };
    case "if":
      return {
        kind: "if",
        cond: stmt.cond,
        conseq: stmt.conseq.map(wrapReturns),
        alt: stmt.alt ? stmt.alt.map(wrapReturns) : null,
      };
    case "while":
      return {
        kind: "while",
        cond: stmt.cond,
        body: stmt.body.map(wrapReturns),
      };
    case "block":
      return { kind: "block", body: stmt.body.map(wrapReturns) };
    case "forIn":
      return { ...stmt, body: stmt.body.map(wrapReturns) };
    case "match":
      return {
        kind: "match",
        disc: stmt.disc,
        arms: stmt.arms.map((a) => ({
          guard: a.guard,
          body: a.body.map(wrapReturns),
        })),
      };
    default:
      // `let`/`expr`/`throw`/`break`/`continue` carry no return to wrap.
      return stmt;
  }
}

/** Does a statement list definitely diverge (its last statement returns/throws)? */
function diverges(stmts: HirStmt[]): boolean {
  const last = stmts[stmts.length - 1];
  if (!last) return false;
  if (last.kind === "return" || last.kind === "throw") return true;
  // series 073: a `carrierTry` whose dispatch always escapes (`return`/`throw` or a
  // self-escaping `finally`) diverges — no fall-through past it.
  if (last.kind === "carrierTry") return last.dispatchDead || !last.tryFallsThrough;
  if (last.kind === "if" && last.alt) {
    return diverges(last.conseq) && diverges(last.alt);
  }
  if (last.kind === "block") return diverges(last.body);
  return false;
}

/**
 * Does a statement list always diverge (its last statement `return`s / `throw`s /
 * `break`s / `continue`s on every path)? A superset of `diverges` used to decide
 * whether a `tryBlock`'s normal-completion `Ok(_)` arm is reachable (series 063).
 */
function divergesFully(stmts: HirStmt[]): boolean {
  const last = stmts[stmts.length - 1];
  if (!last) return false;
  if (
    last.kind === "return" ||
    last.kind === "throw" ||
    last.kind === "break" ||
    last.kind === "continue" ||
    last.kind === "breakTry" ||
    // series 073: a carrier escape (`break '<label> Ctrl::…`) diverges the block.
    last.kind === "carrierBreak" ||
    last.kind === "carrierErr"
  ) {
    return true;
  }
  // series 073: a whole `carrierTry` diverges when its dispatch always escapes —
  // the `try` can't fall through (no `Ctrl::Normal` arm) or a self-escaping
  // `finally` pre-empted the dispatch entirely.
  if (last.kind === "carrierTry") return last.dispatchDead || !last.tryFallsThrough;
  if (last.kind === "if" && last.alt) {
    return divergesFully(last.conseq) && divergesFully(last.alt);
  }
  if (last.kind === "block") return divergesFully(last.body);
  return false;
}

/** Does a lowered HIR subtree contain a `throw` stmt or a `try` (`?`) expr? */
function hirHasThrowOrTry(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hirHasThrowOrTry);
  if (node === null || typeof node !== "object") return false;
  const kind = (node as { kind?: string }).kind;
  if (kind === "throw" || kind === "try") return true;
  return Object.values(node).some(hirHasThrowOrTry);
}

/**
 * Does a lowered HIR subtree contain an `await`? Used on the generated `main` to
 * decide `#[tokio::main]`. Nested functions are separate `items`, so walking
 * `main` sees exactly script-scope awaits.
 */
function hirHasAwait(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hirHasAwait);
  if (node === null || typeof node !== "object") return false;
  if ((node as { kind?: string }).kind === "await") return true;
  return Object.values(node).some(hirHasAwait);
}

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
function interfaceMethodSigs(
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

function lowerInterface(
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
 * Lower `enum E { A, B = 1 }` to a `HirEnum` (a C-like Rust enum). Variants must
 * be plain identifiers; an initializer, if present, must be an integer literal
 * (an explicit discriminant). `const enum` (compile-time inlining) and
 * string-valued members are rejected — each a later slice.
 */
function lowerEnum(decl: TSEnumDeclaration): HirEnum {
  if (decl.const) {
    throw new UnsupportedError({
      type: "`const enum` (compile-time inlining)",
    });
  }
  const variants = decl.body.members.map((m) => {
    if (m.computed || m.id.type !== "Identifier") {
      throw new UnsupportedError({ type: "computed enum member" });
    }
    let disc: number | null = null;
    if (m.initializer) {
      const init = m.initializer;
      if (
        init.type !== "Literal" ||
        typeof (init as Literal).value !== "number"
      ) {
        throw new UnsupportedError({
          type: "enum member initializer must be an integer literal (string enums unsupported)",
        });
      }
      const v = (init as Literal).value as number;
      if (!Number.isInteger(v)) {
        throw new UnsupportedError({
          type: "enum member with a fractional discriminant",
        });
      }
      disc = v;
    }
    return { name: m.id.name, disc };
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
function lowerClass(
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
function traitNameOf(baseName: string): string {
  return `I${baseName}`;
}

/**
 * Rewrite base-typed params to `impl IA` (series 053b, INH10) and record each as
 * a `dyn` binding, so a `.method()` in the body dispatches through the trait and
 * a base-`.field` read routes through an accessor. A param whose (possibly
 * borrowed) type names an extended base class is monomorphic static dispatch.
 */
function applyBaseParamTraits(
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
function synthesizeTraits(
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
function synthesizeInterfaceTraits(
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
function isHeterogeneous(
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
function rootBaseOf(name: string, analysis: ModuleAnalysis): string {
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

/**
 * The resolved `Map`/`Set` (or `Record`) `RustType` of a member receiver, or
 * null. Series 061 routes `Map`/`Set` methods and record query ops by the
 * receiver's binding type; only a plain identifier binding is resolved today
 * (a `this.field` map is a later slice).
 */
function collectionOf(
  obj: Expression,
  analysis: ModuleAnalysis,
): RustType | null {
  // A thin filter over the unified `receiverTypeOf` (series 083): return the type
  // only when it is a Map/Set. `receiverTypeOf`'s tiers are identical to the
  // pre-083 `collectionOf` body (identifier→bindingTypes, member→structFields,
  // else→oracle), so every receiver this already resolved is byte-for-byte
  // unchanged. NOTE: Tier-2 (structFields) now also resolves a `this.field`
  // Map/Set — previously only the oracle did; both yield the same `RustType`, so
  // no behavior change (and the oracle stays the fallback when structFields miss).
  const t = receiverTypeOf(obj, analysis);
  return t && (t.kind === "hashmap" || t.kind === "set") ? t : null;
}

/** `&expr` — an explicit shared borrow at a call site (series 061). */
function refExpr(expr: HirExpr): HirExpr {
  return { kind: "ref", mut: false, expr };
}

/**
 * Wrap a `Map` key / `Set` element for its Rust key type: a scalar `number` key
 * becomes `OrderedFloat(k)` (series 061); an f64-bearing struct key becomes
 * `<Struct>Key(k)` (series 074, the SameValueZero newtype); every other key is
 * passed through.
 */
function wrapKey(expr: HirExpr, keyTy: RustType, forLookup = false): HirExpr {
  if (keyTy.kind === "orderedFloat") {
    return { kind: "call", callee: "OrderedFloat", args: [{ borrow: "owned", expr }] };
  }
  if (keyTy.kind === "structKey") {
    // A *lookup* (`get`/`has`/`delete`/`in`) constructs a throwaway `&<Struct>Key`
    // temporary (series 074). Building it moves the caller's key value, but the
    // caller keeps ownership — so an identifier key is cloned into the temporary
    // (the ownership pass can't reach inside the `&`). Insertion keys move (no
    // clone), and the ownership pass clones those if live-after.
    const inner: HirExpr =
      forLookup && expr.kind === "ident"
        ? { kind: "method", receiver: expr, name: "clone", args: [] }
        : expr;
    return {
      kind: "call",
      callee: structKeyName(keyTy.name),
      args: [{ borrow: "owned", expr: inner }],
    };
  }
  return expr;
}

/** The synthesized SameValueZero key-newtype name for a struct (series 074). */
function structKeyName(struct: string): string {
  return `${struct}Key`;
}

/**
 * Rewrite (in place) a `Map`/`Set` key/element `struct` type to its `structKey`
 * newtype when the struct is f64-bearing (series 074). Recurses into nested
 * collections/options so a `Map<Point, V[]>` value or an `Option<Map<Point,V>>`
 * is retargeted too. Also handles the `mapNew`/`setNew` HIR construction nodes
 * (same `key`/`value`/`elem` shape) so `new Map<Point,V>()` keys on the newtype.
 */
function retargetStructKey(node: unknown, structKeys: Set<string>): void {
  if (node === null || typeof node !== "object") return;
  switch ((node as { kind?: string }).kind) {
    case "hashmap":
    case "mapNew": {
      const n = node as unknown as { key: RustType; value: RustType };
      if (n.key.kind === "struct" && structKeys.has(n.key.name)) {
        n.key = { kind: "structKey", name: n.key.name };
      } else {
        retargetStructKey(n.key, structKeys);
      }
      retargetStructKey(n.value, structKeys);
      return;
    }
    case "set":
    case "setNew": {
      const n = node as unknown as { elem: RustType };
      if (n.elem.kind === "struct" && structKeys.has(n.elem.name)) {
        n.elem = { kind: "structKey", name: n.elem.name };
      } else {
        retargetStructKey(n.elem, structKeys);
      }
      return;
    }
    case "vec":
      retargetStructKey((node as unknown as { elem: RustType }).elem, structKeys);
      return;
    case "option":
      retargetStructKey(
        (node as unknown as { inner: RustType }).inner,
        structKeys,
      );
      return;
    default:
      return;
  }
}

/**
 * Route a `Map`/`Set` class method to its `IndexMap`/`IndexSet` equivalent
 * (series 061), or null when the receiver is not a map/set binding. `Map`:
 * `set`→`insert`, `get`→`get(&k).cloned()` (`Option`), `has`→`contains_key`,
 * `delete`→`shift_remove` (order-preserving). `Set`: `add`→`insert`,
 * `has`→`contains`, `delete`→`shift_remove`. A scalar-number key is
 * `OrderedFloat`-wrapped; lookups borrow the key (`&k`).
 */
function tryMapSetMethod(
  methodName: string,
  m: MemberExpression,
  call: CallExpression,
  analysis: ModuleAnalysis,
): HirExpr | null {
  const ty = collectionOf(m.object, analysis);
  if (!ty || (ty.kind !== "hashmap" && ty.kind !== "set")) return null;
  const receiver = lowerExpr(m.object, analysis);
  const args = call.arguments.map((a) => lowerExpr(a as Expression, analysis));
  if (ty.kind === "hashmap") {
    // `insert` moves the key (the map owns it); `get`/`has`/`delete` build a
    // throwaway `&<Struct>Key` temporary, so an f64-struct key is cloned into it
    // (series 074; see `wrapKey`) — the caller keeps its value.
    const key = args[0] !== undefined ? wrapKey(args[0], ty.key) : undefined;
    const lookupKey =
      args[0] !== undefined ? wrapKey(args[0], ty.key, true) : undefined;
    if (methodName === "set" && args.length === 2 && key && args[1]) {
      return { kind: "method", receiver, name: "insert", args: [key, args[1]] };
    }
    if (methodName === "get" && lookupKey) {
      return {
        kind: "method",
        receiver: {
          kind: "method",
          receiver,
          name: "get",
          args: [refExpr(lookupKey)],
        },
        name: "cloned",
        args: [],
      };
    }
    if (methodName === "has" && lookupKey) {
      return {
        kind: "method",
        receiver,
        name: "contains_key",
        args: [refExpr(lookupKey)],
      };
    }
    if (methodName === "delete" && lookupKey) {
      return {
        kind: "method",
        receiver,
        name: "shift_remove",
        args: [refExpr(lookupKey)],
      };
    }
    return null;
  }
  // Set<T>
  const elem = args[0] !== undefined ? wrapKey(args[0], ty.elem) : undefined;
  const lookupElem =
    args[0] !== undefined ? wrapKey(args[0], ty.elem, true) : undefined;
  if (methodName === "add" && elem) {
    return { kind: "method", receiver, name: "insert", args: [elem] };
  }
  if (methodName === "has" && lookupElem) {
    return { kind: "method", receiver, name: "contains", args: [refExpr(lookupElem)] };
  }
  if (methodName === "delete" && lookupElem) {
    return {
      kind: "method",
      receiver,
      name: "shift_remove",
      args: [refExpr(lookupElem)],
    };
  }
  return null;
}

/**
 * `m["k"] = v` — a `=` write to a *string-keyed* computed member — lowers to a
 * HashMap insert `m.insert("k".to_string(), v)` (series 031, gap E): Rust's
 * `Index` on `HashMap` is read-only, so an index-assign there is rejected. A
 * numeric index (`arr[0] = v`) is a `Vec` write (valid via `IndexMut`) and
 * returns `null` — left as an ordinary index-assign. A non-`=` operator likewise
 * returns `null`. A non-literal key can't be told apart from a `Vec` index
 * without a binding-type table, so it too stays an index-assign (a documented
 * residual for the rarer HashMap-variable-key write).
 */
function tryHashMapInsert(
  a: { operator: string; left: Expression; right: Expression },
  analysis: ModuleAnalysis,
): HirExpr | null {
  if (a.operator !== "=" || a.left.type !== "MemberExpression") return null;
  const m = a.left as MemberExpression;
  if (!m.computed) return null;
  // A binding known to be a `Map`/`Record` (series 061): any computed write —
  // literal or variable key, `String` or `OrderedFloat` — is an `insert`, with
  // the key wrapped for its Rust key type. Maps are never `Vec`-indexed.
  const recvTy = collectionOf(m.object, analysis);
  if (recvTy?.kind === "hashmap") {
    return {
      kind: "method",
      receiver: lowerExpr(m.object, analysis),
      name: "insert",
      args: [
        wrapKey(lowerExpr(m.property as Expression, analysis), recvTy.key),
        lowerExpr(a.right, analysis),
      ],
    };
  }
  if (m.property.type !== "Literal") return null;
  const key = (m.property as { value: unknown }).value;
  if (typeof key !== "string") return null; // numeric index → Vec, not HashMap
  return {
    kind: "method",
    receiver: lowerExpr(m.object, analysis),
    name: "insert",
    args: [{ kind: "string", value: key }, lowerExpr(a.right, analysis)],
  };
}

/**
 * Lower a class method to an `fn` with a `self` receiver. The receiver is
 * `&mut self` when the body assigns a `this.<field>`, else `&self`. Params are
 * taken by value (method-param borrow inference is deferred). `this` lowers to
 * the `self` identifier (see `lowerExpr`), so `this.x` becomes `self.x`.
 */
/**
 * The (name → `RustType`) map of a method/fn's own **annotated identifier params**
 * (series 088), resolved in the current generic scope (`analysis.typeParams`). Only
 * plain `Identifier` params with a type annotation are seeded — destructured /
 * untyped params are left to the global path. Silently drops a param whose type
 * fails to resolve (the global map / a later fail-loud handles it).
 */
function seedMethodParamTypes(
  fn: { params: unknown[] },
  structs: Set<string>,
  analysis: ModuleAnalysis,
): Map<string, RustType> {
  const seeded = new Map<string, RustType>();
  for (const p of fn.params) {
    if (!isAstNode(p) || p.type !== "Identifier") continue;
    const ann = (p as { typeAnnotation?: { typeAnnotation?: TSType } })
      .typeAnnotation?.typeAnnotation;
    if (!ann) continue;
    try {
      seeded.set(p.name as string, lowerType(ann, structs, analysis.typeParams));
    } catch {
      // Unresolvable here — leave to the global `bindingTypes` / a later fail-loud.
    }
  }
  return seeded;
}

/**
 * Run `body` with `seeded` param types temporarily overriding `analysis.bindingTypes`
 * (series 088), restoring the prior entries after. Scoped so nested method lowering
 * sees its own params, not a sibling method's colliding same-named ones.
 */
function withSeededBindings<T>(
  analysis: ModuleAnalysis,
  seeded: Map<string, RustType>,
  fn: () => T,
): T {
  const prior = new Map<string, RustType | undefined>();
  for (const [name, ty] of seeded) {
    prior.set(name, analysis.bindingTypes.get(name));
    analysis.bindingTypes.set(name, ty);
  }
  try {
    return fn();
  } finally {
    for (const [name, ty] of prior) {
      if (ty === undefined) analysis.bindingTypes.delete(name);
      else analysis.bindingTypes.set(name, ty);
    }
  }
}

function lowerMethod(
  member: MethodDefinition,
  className: string,
  analysis: ModuleAnalysis,
): HirFn {
  // A generic method's own `<U>` (series 081) is in scope for its signature/body
  // only — pushed onto `analysis.typeParams` (which already carries the class's
  // `<T>`), popped after. Unbounded only (a fn-type-param bound is fail-loud).
  const generics = fnGenericNames(
    member.value as { typeParameters?: TSTypeParamDecl | null },
  );
  return withFnGenerics(analysis, generics, () =>
    lowerMethodInner(member, className, analysis, generics),
  );
}

function lowerMethodInner(
  member: MethodDefinition,
  className: string,
  analysis: ModuleAnalysis,
  generics: string[],
): HirFn {
  const fn = member.value;
  const name = member.key.name;
  // async methods (series 054a): `analysis.asyncMethods` records the method name
  // so `await obj.m(...)` recognizes it (see `lowerAwait`). `isAsync: fn.async`
  // flows to the emitter (`async fn m(&self, …)`); a throwing async method
  // composes via the `fallibleMethods` branch below (`async fn … -> Result`),
  // exactly like a free async fn. A bare un-awaited async method call stays
  // fail-loud in `lowerCall` (un-polled future → spawn is 051c).
  const structs = analysis.structs;
  const genericsOpt = generics.length > 0 ? generics : undefined;
  // Method-parameter borrow inference (series 060): each param resolves to
  // `&T`/`&mut T`/owned via the same analysis free fns use (`analysis.methodParams`).
  const info = analysis.methodParams.get(name);
  const params = fn.params.map((p, i) =>
    lowerParam(p, info?.[i], structs, analysis.typeParams),
  );
  // Class inheritance (series 053b, INH10): a base-typed method param → `impl IA`.
  applyBaseParamTraits(params, analysis);
  // A missing return type fails loud (series 046c); an explicit `: void` still
  // lowers to `UNIT`.
  let ret: RustType;
  if (!fn.returnType) {
    // Series 099 inference tier: infer the method return via the oracle.
    const inferred = analysis.typeOracle
      ? analysis.typeOracle.inferredReturnRustType(member.start, member.end)
      : null;
    if (!inferred) {
      throw new UnsupportedError({
        type: `method '${name}' without a return type annotation`,
        start: (member.key as { start?: number }).start,
      });
    }
    ret = inferred;
  } else {
    ret = lowerType(fn.returnType.typeAnnotation, structs, analysis.typeParams);
  }
  if (!fn.body) throw new UnsupportedError({ type: "method without a body" });
  // Series 088: seed *this method's* param types into `bindingTypes` for the body's
  // duration, restored after. The global `collectBindingTypes` map is name-keyed, so
  // two methods with same-named params carrying different generic type-params (e.g.
  // `addA(o: A)` / `ltB(o: B)`) collide there — the operator-on-`T` decision needs the
  // *local* type. Only a `param`-typed override matters for the operator layer, but
  // seeding all annotated params keeps the local scope honest.
  const seededParams = seedMethodParamTypes(fn, structs, analysis);
  const body = withSeededBindings(analysis, seededParams, () =>
    lowerStatements(takeDirectives(fn.body!.body), analysis, `${className}.${name}`),
  );
  // `&mut self` when the method mutates `self` — directly or transitively (it
  // calls another self-mutating method); `analysis.mutatingMethods` is the
  // fixpoint of both. A fallible method (throws or propagates) returns `Result`.
  const recv: SelfRecv = analysis.mutatingMethods.has(name) ? "refMut" : "ref";
  if (analysis.fallibleMethods.has(name)) {
    return {
      kind: "fn",
      name,
      isAsync: fn.async,
      params,
      ret: resultType(ret, programErrType(analysis)),
      body: makeFallible(body, ret),
      recv,
      generics: genericsOpt,
    };
  }
  return {
    kind: "fn",
    name,
    isAsync: fn.async,
    params,
    ret,
    body,
    recv,
    generics: genericsOpt,
  };
}

function lowerParam(
  p: Identifier,
  info: { ownership: "move" | "ref" | "refMut" } | undefined,
  structs: Set<string>,
  typeParams: Set<string> = EMPTY_TYPE_PARAMS,
): HirParam {
  // A default param `(x: T = d)` is an `AssignmentPattern` (series 066): type the
  // param as `Option<T>` (a present arg is `Some`-wrapped at the call, an omitted
  // one is `None`), and the body prepends `let x = x.unwrap_or(d);` — see
  // `defaultParamPreludes`. Passed owned so `unwrap_or` can consume it.
  if ((p as { type?: string }).type === "AssignmentPattern") {
    const left = (p as unknown as { left: Identifier }).left;
    if (!left.typeAnnotation) {
      throw new UnsupportedError({
        type: `default param '${left.name}' without a type annotation`,
        start: left.start,
      });
    }
    const inner = lowerType(
      (left.typeAnnotation as TSTypeAnnotation).typeAnnotation,
      structs,
      typeParams,
    );
    const ty: RustType = inner.kind === "option" ? inner : { kind: "option", inner };
    return { name: left.name, ty };
  }
  // A rest parameter `(...args: T[])` is variadic — not modeled (series 097
  // allowlists `RestElement` for binding destructures only; a rest *param* stays
  // fail-loud). Guard here so it never falls through to the scalar-param path.
  if ((p as { type?: string }).type === "RestElement") {
    throw new UnsupportedError({
      type: "rest parameter (`...args`)",
      start: (p as { start?: number }).start,
    });
  }
  // A destructuring param `({x, y}: Point)` (series 058) → a Rust struct-pattern
  // param `Point { x, y }: Point`. Requires a *named struct* type to pattern
  // against; taken owned (the borrow inference is name-based and can't see it).
  if ((p as { type?: string }).type === "ObjectPattern") {
    return lowerDestructuringParam(p as unknown as ObjectPattern, structs, typeParams);
  }
  if (!p.typeAnnotation) {
    throw new UnsupportedError({
      type: `parameter '${p.name}' without a type annotation`,
      start: p.start,
    });
  }
  return lowerScalarParam(p, info, structs, typeParams);
}

/**
 * A destructuring param `({x, y}: Point)` → the struct-pattern param
 * `Point { x, y }: Point` (series 058). Named-struct-typed only; a shorthand
 * property binds the field name, a renamed one (`{x: a}`) binds `x: a`; a rest
 * element (`{...r}`) and an anonymous object type fail loud.
 */
function lowerDestructuringParam(
  p: ObjectPattern,
  structs: Set<string>,
  typeParams: Set<string> = EMPTY_TYPE_PARAMS,
): HirParam {
  if (!p.typeAnnotation) {
    throw new UnsupportedError({
      type: "a destructuring param without a (named-struct) type annotation",
    });
  }
  const ty = lowerType(p.typeAnnotation.typeAnnotation, structs, typeParams);
  if (ty.kind !== "struct") {
    throw new UnsupportedError({
      type: "a destructuring param whose type is not a named struct",
    });
  }
  const fields = p.properties.map((prop) => {
    if ((prop as { type?: string }).type !== "Property") {
      throw new UnsupportedError({ type: "a rest element in a destructuring param" });
    }
    const key = prop.key as Identifier;
    const value = prop.value as Identifier;
    return prop.shorthand ? key.name : `${key.name}: ${value.name}`;
  });
  return {
    name: `__pat_${ty.name}`,
    ty,
    pat: `${ty.name} { ${fields.join(", ")} }`,
  };
}

/**
 * The body prelude for default params (series 066): for each `(x: T = d)`
 * `AssignmentPattern` param (typed `Option<T>` by `lowerParam`), a
 * `let x = x.unwrap_or(d);` binding that resolves the `Option` to `T` at the head
 * of the body — so the rest of the body sees a plain `T`. Non-default params emit
 * nothing. Prepended before the lowered body statements.
 */
function defaultParamPreludes(
  params: readonly { type?: string }[],
  analysis: ModuleAnalysis,
): HirStmt[] {
  const out: HirStmt[] = [];
  for (const raw of params) {
    if (raw.type !== "AssignmentPattern") continue;
    const ap = raw as unknown as { left: Identifier; right: Expression };
    out.push({
      kind: "let",
      name: ap.left.name,
      mut: false,
      ty: null,
      init: {
        kind: "method",
        receiver: { kind: "ident", name: ap.left.name },
        name: "unwrap_or",
        args: [lowerExpr(ap.right, analysis)],
      },
    });
  }
  return out;
}

function lowerScalarParam(
  p: Identifier,
  info: { ownership: "move" | "ref" | "refMut" } | undefined,
  structs: Set<string>,
  typeParams: Set<string> = EMPTY_TYPE_PARAMS,
): HirParam {
  // An optional param `(x?: T)` is `Option<T>` (series 042); `(x: T | undefined)`
  // already lowers to `option` via the union in `lowerType`. (`typeAnnotation` is
  // guaranteed present — `lowerParam` gates on it before delegating here.)
  const annotated = lowerType(
    (p.typeAnnotation as TSTypeAnnotation).typeAnnotation,
    structs,
    typeParams,
  );
  const optional =
    (p as { optional?: boolean }).optional === true ||
    annotated.kind === "option";
  const base: RustType =
    (p as { optional?: boolean }).optional && annotated.kind !== "option"
      ? { kind: "option", inner: annotated }
      : annotated;
  // An `Option` param is passed **by value** (owned): `??`/pattern-matching
  // consumes it, and `&Option<T>` would not satisfy those. Non-optional params
  // keep the inferred borrow.
  const ownership = optional ? "move" : (info?.ownership ?? "move");
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

function isAstNode(x: unknown): x is { type: string; [k: string]: unknown } {
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
function lowerForOf(
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
function lowerSwitch(
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

/**
 * Lower a discriminated-union `switch (obj.kind)` (series 093, 1b) to a variant
 * `match obj { Shape::Circle { r, .. } => …, … }`. Each `case "circle":` maps to a
 * variant; the arm binds the fields the body *reads* (`..` for the rest) and
 * `obj.field` reads are rewritten to the bound `field` before lowering. A `_ => {}`
 * default is appended only when the arms aren't exhaustive (JS-swallow parity).
 */
function lowerDiscriminatedSwitch(
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
function recognizeUnionIfLadder(
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
function recognizeTypeofSwitch(
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
function recognizeTypeofIfLadder(
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
function recognizeInIfLadder(
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

/** Is `e` a string-literal expression (a `case "x":` test)? */
function isStringLiteralExpr(e: Expression): boolean {
  return e.type === "Literal" && typeof (e as Literal).value === "string";
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

/**
 * The struct `RustType` of a comparison operand when it is a struct-typed binding
 * (series 047c) — resolved from `analysis.bindingTypes` (the 046/048 binding→type
 * pre-pass). Used only to upgrade a non-`PartialEq` struct `===` to a clean
 * `UnsupportedError`; a non-ident or non-struct operand returns null (default path).
 */
function structTypeOfOperand(
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
function sourceStructName(
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
function optionExprType(
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
function isStringAtCall(
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
function paramTypeOfOperand(
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
const JS_OP_TRAIT: Record<string, { trait: string; method: string } | undefined> =
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
function registerOpBound(
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
function needsTruthy(e: Expression, analysis: ModuleAnalysis): boolean {
  const k = scalarKindOf(e, analysis);
  return k !== null && k !== "bool";
}

/** Wrap a lowered condition operand in `is_truthy` when its source is non-`bool` (066). */
function truthyCond(e: Expression, analysis: ModuleAnalysis): HirExpr {
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
function receiverTypeOf(
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
const STRING_METHOD_DEFERRED: Record<string, string | undefined> = {
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
function isStringConcat(
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
function flattenConcat(e: Expression, analysis: ModuleAnalysis): Expression[] {
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

function lowerVarDecl(
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
function lowerTyped(
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
function fieldRustType(
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
function fieldOmitsUndefined(annotation: TSType, optional: boolean): boolean {
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

interface ClassFieldPlan {
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
function rejectImpureInitializer(field: string, expr: Expression): void {
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
function planClassFields(
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

function collectStructFields(
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
function collectReadonlyFields(program: Program): Map<string, Set<string>> {
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
function checkReadonlyAssign(target: Expression, analysis: ModuleAnalysis): void {
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

/**
 * Is this expression the JS `undefined` (an identifier) or `null` (a literal)?
 * Both are the absent optional (`None`) in the dialect's nullability model
 * (series 042).
 */
function isNullishExpr(expr: Expression): boolean {
  if (expr.type === "Identifier") return (expr as Identifier).name === "undefined";
  if (expr.type === "Literal") return (expr as Literal).value === null;
  return false;
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

/**
 * `await <asyncCall>` → `<call>.await`. Only `await` of a call to a known free
 * `async` function maps: awaiting a non-call, or a call to a non-`async`
 * function, is fail-loud (there is no future to poll). The awaited call lowers
 * with `awaited = true` so `lowerCall` accepts the `async` callee.
 *
 * When the awaited fn is also *fallible*, the `Result` it yields is
 * `?`-propagated *after* the `.await` (`<call>.await?`) — the `?` sits outside
 * the await (correct precedence), and the fallibility fixpoint guarantees the
 * enclosing fn is itself `Result`, so `?` is well-typed.
 */
function lowerAwait(expr: AwaitExpression, analysis: ModuleAnalysis): HirExpr {
  const arg = expr.argument;
  // `await h` where `h` is a spawned-task handle (series 051c increment 1) →
  // `h.await.unwrap()`. A `JoinHandle`'s `.await` yields `Result<T, JoinError>`;
  // `.unwrap()` surfaces a task panic (a documented divergence). Checked before
  // the call-only guard below, since the awaited value here is a bare binding.
  if (
    arg.type === "Identifier" &&
    analysis.joinHandleBindings.has((arg as Identifier).name)
  ) {
    return {
      kind: "joinHandleAwait",
      expr: { kind: "ident", name: (arg as Identifier).name },
    };
  }
  // `await <non-call>` (a plain value, member access, literal, …) — awaiting a
  // non-thenable in JS just yields the value on the next microtask tick (#13,
  // series 055, "broad" policy). There is no future here, so drop the `await`
  // and lower the operand as an ordinary expression. (A spawned-handle
  // identifier was already peeled off above and keeps its real `.await`.)
  if (arg.type !== "CallExpression") {
    return lowerExpr(arg, analysis);
  }
  const call = arg as CallExpression;
  const callee = call.callee;

  // `await sleep(ms)` — the dialect's one modeled delay primitive (series 051b).
  // `sleep` is a recognized built-in (like `console.log`), NOT a user async fn;
  // its single `number` arg → `Duration::from_millis(ms as u64)`. Checked before
  // the generic async-fn Identifier handling below.
  if (
    callee.type === "Identifier" &&
    (callee as Identifier).name === "sleep" &&
    !analysis.asyncFns.has("sleep")
  ) {
    const msArg = call.arguments[0];
    if (!msArg || call.arguments.length !== 1) {
      throw new UnsupportedError({
        type: "sleep expects exactly one numeric argument",
      });
    }
    return {
      kind: "await",
      expr: { kind: "sleep", ms: lowerExpr(msArg, analysis) },
    };
  }

  // ── Async concurrency combinators (series 051a) ─────────────────────────────
  // All three 051a shapes appear under `await`; route them here before the plain
  // async-method / async-fn paths below.
  if (callee.type === "MemberExpression") {
    const combinator = lowerAwaitCombinator(call, callee as MemberExpression, analysis);
    if (combinator) return combinator;
  }

  // `await fsAsync.<m>(...)` / `await http.<m>(...)` (series 100) — an async-I/O
  // namespace call → `<tslib target>(&args).await?`. Handled here (before the
  // generic async-method path) since the `fsAsync`/`http` methods are not in
  // `asyncMethods`; the fallibility rides the `bodyUsesAsyncIo` seed.
  if (callee.type === "MemberExpression") {
    const obj = (callee as MemberExpression).object;
    const ns =
      obj.type === "Identifier"
        ? analysis.ioAsyncNamespaces.get((obj as Identifier).name)
        : undefined;
    if (ns) return lowerIoAsyncCall(ns, call, analysis);
  }

  // `await obj.m(...)` — an async method call (series 054a). The method must be
  // in `analysis.asyncMethods`; the receiver + args lower via `lowerCall`'s method
  // branch (with `awaited=true`, which returns the bare method expr). A fallible
  // async method `?`-propagates by wrapping the `await` in `try` → `.await?`.
  if (callee.type === "MemberExpression") {
    const prop = (callee as MemberExpression).property;
    const methodName = prop.type === "Identifier" ? (prop as Identifier).name : null;
    // `await obj.m(...)` where `m` is **not** async — a sync method returns a
    // plain value, so awaiting it is a no-op (#13, series 055). Drop the
    // `await`; `lowerCall` (via `lowerExpr`) still applies `?` for a fallible
    // sync method.
    if (!methodName || !analysis.asyncMethods.has(methodName)) {
      return lowerExpr(arg, analysis);
    }
    const awaited: HirExpr = {
      kind: "await",
      expr: lowerCall(call, analysis, true),
    };
    return analysis.fallibleMethods.has(methodName)
      ? { kind: "try", expr: awaited }
      : awaited;
  }
  // `await syncFn(...)` where `syncFn` is a declared non-async free fn (or any
  // non-Identifier callee that is not a modeled future) — a sync call is not a
  // future, so awaiting it just yields its value (#13, series 055). Drop the
  // `await`; `lowerCall` still wraps a fallible sync fn in `?`.
  if (
    callee.type !== "Identifier" ||
    !analysis.asyncFns.has((callee as Identifier).name)
  ) {
    return lowerExpr(arg, analysis);
  }
  const awaited: HirExpr = {
    kind: "await",
    expr: lowerCall(call, analysis, true),
  };
  return analysis.fallible.has((callee as Identifier).name)
    ? { kind: "try", expr: awaited }
    : awaited;
}

/**
 * Route the three series-051a async-concurrency combinators, each of which
 * appears under `await` with a `MemberExpression` callee:
 *
 *  - `recv.then(cb)` — a non-async single-expr `cb` → sequential `await` of the
 *    receiver then the lifted `__cb_then_<n>` (no extra `.await`; `cb` is sync).
 *  - `Promise.all([a(), b(), …])` — a fixed-arity array literal → `tokio::join!`
 *    (a tuple), or `tokio::try_join!(…)?` when any element is fallible.
 *  - `Promise.race([a(), b(), …])` — a fixed-arity array literal → `tokio::select!`
 *    (first to complete); all arms must unify to one output type.
 *
 * Returns `null` when the callee is neither `.then` nor a `Promise.all/race` (so
 * `lowerAwait` falls through to its async-method / async-fn handling).
 */
function lowerAwaitCombinator(
  call: CallExpression,
  callee: MemberExpression,
  analysis: ModuleAnalysis,
): HirExpr | null {
  const prop = callee.property;
  const propName = prop.type === "Identifier" ? (prop as Identifier).name : null;

  // `recv.then(cb)` — promise chaining.
  if (propName === "then" && !callee.computed) {
    // A two-arg `.then(onOk, onErr)` reject handler is `catch` territory (CONC9).
    if (call.arguments.length >= 2) {
      throw new UnsupportedError({
        type: "`.then` with a reject handler (two-arg) — catch territory",
      });
    }
    // The receiver must be a call to an async fn; lower it as an awaited receiver.
    const recv = callee.object;
    if (recv.type !== "CallExpression") {
      throw new UnsupportedError({
        type: "`.then` on a non-call receiver (only `asyncFn(...).then(cb)`)",
      });
    }
    const recvCall = recv as CallExpression;
    const recvCallee = recvCall.callee;
    if (
      recvCallee.type !== "Identifier" ||
      !analysis.asyncFns.has((recvCallee as Identifier).name)
    ) {
      throw new UnsupportedError({
        type: "`.then` receiver must be a call to an async function",
      });
    }
    const recvAwaited: HirExpr = {
      kind: "await",
      expr: lowerCall(recvCall, analysis, true),
    };
    // The callback: a non-async single-expression arrow taking exactly one param.
    const cb = call.arguments[0];
    if (!cb || cb.type !== "ArrowFunctionExpression") {
      throw new UnsupportedError({
        type: "`.then` callback must be an arrow function",
      });
    }
    // The resolved value type of the receiver (the `cb`'s single param type).
    const elemType = asyncCallItemType(recvCall, analysis);
    // `liftCallback` validates the arrow shape (rejects an async or multi-param
    // arrow) and pushes the `fn __cb_then_<n>` into `analysis.liftedFns`.
    const lifted = liftCallback(
      cb as ArrowFunctionExpression,
      analysis,
      "then",
      elemType,
      1,
    );
    return {
      kind: "call",
      callee: lifted.cbName,
      args: [
        { borrow: "owned", expr: recvAwaited },
        ...lifted.forwarded.map((f) => ({ borrow: "owned" as const, expr: f })),
      ],
    };
  }

  // `Promise.all([...])` / `Promise.race([...])` / `Promise.allSettled(...)`.
  const obj = callee.object;
  if (
    obj.type === "Identifier" &&
    (obj as Identifier).name === "Promise" &&
    (propName === "all" || propName === "race" || propName === "allSettled")
  ) {
    const arg0 = call.arguments[0];

    // ── Dynamic fan-out (series 051b) — `Promise.all(arr.map(f))` /
    // `Promise.allSettled(arr.map(f))`. The sole argument is `arr.map(f)`, a
    // CallExpression whose callee is a `.map` MemberExpression. `race` never
    // takes this form (its fan-out has no tuple/select! shape).
    if (
      (propName === "all" || propName === "allSettled") &&
      arg0 &&
      arg0.type === "CallExpression" &&
      (arg0 as CallExpression).callee.type === "MemberExpression" &&
      ((arg0 as CallExpression).callee as MemberExpression).property.type ===
        "Identifier" &&
      (((arg0 as CallExpression).callee as MemberExpression).property as Identifier)
        .name === "map"
    ) {
      return lowerDynamicFanOut(
        arg0 as CallExpression,
        propName as "all" | "allSettled",
        analysis,
      );
    }

    // `allSettled` accepts ONLY the `arr.map(f)` fan-out (051b); an array-literal
    // form is not modeled here — fall through to the fail-loud below.
    if (propName === "allSettled" || !arg0 || arg0.type !== "ArrayExpression") {
      throw new UnsupportedError({
        type: "Promise.all/allSettled argument must be an array literal or arr.map(f)",
      });
    }
    const elements = (arg0 as ArrayExpression).elements;
    const calls = elements.map((el) => {
      if (!el || el.type !== "CallExpression") {
        throw new UnsupportedError({
          type: "Promise.all/race element must be a call to an async function",
        });
      }
      return el as CallExpression;
    });
    const futures = calls.map((el) => lowerCall(el, analysis, true));

    if (propName === "all") {
      const anyFallible = calls.some(
        (el) =>
          el.callee.type === "Identifier" &&
          analysis.fallible.has((el.callee as Identifier).name),
      );
      return anyFallible
        ? { kind: "try", expr: { kind: "tryJoin", futures } }
        : { kind: "join", futures };
    }

    // `race` — every element's output type must unify to one `T` (select! arms).
    const itemTypes = calls.map((el) => asyncCallItemType(el, analysis));
    const first = JSON.stringify(itemTypes[0]);
    if (itemTypes.some((t) => JSON.stringify(t) !== first)) {
      throw new UnsupportedError({
        type: "heterogeneous Promise.race (select! arms must unify to one type)",
      });
    }
    return { kind: "select", futures };
  }

  return null;
}

/**
 * Lower a dynamic async fan-out (series 051b): `Promise.all(arr.map(f))` or
 * `Promise.allSettled(arr.map(f))`, where `arr` is a homogeneous array and `f`
 * is a `.map` callback in EITHER accepted form:
 *
 *   1. **inline** — `id => fetchRow(id)` (a non-async arrow whose body is a call
 *      to an async fn, i.e. it *returns* a future). Emits an inline closure
 *      `|id| fetch_row(id)`; Rust infers the future type — no lift, no typer.
 *   2. **lifted** — `async id => await fetchRow(id)` (an async arrow awaiting an
 *      async call). Lifts to `async fn __cb_map_<n>(id: T) -> R { return
 *      fetch_row(id).await; }`, emitting `.map(__cb_map_n)`.
 *
 * Both drive `arr.into_iter().map(<closure|cb>)` through `join_all`
 * (infallible / allSettled) or `try_join_all` (`?`-propagated, fallible `all`):
 *
 *   - `Promise.all` + infallible → `join_all(...).await` → `Vec<T>`.
 *   - `Promise.all` + fallible  → `try_join_all(...).await?` (short-circuit).
 *   - `Promise.allSettled`      → `join_all(...).await` → `Vec<Result<T, String>>`
 *     (each fallible element's output is already `Result<T, String>`; never
 *     short-circuits).
 */
function lowerDynamicFanOut(
  mapCall: CallExpression,
  propName: "all" | "allSettled",
  analysis: ModuleAnalysis,
): HirExpr {
  const mapCallee = mapCall.callee as MemberExpression;
  const arr = mapCallee.object as Expression;
  const f = mapCall.arguments[0];
  if (!f || f.type !== "ArrowFunctionExpression") {
    throw new UnsupportedError({
      type: "dynamic fan-out `arr.map(f)` callback must be an arrow function",
    });
  }
  const arrow = f as ArrowFunctionExpression;
  if (arrow.params.length !== 1) {
    throw new UnsupportedError({
      type: "dynamic fan-out callback must take exactly one parameter",
    });
  }
  const paramName = arrow.params[0]?.name;
  if (!paramName) {
    throw new UnsupportedError({
      type: "dynamic fan-out callback parameter binding",
    });
  }

  // Locate the inner async call and whether its callee is fallible.
  let innerCall: CallExpression;
  if (arrow.async) {
    // Lifted form: `async id => await fetchRow(id)` — body is an `await` of a call.
    const body = arrow.expression
      ? (arrow.body as Expression)
      : null;
    const awaitExpr =
      body?.type === "AwaitExpression" ? (body as AwaitExpression) : null;
    if (!awaitExpr || awaitExpr.argument.type !== "CallExpression") {
      throw new UnsupportedError({
        type: "lifted fan-out callback must be `async x => await asyncFn(x)`",
      });
    }
    innerCall = awaitExpr.argument as CallExpression;
  } else {
    // Inline form: `id => fetchRow(id)` — body is directly a call.
    const body = arrow.expression ? (arrow.body as Expression) : null;
    if (!body || body.type !== "CallExpression") {
      throw new UnsupportedError({
        type: "inline fan-out callback must be `x => asyncFn(x)`",
      });
    }
    innerCall = body as CallExpression;
  }
  const innerCallee = innerCall.callee;
  if (
    innerCallee.type !== "Identifier" ||
    !analysis.asyncFns.has((innerCallee as Identifier).name)
  ) {
    throw new UnsupportedError({
      type: "dynamic fan-out callback body must call an async function",
    });
  }
  const innerName = (innerCallee as Identifier).name;
  const itemType = asyncCallItemType(innerCall, analysis);
  const fallible = analysis.fallible.has(innerName);

  // The `.map` argument: an inline closure or a bare path to a lifted async fn.
  let mapArg: HirExpr;
  if (arrow.async) {
    // Lift to `async fn __cb_map_<n>(paramName: T_param) -> itemType`. The param
    // type is the map element type: prefer `arr`'s Vec element type, else fall
    // back to the arrow param annotation, else fail-loud.
    const paramType = fanOutParamType(arr, arrow, analysis);
    const cbName = `__cb_map_${++analysis.liftCounter}`;
    analysis.liftedFns.push({
      kind: "fn",
      name: cbName,
      isAsync: true,
      params: [{ name: paramName, ty: paramType }],
      ret: itemType,
      body: [
        {
          kind: "return",
          value: {
            kind: "await",
            expr: lowerCall(innerCall, analysis, true),
          },
        },
      ],
    });
    mapArg = { kind: "ident", name: cbName };
  } else {
    // Inline closure `|paramName| <bare async call>`.
    mapArg = {
      kind: "closure",
      params: [paramName],
      body: lowerCall(innerCall, analysis, true),
    };
  }

  // `arr.into_iter().map(<mapArg>)`.
  const iter: HirExpr = {
    kind: "method",
    receiver: {
      kind: "method",
      receiver: lowerExpr(arr, analysis),
      name: "into_iter",
      args: [],
    },
    name: "map",
    args: [mapArg],
  };

  if (propName === "allSettled") {
    // Each element's output is `Result<T, String>`; Rust infers `Vec<Result<…>>`.
    return { kind: "joinAll", iter };
  }
  // `Promise.all`: fallible → `try_join_all(...)?`; infallible → `join_all(...)`.
  return fallible
    ? { kind: "try", expr: { kind: "tryJoinAll", iter } }
    : { kind: "joinAll", iter };
}

/**
 * The map element type for a lifted async fan-out callback (series 051b): the
 * element type of `arr` (a known `Vec<E>` binding or an array literal), else the
 * arrow param's own type annotation, else fail-loud with a clear message.
 */
function fanOutParamType(
  arr: Expression,
  arrow: ArrowFunctionExpression,
  analysis: ModuleAnalysis,
): RustType {
  // Prefer the array's element type (`elementTypeOf` handles Vec bindings and
  // array literals). If it cannot resolve, fall back to the arrow param annotation.
  try {
    return elementTypeOf(arr, analysis);
  } catch {
    const param = arrow.params[0];
    const ann = param?.typeAnnotation?.typeAnnotation;
    if (ann) return lowerType(ann as TSType, analysis.structs);
    throw new UnsupportedError({
      type: "cannot resolve lifted fan-out callback parameter type (annotate the array or the callback parameter)",
    });
  }
}

/**
 * Does a lowered expression produce a `join!`/`try_join!` tuple (series 051a)?
 * A `Promise.all` lowers to `{kind:"join"}` (infallible) or `{kind:"try", expr:
 * {kind:"tryJoin"}}` (fallible → `?`-propagated). Only these bind as a Rust
 * tuple destructure `let (a, b) = …`.
 */
function isJoinTuple(expr: HirExpr): boolean {
  if (expr.kind === "join") return true;
  if (expr.kind === "try" && expr.expr.kind === "tryJoin") return true;
  return false;
}

/**
 * The resolved value type `T` of a call to an async fn returning `Promise<T>`,
 * read from the callee's stored return annotation (`FnInfo.retAnn`). Fail-loud
 * when the callee is not a known identifier, is unannotated, or its annotation
 * is not `Promise<T>` (series 051a).
 */
function asyncCallItemType(
  call: CallExpression,
  analysis: ModuleAnalysis,
): RustType {
  const callee = call.callee;
  if (callee.type !== "Identifier") throw new UnsupportedError(call);
  const info = analysis.fns.get((callee as Identifier).name);
  const ann = info?.retAnn ?? null;
  // `Promise<T>` is a `TSTypeReference` named "Promise" with one type argument.
  if (
    !ann ||
    ann.type !== "TSTypeReference" ||
    (ann as Extract<TSType, { type: "TSTypeReference" }>).typeName.name !== "Promise"
  ) {
    throw new UnsupportedError({
      type: "async combinator element callee must return `Promise<T>`",
    });
  }
  const inner = (ann as Extract<TSType, { type: "TSTypeReference" }>).typeArguments
    ?.params?.[0];
  if (!inner) throw new UnsupportedError(call);
  return lowerType(inner, analysis.structs);
}

/**
 * Conservatism guard for `tokio::spawn` (series 051c increment 1). The spawned
 * future is `Send + 'static`, so every argument is *moved* into the task. We
 * admit only args that are provably safe to move here: literals and `Copy`
 * locals (moving a `Copy` value leaves the original live). A bare identifier of
 * a **non-`Copy`** (owning) type, or of unknown type, is fail-loud — it is the
 * shared-capture / task-escape case increment 2 (`Arc`/`Arc<Mutex>`) handles.
 * We NEVER emit a `spawn` we can't prove satisfies `Send + 'static`.
 *
 * This is deliberately conservative (it rejects a non-`Copy` arg even when it
 * happens not to be reused) — always sound, per the fail-loud contract.
 */
function assertSpawnArgsSafe(call: CallExpression, analysis: ModuleAnalysis): void {
  for (const arg of call.arguments) {
    // A bare local. A provably-`Copy` local moves into the task leaving the
    // original live (increment 1). A non-`Copy` local of a *wrappable* shape (a
    // named struct, or a `String`/scalar) is deferred to the inter-procedural
    // task-escape pass (`refineTaskEscape`, increment 2): it either stays a plain
    // move (one spawn, never reused) or is wrapped in `Arc`/`Arc<Mutex>`. The
    // pass proves soundness or fails loud — so we admit it into the HIR here and
    // let that pass adjudicate. A local of *unknown* type stays fail-loud (the
    // pass cannot classify what it cannot type).
    if (arg.type === "Identifier") {
      const name = (arg as Identifier).name;
      const ty = analysis.bindingTypes.get(name);
      if (ty && isCopyRustType(ty)) continue;
      if (ty && isTaskWrappableType(ty)) continue;
      throw new UnsupportedError({
        type: "value captured by a spawned task has a shape the task-escape pass cannot wrap in Arc/Arc<Mutex> — not provably safe to spawn",
      });
    }
    // A literal (number/bool/string-literal) or other non-identifier arg carries
    // no shared aliasing — a string literal is a fresh `String`, a number is
    // `Copy`. These move into the task with nothing left behind.
    if (arg.type === "Literal") continue;
    // Anything else (a member access, a nested call, arithmetic, …) may capture
    // a shared local transitively — the task-escape pass cannot reduce it to a
    // single wrapped binding, so reject conservatively (fail-loud contract).
    throw new UnsupportedError({
      type: "value captured by a spawned task has a shape the task-escape pass cannot wrap in Arc/Arc<Mutex> — not provably safe to spawn",
    });
  }
}

/**
 * A shared capture the task-escape pass (`refineTaskEscape`, series 051c
 * increment 2) can wrap in `Arc<T>` / `Arc<Mutex<T>>`: a named `struct` (the
 * common shared-object shape), or a `String`/scalar whole value. A borrowed,
 * `Option`, collection, `Rc`, or trait-object type is *not* wrappable by the
 * increment-2 pass — those stay fail-loud at the spawn site.
 */
function isTaskWrappableType(ty: RustType): boolean {
  return (
    ty.kind === "struct" ||
    ty.kind === "String" ||
    ty.kind === "f64" ||
    ty.kind === "usize" ||
    ty.kind === "i64" ||
    ty.kind === "bool"
  );
}

/**
 * `setTimeout(fn, ms)` → `tokio::spawn(async move { sleep(ms).await; <fn>; })`
 * — a fire-and-forget delayed task (series 051c increment 1). The delayed body
 * is the existing `sleep` node (series 051b) awaited, followed by `fn`'s work:
 *   - an inline non-async arrow → its body inlined (a block body's statements,
 *     or an expression body as one expr statement);
 *   - a bare identifier naming a top-level fn → a call to it.
 * `ms` is any expression (typically a `number` literal). A captured non-Copy
 * local inside `fn` that is shared stays fail-loud (increment 2).
 */
function lowerSetTimeout(call: CallExpression, analysis: ModuleAnalysis): HirExpr {
  if (call.arguments.length !== 2) {
    throw new UnsupportedError({
      type: "setTimeout expects exactly (fn, ms)",
    });
  }
  const [fn, msArg] = call.arguments;
  if (!fn || !msArg) throw new UnsupportedError(call);

  // The awaited-sleep prelude of the delayed task.
  const sleepStmt: HirStmt = {
    kind: "expr",
    expr: { kind: "await", expr: { kind: "sleep", ms: lowerExpr(msArg, analysis) } },
  };

  let bodyStmts: HirStmt[];
  if (fn.type === "ArrowFunctionExpression" || fn.type === "FunctionExpression") {
    const arrow = fn as ArrowFunctionExpression;
    if (arrow.async) {
      throw new UnsupportedError({ type: "setTimeout with an async callback" });
    }
    if (arrow.params.length !== 0) {
      throw new UnsupportedError({
        type: "setTimeout callback takes no arguments",
      });
    }
    if (arrow.body.type === "BlockStatement") {
      bodyStmts = lowerStatements(
        (arrow.body as BlockStatement).body,
        analysis,
        SCRIPT_SCOPE,
      );
    } else {
      bodyStmts = [
        { kind: "expr", expr: lowerExpr(arrow.body as Expression, analysis) },
      ];
    }
  } else if (fn.type === "Identifier") {
    // A bare fn name → a call statement `named();`.
    bodyStmts = [
      {
        kind: "expr",
        expr: { kind: "call", callee: (fn as Identifier).name, args: [] },
      },
    ];
  } else {
    throw new UnsupportedError({
      type: "setTimeout callback must be an inline arrow or a bare fn name",
    });
  }

  return {
    kind: "spawn",
    expr: { kind: "asyncMove", stmts: [sleepStmt, ...bodyStmts] },
  };
}

function lowerCall(
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

// ── Callback lifting (series 048) ─────────────────────────────────────────────

/**
 * Array adapter methods whose arrow callback is lifted to a `__cb_*` fn (series
 * 048). An `async` callback in one of these is fail-loud until series 051b wires
 * the `join_all` consumer (series 054c guard).
 */
const LIFT_ADAPTERS = new Set([
  "map",
  "filter",
  "find",
  "some",
  "every",
  "reduce",
  "sort",
]);

/** JS globals a callback body may read without them being *free variables*. */
const CB_GLOBALS = new Set([
  "console",
  "JSON",
  "Math",
  "Object",
  "undefined",
  "NaN",
]);

/**
 * Extract an `arity`-param, expression-bodied arrow's param names and body
 * expression (series 048; formerly `arrowClosureN`). The body is the arrow's
 * expression, or a block of exactly one `return <expr>`. A wrong param count,
 * `async`, destructured params, and multi-statement bodies are all fail-loud.
 */
function arrowShape(
  arrow: ArrowFunctionExpression,
  arity: number,
  maxArity: number = arity,
): { params: string[]; bodyExpr: Expression } {
  if (arrow.async) {
    throw new UnsupportedError({ type: "async arrow closure" });
  }
  if (arrow.params.length < arity || arrow.params.length > maxArity) {
    throw new UnsupportedError({
      type:
        arity === maxArity
          ? `closure must take exactly ${arity} parameter(s)`
          : `closure must take ${arity}–${maxArity} parameter(s)`,
    });
  }
  const params = arrow.params.map((p) => p.name);
  if (params.some((p) => !p)) {
    throw new UnsupportedError({ type: "closure parameter binding" });
  }
  let bodyExpr: Expression;
  if (arrow.expression) {
    bodyExpr = arrow.body as Expression;
  } else {
    const b = arrow.body as BlockStatement;
    const only = b.body.length === 1 ? b.body[0] : undefined;
    const ret =
      only?.type === "ReturnStatement" ? (only as ReturnStatement) : null;
    if (ret?.argument) {
      bodyExpr = ret.argument;
    } else {
      throw new UnsupportedError({
        type: "closure body must be an expression or a single return",
      });
    }
  }
  return { params: params as string[], bodyExpr };
}

/**
 * Source-level (pre-lowering) collection-mutating method names — a call to one of
 * these on a **captured** receiver is a mutable capture (series 078 / issue #45,
 * the field-collection-capture residual → #46). Mirrors `MUTATING_METHODS` in
 * `analysis.ts`; kept local to the capture check.
 */
const CAPTURE_MUTATORS = new Set<string>([
  "set",
  "add",
  "delete",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "clear",
]);

/**
 * The free variables of a callback body, in first-occurrence order: the
 * `Identifier`s it reads that are not its own params, a top-level fn name, a
 * declared nominal type, a member-access property, or a known global. A free var
 * that is *assigned* (an `=` LHS, or a `++`/`--` target) is a scalar mutable capture
 * — fail-loud (series 048; the user lifts it to a named fn taking the state). A free
 * var mutated through a **collection method** (`xs.push(…)`, `s.add(…)`) is a
 * container capture (series 079, issue #46): reported in `mutated` so `liftCallback`
 * forwards it `&mut` instead of rejecting it. `names` includes both read and mutated
 * captures (a container read-and-mutated appears once, in `mutated`).
 */
function freeVarsOf(
  body: Expression,
  params: Set<string>,
  analysis: ModuleAnalysis,
): { names: string[]; mutated: Set<string> } {
  const excluded = (name: string): boolean =>
    params.has(name) ||
    analysis.fns.has(name) ||
    analysis.structs.has(name) ||
    CB_GLOBALS.has(name);
  // The root identifier of a member chain (`c.entries` / `c.a.b` → `c`), or null.
  const rootOf = (node: unknown): string | null => {
    let cur: unknown = node;
    while (isAstNode(cur) && cur.type === "MemberExpression") cur = cur.object;
    return isAstNode(cur) && cur.type === "Identifier"
      ? (cur.name as string)
      : null;
  };
  const seen = new Set<string>();
  const order: string[] = [];
  const mutated = new Set<string>();
  const mutableCapture = (): never => {
    throw new UnsupportedError({
      type: "mutable capture in a callback (lift to a named fn taking the state as an explicit param)",
    });
  };
  const record = (name: string): void => {
    if (!excluded(name) && !seen.has(name)) {
      seen.add(name);
      order.push(name);
    }
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isAstNode(node)) return;
    switch (node.type) {
      case "Identifier": {
        record(node.name as string);
        return;
      }
      case "MemberExpression": {
        visit(node.object);
        // A non-computed property (`obj.prop`) is a field name, not a free var.
        if (node.computed) visit(node.property);
        return;
      }
      case "AssignmentExpression": {
        const left = node.left;
        if (isAstNode(left) && left.type === "Identifier") {
          if (!params.has(left.name as string)) mutableCapture();
        } else {
          visit(left);
        }
        visit(node.right);
        return;
      }
      case "UpdateExpression": {
        const arg = node.argument;
        if (
          isAstNode(arg) &&
          arg.type === "Identifier" &&
          !params.has(arg.name as string)
        ) {
          mutableCapture();
        }
        visit(arg);
        return;
      }
      case "CallExpression": {
        // A collection-mutating method on a **captured** receiver
        // (`c.entries.set(…)` / `xs.push(…)` where `xs` is a free var) mutates
        // captured state through a method — reachable only through the receiver chain
        // rather than an assignment. Series 079 (issue #46) graduates the **bare**
        // captured-container case: it is recorded in `mutated` so the container is
        // forwarded `&mut` (not rejected). A mutation of a **field** of a captured
        // owner (`c.entries.set(…)`, a nested receiver) still needs promotion — that
        // stays fail-loud (the #45-coupled Rc row). A property mutator on a param
        // receiver is fine.
        const callee = node.callee;
        if (
          isAstNode(callee) &&
          callee.type === "MemberExpression" &&
          isAstNode(callee.property) &&
          callee.property.type === "Identifier" &&
          CAPTURE_MUTATORS.has(callee.property.name as string)
        ) {
          const recv = callee.object;
          const root = rootOf(recv);
          // A bare captured receiver (`xs.push(…)`, `xs` an Identifier) → `&mut`
          // forward. A field-of-captured receiver (`c.entries.set(…)`) is a deeper
          // shape (→ Rc row) → fail-loud.
          if (root && !excluded(root)) {
            if (isAstNode(recv) && recv.type === "Identifier") {
              record(root);
              mutated.add(root);
            } else {
              mutableCapture();
            }
          }
        }
        visit(node.callee);
        node.arguments && visit(node.arguments);
        return;
      }
      default: {
        for (const key in node) {
          if (key === "type") continue;
          visit(node[key]);
        }
      }
    }
  };
  visit(body);
  return { names: order, mutated };
}

/**
 * Is a `RustType` a container a lifted callback can forward by reference (series
 * 079): a `Vec`, `Set`, `Map`, or `String`. These are the shapes `freeVarsOf`
 * classifies read/mut and `liftCallback` threads as `&T` / `&mut T`.
 */
function isCaptureContainerType(ty: RustType): boolean {
  return (
    ty.kind === "vec" ||
    ty.kind === "set" ||
    ty.kind === "hashmap" ||
    ty.kind === "String"
  );
}

/**
 * Structural `RustType` equality over the callback-body typer's surface (series
 * 085) — the flatMap array-uniformity check. Compares scalar kinds directly and
 * recurses into `vec` element types; other kinds compare by `kind` only (the
 * bounded typer produces just scalars and `vec`s here).
 */
function sameRustType(a: RustType, b: RustType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "vec" && b.kind === "vec") return sameRustType(a.elem, b.elem);
  return true;
}

/** Is a `RustType` a `Copy` scalar (forwardable by value into a lifted fn)? */
function isCopyRustType(ty: RustType): boolean {
  return (
    ty.kind === "f64" ||
    ty.kind === "usize" ||
    ty.kind === "i64" ||
    ty.kind === "bool" ||
    ty.kind === "fnPtr"
  );
}

/**
 * The bounded expression typer (series 048): types a lifted callback body over
 * the numeric surface — arithmetic → `f64`, comparison/logical → `bool`, `!` →
 * `bool`, `-x` → the operand type, a literal by its kind, an identifier by `ctx`
 * (the param + free-var types). Anything else fails loud (numeric arrays first).
 */
function typeCbBody(e: HirExpr, ctx: Map<string, RustType>): RustType {
  switch (e.kind) {
    case "number":
      return { kind: "f64" };
    case "bool":
      return { kind: "bool" };
    case "string":
      return { kind: "String" };
    case "ident": {
      const t = ctx.get(e.name);
      if (!t) {
        throw new UnsupportedError({
          type: `cannot lift callback: free variable '${e.name}' has unknown type`,
        });
      }
      return t;
    }
    case "binary": {
      if (["+", "-", "*", "/", "%"].includes(e.op)) return { kind: "f64" };
      if (
        ["<", ">", "<=", ">=", "===", "!==", "==", "!=", "&&", "||"].includes(
          e.op,
        )
      ) {
        return { kind: "bool" };
      }
      throw new UnsupportedError({
        type: "callback body too complex to lift (numeric surface only)",
      });
    }
    case "unary":
      if (e.op === "!") return { kind: "bool" };
      if (e.op === "-") return typeCbBody(e.operand, ctx);
      throw new UnsupportedError({
        type: "callback body too complex to lift (numeric surface only)",
      });
    case "array": {
      // A `flatMap` callback returns a `U[]` (series 085): type every element,
      // require them uniform, and return `Vec<U>` — the one-level element unwrap
      // (the lifted `fn` returns `Vec<U>`, so `flat_map` flattens to `Vec<U>`).
      // An empty or heterogeneous array (the `U | U[]` union case) is fail-loud →
      // the recursive/dynamic value model, epic #59.
      if (e.elements.length === 0) {
        throw new UnsupportedError({
          type: "cannot lift flatMap callback: empty array-literal return (element type unknown)",
        });
      }
      const elemTypes = e.elements.map((el) => typeCbBody(el, ctx));
      const first = elemTypes[0] as RustType;
      for (const t of elemTypes) {
        if (!sameRustType(t, first)) {
          throw new UnsupportedError({
            type: "cannot lift flatMap callback: heterogeneous array-literal return (a `U | U[]` union stays fail-loud → #59)",
          });
        }
      }
      return { kind: "vec", elem: first };
    }
    default:
      throw new UnsupportedError({
        type: "callback body too complex to lift (numeric surface only)",
      });
  }
}

/**
 * Lift a callback arrow's body to a top-level `__cb_<method>_<n>` fn (series
 * 048): its params are the arrow's own params (typed by `elemType`, or `accType`
 * for a reduce's first param) followed by its read-only Copy free vars; its
 * return type is the bounded typer's result. Returns the callback's name, its
 * param names, and the free-var idents to forward at the shim.
 */
function liftCallback(
  arrow: ArrowFunctionExpression,
  analysis: ModuleAnalysis,
  method: string,
  elemType: RustType,
  arity: number,
  accType?: RustType,
  opts?: { indexAllowed?: boolean },
): {
  cbName: string;
  paramNames: string[];
  forwarded: HirExpr[];
  elemMode: ElemMode;
  indexParam?: string;
} {
  // The index param `(el, i)` (series 057) is a single extra param, on `map` only.
  const indexAllowed = opts?.indexAllowed ?? false;
  // A third `(el, i, arr)` param — the whole array — forces a second borrow of the
  // receiver mid-iteration and muddies the pure-fn shape: fail-loud (057 residual).
  if (indexAllowed && arrow.params.length >= arity + 2) {
    throw new UnsupportedError({
      type: `whole-array ('arr') callback parameter in '.${method}' — a second borrow of the receiver (fail-loud residual, series 057)`,
    });
  }
  const { params, bodyExpr } = arrowShape(
    arrow,
    arity,
    indexAllowed ? arity + 1 : arity,
  );
  const indexParam = params.length > arity ? (params[arity] as string) : undefined;
  const paramSet = new Set(params);
  const freeNames = freeVarsOf(bodyExpr, paramSet, analysis);

  // Element passing (series 057): a Copy element forwards by value (`copy`); a
  // non-Copy element is classified read-only (`borrow`, `&T`) vs consumed (`clone`,
  // owned `T`) from a local walk of the one body. `reduce`/`sort` (arity 2) don't
  // yet borrow their element — a non-Copy element there stays fail-loud.
  let elemMode: ElemMode = "copy";
  if (!isCopyRustType(elemType)) {
    if (arity !== 1) {
      throw new UnsupportedError({
        type: `'.${method}' over a non-Copy element type — element borrowing is only wired for map/filter/find/some/every (fail-loud residual, series 057)`,
      });
    }
    const use = classifyElementUse(bodyExpr, params[0] as string);
    if (use === "unresolved") {
      throw new UnsupportedError({
        type: `cannot classify the callback's element parameter '${params[0]}' as read-only or consumed — no silent clone (fail-loud, series 057)`,
      });
    }
    elemMode = use === "consume" ? "clone" : "borrow";
  }
  // A borrowed non-Copy element becomes a `&T` param (refined to `&str` for a
  // read-only String by `refineStrings`); copy/clone keep the owned element type.
  const elemParamTy: RustType =
    elemMode === "borrow"
      ? { kind: "ref", mut: false, inner: elemType }
      : elemType;

  // Param types: own params first, then each free var (Copy scalars only). The
  // typer `ctx` uses the element's *value* type (not the `&T` borrow). Arity 2 is
  // `reduce` (`acc` typed by `init`, `elem` Copy) or `sort` (both Copy elements);
  // arity 1 is the single element, which may borrow (`&T`) under `elemMode`.
  const ctx = new Map<string, RustType>();
  let ownParams: HirParam[];
  if (arity === 2) {
    const firstTy = accType ?? elemType;
    ownParams = [
      { name: params[0] as string, ty: firstTy },
      { name: params[1] as string, ty: elemType },
    ];
    ctx.set(params[0] as string, firstTy);
    ctx.set(params[1] as string, elemType);
  } else {
    ownParams = [{ name: params[0] as string, ty: elemParamTy }];
    ctx.set(params[0] as string, elemType);
  }
  if (indexParam) {
    // The index joins the f64 numeric surface (decision 2026-07-09): `number` is
    // uniformly f64, and JS's callback index *is* a number, so the shim forwards
    // `i as f64`. This lets arithmetic bodies (`x + i`) work and bind to `number[]`
    // — `usize` would clash with the f64 literals/result and only admit a bare `i`.
    ownParams.push({ name: indexParam, ty: { kind: "f64" } });
    ctx.set(indexParam, { kind: "f64" });
  }

  const freeParams: HirParam[] = [];
  const forwarded: HirExpr[] = [];
  for (const name of freeNames.names) {
    const t = analysis.bindingTypes.get(name);
    if (!t) {
      throw new UnsupportedError({
        type: `cannot lift callback: free variable '${name}' has unknown type`,
      });
    }
    if (isCopyRustType(t)) {
      // A Copy scalar forwards by value (the shipped 048 path, unchanged).
      ctx.set(name, t);
      freeParams.push({ name, ty: t });
      forwarded.push({ kind: "ident", name });
      continue;
    }
    // A captured **container** (Set/Map/Vec/String) forwards by reference (series
    // 079, issue #46): `&mut T` when the body mutates it through a method, else `&T`.
    // The single call site borrows the arg accordingly (`&env` / `&mut env`). Body
    // references already lower to method calls on the param name — no rewrite beyond
    // the `&`/`&mut` param type. The typer `ctx` keeps the *value* type.
    if (isCaptureContainerType(t)) {
      const mut = freeNames.mutated.has(name);
      ctx.set(name, t);
      freeParams.push({ name, ty: { kind: "ref", mut, inner: t } });
      forwarded.push({ kind: "ref", mut, expr: { kind: "ident", name } });
      continue;
    }
    throw new UnsupportedError({
      type: `cannot lift callback: free variable '${name}' is not a Copy scalar or a threadable container (only read-only scalars and Set/Map/Array/String captures forward)`,
    });
  }

  // A `flatMap` callback whose body is a ternary `cond ? U : U[]` (series 092)
  // lifts to a fn returning a uniform `Vec<U>` — the scalar arm is wrapped
  // `vec![x]`, so `flat_map`'s one-level flatten yields a homogeneous result. The
  // single-expression path (everything else) lowers + types the body directly.
  let ret: RustType;
  let fnBody: HirStmt[];
  // Unwrap source parens (`(cond ? … : …)`) so a parenthesized ternary body is
  // recognized (the emitter re-parenthesizes from precedence).
  let unwrapped = bodyExpr;
  while (unwrapped.type === "ParenthesizedExpression") {
    unwrapped = (unwrapped as unknown as { expression: Expression }).expression;
  }
  if (method === "flatMap" && unwrapped.type === "ConditionalExpression") {
    const t = liftFlatMapTernaryBody(
      unwrapped as unknown as {
        test: Expression;
        consequent: Expression;
        alternate: Expression;
      },
      ctx,
      analysis,
    );
    ret = t.ret;
    fnBody = t.fnBody;
  } else {
    const body = lowerExpr(bodyExpr, analysis);
    ret = typeCbBody(body, ctx);
    fnBody = [{ kind: "return", value: body }];
  }
  const cbName = `__cb_${method}_${++analysis.liftCounter}`;
  analysis.liftedFns.push({
    kind: "fn",
    name: cbName,
    // Async-aware lift (series 054c): an `async` callback lifts to an `async fn`.
    // This is readiness for 051b (dynamic `join_all` fan-out consumes it); in 054
    // the adapter guard (see `lowerCall`) rejects an async callback before it is
    // lifted, so this stays `false` in practice until 051b removes that guard.
    isAsync: arrow.async,
    params: [...ownParams, ...freeParams],
    ret,
    body: fnBody,
  });
  return { cbName, paramNames: params, forwarded, elemMode, indexParam };
}

/**
 * Lift a `flatMap` callback whose body is a ternary `cond ? U : U[]` (series 092).
 * JS `flatMap` flattens one level, so a scalar arm contributes one element and an
 * array arm is spread — the homogeneous result is `Vec<U>`. A **scalar** arm `x`
 * (element `U`) is wrapped `vec![x]`; an **array-literal** arm `[a, b]` already
 * yields `Vec<U>`; both arms must share `U`. The lifted body is
 * `if cond { return <Vec<U>> } else { return <Vec<U>> }`. Genuinely-different arm
 * types, an empty-array arm, or a non-array/non-scalar arm stay fail-loud (the
 * dynamic-value residual → epic #59).
 */
function liftFlatMapTernaryBody(
  cond: { test: Expression; consequent: Expression; alternate: Expression },
  ctx: Map<string, RustType>,
  analysis: ModuleAnalysis,
): { ret: RustType; fnBody: HirStmt[] } {
  const normalizeArm = (arm: Expression): { expr: HirExpr; elem: RustType } => {
    const hir = lowerExpr(arm, analysis);
    const ty = typeCbBody(hir, ctx);
    // An array-literal arm already yields `Vec<U>`; a scalar arm `x` → `vec![x]`.
    return ty.kind === "vec"
      ? { expr: hir, elem: ty.elem }
      : { expr: { kind: "array", elements: [hir] }, elem: ty };
  };
  const consequent = normalizeArm(cond.consequent);
  const alternate = normalizeArm(cond.alternate);
  if (!sameRustType(consequent.elem, alternate.elem)) {
    throw new UnsupportedError({
      type: "cannot lift flatMap ternary callback: arms have different element types (a genuinely dynamic `U | V` stays fail-loud → #59)",
    });
  }
  // Series 094: build the ternary through the shared expression-position `cond`
  // node — `return (if cond { <Vec<U>> } else { <Vec<U>> })` — instead of a
  // hand-rolled statement-`if` with `return`s. One ternary lowering, one emitter
  // path. The arm normalization (scalar → `vec![x]`) above is unchanged.
  return {
    ret: { kind: "vec", elem: consequent.elem },
    fnBody: [
      {
        kind: "return",
        value: {
          kind: "cond",
          test: truthyCond(cond.test, analysis),
          conseq: consequent.expr,
          alt: alternate.expr,
        },
      },
    ],
  };
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
function classifyElementUse(
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
function elementTypeOf(objExpr: Expression, analysis: ModuleAnalysis): RustType {
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
function collectBothPresentWarnings(program: Program): string[] {
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

function collectBindingTypes(
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
function inferInitType(
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
function tryForEach(
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

/**
 * Route a *quirk-heavy* library method to the `tslib` fidelity crate (series
 * 027), or return null to leave it as a native `method` call. The emitter's
 * hybrid rule: emit native idiomatic Rust where a JS method maps cleanly, and
 * confine JS-quirk semantics (negative `at`, `padStart`/`padEnd`) to `tslib`.
 * Numeric args are passed as owned `f64` — `tslib` floors them, so the runtime
 * coercion lives in the audited crate, not a codegen `as usize` cast.
 */
function tryTslibMethod(
  methodName: string,
  m: MemberExpression,
  call: CallExpression,
  analysis: ModuleAnalysis,
): HirExpr | null {
  const recvRef = (): HirArg => ({
    borrow: "ref",
    expr: lowerExpr(m.object, analysis),
  });
  const args = call.arguments;
  // `xs.at(i)` → `tslib::array::at(&xs, i)` (JS negative-from-end indexing).
  if (methodName === "at" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::array::at",
      args: [
        recvRef(),
        { borrow: "owned", expr: lowerExpr(args[0], analysis) },
      ],
    };
  }
  // `xs.slice(start[, end])` → `tslib::array::slice{,_from}(&xs, …)` (040): JS's
  // clamped, negative-aware, end-exclusive shallow copy. Numeric args are owned
  // `f64` (floored in `tslib`, the `at` precedent).
  if (methodName === "slice" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::array::slice_from",
      args: [
        recvRef(),
        { borrow: "owned", expr: lowerExpr(args[0], analysis) },
      ],
    };
  }
  if (methodName === "slice" && args.length === 2 && args[0] && args[1]) {
    return {
      kind: "call",
      callee: "tslib::array::slice",
      args: [
        recvRef(),
        { borrow: "owned", expr: lowerExpr(args[0], analysis) },
        { borrow: "owned", expr: lowerExpr(args[1], analysis) },
      ],
    };
  }
  // `s.padStart(n, pad)` / `s.padEnd(n, pad)` → `tslib::string::pad_{start,end}`.
  if (
    (methodName === "padStart" || methodName === "padEnd") &&
    args.length === 2 &&
    args[0] &&
    args[1]
  ) {
    const fn = methodName === "padStart" ? "pad_start" : "pad_end";
    return {
      kind: "call",
      callee: `tslib::string::${fn}`,
      args: [
        recvRef(),
        { borrow: "owned", expr: lowerExpr(args[0], analysis) },
        { borrow: "ref", expr: lowerExpr(args[1], analysis) },
      ],
    };
  }
  return null;
}

// ── RegExp dispatch (series 101, epic #56) ────────────────────────────────────

/** A Rust string literal for an already-translated regex pattern / replacement. */
function rustStrLit(s: string): string {
  return (
    '"' +
    s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t") +
    '"'
  );
}

/**
 * The `{pattern, flags}` of a **statically-known** regex value — a `/pat/flags`
 * literal, or `new RegExp("lit"[, "flags"])` with a string-literal pattern. `null`
 * for a non-regex expression (a `new RegExp(runtimeVar)` is handled in `lowerNew`).
 */
function regexLiteralInfo(
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
function lowerRegexValue(info: { pattern: string; flags: string }): HirExpr {
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
function regexArgGlobal(e: Expression, analysis: ModuleAnalysis): boolean | null {
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
function isRegexValueExpr(e: Expression, analysis: ModuleAnalysis): boolean {
  return regexArgGlobal(e, analysis) !== null;
}

/** Lower a regex value to the Rust **receiver** of a `tslib::regex::Regex` method
 *  — a literal/`new` inlines its `new_lit(...)`; a binding lowers to its name. */
function lowerRegexReceiver(e: Expression, analysis: ModuleAnalysis): HirExpr {
  const info = regexLiteralInfo(e);
  if (info) return lowerRegexValue(info);
  return lowerExpr(e, analysis);
}

/** The Rust `Match` struct type (first-match result); an `Option<Match>` binding. */
const REGEX_MATCH_TYPE: RustType = { kind: "struct", name: "tslib::regex::Match" };

/**
 * The by-construction `RustType` of a regex string/`exec` result (series 101),
 * gated on a genuine regex receiver/arg — used both to exempt the binding from the
 * annotation gate and to record its type (so `m![i]` / `all!.join` / the for-of
 * over `matchAll` route correctly). `null` for a non-regex call.
 */
function regexResultTypeAst(
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
function isRegexInit(e: Expression | null, analysis: ModuleAnalysis): boolean {
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

/** Peel one non-null assertion (`x!` → `x`); identity otherwise. */
function peelNonNull(e: Expression): Expression {
  return e.type === "TSNonNullExpression"
    ? (e as unknown as { expression: Expression }).expression
    : e;
}

/** The bound name if `e` (through an optional `!`) is a first-match `matchBindings`
 *  identifier (an `Option<Match>` binding); else null. */
function matchBindingName(e: Expression, analysis: ModuleAnalysis): string | null {
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
function matchBorrowUnwrap(name: string): HirExpr {
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
function regexReplArg(replExpr: Expression): HirExpr {
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
function tryRegexMethod(
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

// ── Primitive-method dispatch (series 083) ────────────────────────────────────

/**
 * A `string`/`number` receiver method (series 083), routed through the unified
 * `receiverTypeOf` gate and the 029 catalog. Sibling to `tryMapSetMethod`/
 * `tryTslibMethod`, called from `lowerCall` **before** the generic fallthrough.
 * Returns null for a receiver we don't model as a primitive (→ fall through →
 * today's fail-loud), never a wrong emit.
 */
function tryPrimitiveMethod(
  methodName: string,
  m: MemberExpression,
  call: CallExpression,
  analysis: ModuleAnalysis,
): HirExpr | null {
  const recv = receiverTypeOf(m.object, analysis);
  if (recv?.kind === "String")
    return stringMethod(methodName, m, call, analysis);
  if (recv?.kind === "f64") return numberMethod(methodName, m, call, analysis);
  if (recv?.kind === "vec")
    return arrayTailMethod(methodName, m, call, recv.elem, analysis);
  return null;
}

/**
 * Array-access tail methods (series 083 slice 8) — `join`, `concat`, `splice`.
 * `reverse` already lowers natively (`Vec::reverse`, in place) so it is not
 * routed here. Gated on a `vec` receiver via `receiverTypeOf`. `null` → fall
 * through.
 */
function arrayTailMethod(
  methodName: string,
  m: MemberExpression,
  call: CallExpression,
  _elem: RustType,
  analysis: ModuleAnalysis,
): HirExpr | null {
  const args = call.arguments;
  const recvRef: HirArg = { borrow: "ref", expr: lowerExpr(m.object, analysis) };
  // `xs.join(sep)` → tslib: JS coerces each element to its string form then joins
  // (so a number array joins as `"1-2-3"`), which `[T]::join` cannot do (no
  // `Display`-join in std). Confined to tslib for the string-coercion fidelity.
  if (methodName === "join" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::array::join",
      args: [recvRef, { borrow: "owned", expr: strPatternArg(args[0], analysis) }],
    };
  }
  if (methodName === "join" && args.length === 0) {
    // Default separator is "," in JS.
    return {
      kind: "call",
      callee: "tslib::array::join",
      args: [recvRef, { borrow: "owned", expr: { kind: "raw", text: '","' } }],
    };
  }
  // `xs.concat(ys)` → a new `Vec` (JS returns a fresh array; the receiver is
  // unchanged). `tslib::array::concat` clones both into one.
  if (methodName === "concat" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::array::concat",
      args: [
        recvRef,
        { borrow: "ref", expr: lowerExpr(args[0], analysis) },
      ],
    };
  }
  // `xss.flat()` (depth 1) / `xss.flat(k)` / `xss.flat(Infinity)` (series 085 +
  // 092). JS flattens `min(k, N)` levels, where `N` is the receiver's static
  // nesting depth (the homogeneous dialect makes it compile-time-known) — an
  // over-deep or `Infinity` request flattens all `N` levels to the scalar leaf,
  // and flattening an already-flat array is a **no-op** copy (`min`→0), never an
  // error. A runtime-**variable** depth isn't a compile-time constant → declined
  // (fall through → cargo-loud). Emits `effective` chained depth-1 flattens.
  if (methodName === "flat" && (args.length === 0 || args.length === 1)) {
    const depth = flatDepthArg(args[0]);
    if (depth === null) return null; // runtime-variable depth → fall through (cargo-loud)
    // The static nesting depth `N`: count the `vec` levels of the element type.
    let nesting = 0;
    for (let cur: RustType = _elem; cur.kind === "vec"; cur = cur.elem) nesting++;
    const effective = Math.min(depth, nesting);
    if (effective === 0) {
      // `min(depth, N) === 0` — already-flat / no-op flatten: JS returns a shallow
      // copy of the array, so clone the receiver `Vec`.
      return { kind: "method", receiver: lowerExpr(m.object, analysis), name: "clone", args: [] };
    }
    // Emit `effective` chained depth-1 flattens: flat(flat(...flat(&recv)...)).
    let call: HirExpr = { kind: "call", callee: "tslib::array::flat", args: [recvRef] };
    for (let level = 1; level < effective; level++) {
      call = {
        kind: "call",
        callee: "tslib::array::flat",
        args: [{ borrow: "ref", expr: call }],
      };
    }
    return call;
  }
  return null;
}

/**
 * The requested depth of a `flat(k)` argument (series 085 + 092). No arg → depth
 * 1. A numeric literal → `max(0, floor(k))` (JS clamps a negative/fractional
 * depth). The `Infinity` global → `Infinity` (flatten all levels). A runtime
 * **variable** (or any other non-constant) → `null` so the caller declines and
 * falls through (never a wrong flatten). The caller clamps to the static nesting.
 */
function flatDepthArg(arg: Expression | undefined): number | null {
  if (arg === undefined) return 1;
  if (arg.type === "Identifier" && (arg as Identifier).name === "Infinity") {
    return Infinity;
  }
  if (arg.type !== "Literal") return null;
  const v = (arg as Literal).value;
  if (typeof v !== "number") return null;
  return Math.max(0, Math.floor(v));
}

/** A `&self` shared-borrow arg of the primitive receiver (for a tslib fn). */
function primRecvRef(m: MemberExpression, analysis: ModuleAnalysis): HirArg {
  return { borrow: "ref", expr: lowerExpr(m.object, analysis) };
}

/** An owned `f64` arg (floored in tslib, the `at`/`slice` precedent). */
function ownedArg(e: Expression, analysis: ModuleAnalysis): HirArg {
  return { borrow: "owned", expr: lowerExpr(e, analysis) };
}

/** A `&`-borrowed arg (a `&str` for a tslib string fn). */
function refArg(e: Expression, analysis: ModuleAnalysis): HirArg {
  return { borrow: "ref", expr: lowerExpr(e, analysis) };
}

/**
 * A `&str`-pattern arg (series 083). `str::contains`/`starts_with`/`ends_with`
 * take an `impl Pattern` (a `&str`, **not** a `&String`), so a `String`/`&String`/
 * `&str` operand is uniformly coerced via `AsRef::<str>::as_ref(&(expr))`. Wrapped
 * `raw` so the emitter renders the coercion verbatim around the inner expr.
 */
function strPatternArg(e: Expression, analysis: ModuleAnalysis): HirExpr {
  // Fast path (#88, "2b" literal interning): a bare string *literal* is already a
  // `&'static str` — the exact pattern type every `strPatternArg` call site wants
  // (`str::contains`/`split`/`index_of`/`replace`, all `&str`/`impl Pattern`). Emit
  // it verbatim and skip the `AsRef::<str>::as_ref(&"…".to_string())` wrapper, which
  // allocated a throwaway `String` per call just to borrow it back down to `&str`.
  if (e.type === "Literal" && typeof (e as Literal).value === "string") {
    return { kind: "raw", text: JSON.stringify((e as Literal).value) };
  }
  return {
    kind: "call",
    callee: "AsRef::<str>::as_ref",
    args: [{ borrow: "ref", expr: lowerExpr(e, analysis) }],
  };
}

/**
 * String receiver methods (029 String rows). Native where Rust matches JS;
 * `tslib::string::*` only for a JS quirk (`replace`-first, empty-sep split, the
 * UTF-16 slice family). `null` → not modeled → fall through.
 */
function stringMethod(
  methodName: string,
  m: MemberExpression,
  call: CallExpression,
  analysis: ModuleAnalysis,
): HirExpr | null {
  const recv = (): HirExpr => lowerExpr(m.object, analysis);
  const args = call.arguments;
  const method = (name: string, methodArgs: HirExpr[] = []): HirExpr => ({
    kind: "method",
    receiver: recv(),
    name,
    args: methodArgs,
  });

  // `.toString()` — identity on `String`. Native.
  if (methodName === "toString" && args.length === 0) return method("clone");
  // Case + trim — native, Rust Unicode casing ≈ JS (documented divergence).
  if (methodName === "toUpperCase" && args.length === 0)
    return method("to_uppercase");
  if (methodName === "toLowerCase" && args.length === 0)
    return method("to_lowercase");
  if (methodName === "trim" && args.length === 0) return method("trim");
  if (methodName === "trimStart" && args.length === 0)
    return method("trim_start");
  if (methodName === "trimEnd" && args.length === 0) return method("trim_end");
  // Predicates — native (arg is `&str`; `.contains`/`.starts_with`/`.ends_with`
  // take `&str`, and a `String` derefs so a bare arg works via `&`).
  if (
    (methodName === "includes" ||
      methodName === "startsWith" ||
      methodName === "endsWith") &&
    args.length === 1 &&
    args[0]
  ) {
    const rustName =
      methodName === "includes"
        ? "contains"
        : methodName === "startsWith"
          ? "starts_with"
          : "ends_with";
    return {
      kind: "method",
      receiver: recv(),
      name: rustName,
      args: [strPatternArg(args[0], analysis)],
    };
  }
  // `.repeat(n)` — native; `n` is `f64` → `as usize`.
  if (methodName === "repeat" && args.length === 1 && args[0]) {
    return {
      kind: "method",
      receiver: recv(),
      name: "repeat",
      args: [{ kind: "cast", expr: lowerExpr(args[0], analysis), ty: { kind: "usize" } }],
    };
  }
  // `.replace(a, b)` — first match only (JS quirk) → tslib. Args are `&str`.
  if (methodName === "replace" && args.length === 2 && args[0] && args[1]) {
    return {
      kind: "call",
      callee: "tslib::string::replace_first",
      args: [
        primRecvRef(m, analysis),
        { borrow: "owned", expr: strPatternArg(args[0], analysis) },
        { borrow: "owned", expr: strPatternArg(args[1], analysis) },
      ],
    };
  }
  // `.replaceAll(a, b)` — all matches → native `.replace` (`&str` pattern + repl).
  if (methodName === "replaceAll" && args.length === 2 && args[0] && args[1]) {
    return {
      kind: "method",
      receiver: recv(),
      name: "replace",
      args: [strPatternArg(args[0], analysis), strPatternArg(args[1], analysis)],
    };
  }
  // `.split(sep)` — native for a non-empty literal sep; empty sep → tslib
  // (JS splits into code units, quirk). A non-literal sep routes to tslib too so
  // the empty-string case is handled at runtime.
  if (methodName === "split" && args.length === 1 && args[0]) {
    const sep = args[0];
    if (sep.type === "Literal" && (sep as Literal).value === "") {
      return {
        kind: "call",
        callee: "tslib::string::split_chars",
        args: [primRecvRef(m, analysis)],
      };
    }
    return {
      kind: "call",
      callee: "tslib::string::split",
      args: [
        primRecvRef(m, analysis),
        { borrow: "owned", expr: strPatternArg(sep, analysis) },
      ],
    };
  }
  // `.slice`/`.substring`/`.charAt` — UTF-16 vs char/byte quirk → tslib.
  if (methodName === "slice" && (args.length === 1 || args.length === 2)) {
    const a1 = args[0];
    if (!a1) return null;
    const callArgs: HirArg[] = [primRecvRef(m, analysis), ownedArg(a1, analysis)];
    if (args.length === 2 && args[1])
      callArgs.push(ownedArg(args[1], analysis));
    return {
      kind: "call",
      callee:
        args.length === 2 ? "tslib::string::str_slice" : "tslib::string::str_slice_from",
      args: callArgs,
    };
  }
  if (methodName === "substring" && args.length === 2 && args[0] && args[1]) {
    return {
      kind: "call",
      callee: "tslib::string::substring",
      args: [
        primRecvRef(m, analysis),
        ownedArg(args[0], analysis),
        ownedArg(args[1], analysis),
      ],
    };
  }
  if (methodName === "charAt" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::string::char_at",
      args: [primRecvRef(m, analysis), ownedArg(args[0], analysis)],
    };
  }
  // `.at(i)` → `tslib::string::str_at` → `Option<String>` (series 098): negative
  // from the end, out-of-range → `None` → JS `undefined` (the 066 model; distinct
  // from `charAt`'s `""`). Fixes the prior mis-route to `tslib::array::at`.
  if (methodName === "at" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::string::str_at",
      args: [primRecvRef(m, analysis), ownedArg(args[0], analysis)],
    };
  }
  // `.indexOf(needle[, from])` → `tslib::string::index_of` → `f64` (`-1` sentinel,
  // char-indexed). Omitted `from` defaults to 0 (series 098).
  if (
    methodName === "indexOf" &&
    (args.length === 1 || args.length === 2) &&
    args[0]
  ) {
    const from: HirArg =
      args.length === 2 && args[1]
        ? ownedArg(args[1], analysis)
        : { borrow: "owned", expr: { kind: "number", value: 0 } };
    return {
      kind: "call",
      callee: "tslib::string::index_of",
      args: [
        primRecvRef(m, analysis),
        { borrow: "owned", expr: strPatternArg(args[0], analysis) },
        from,
      ],
    };
  }
  // `.lastIndexOf(needle)` → `tslib::string::last_index_of` → `f64` (series 098).
  // The 2-arg `fromIndex` form stays a residual (falls through).
  if (methodName === "lastIndexOf" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::string::last_index_of",
      args: [
        primRecvRef(m, analysis),
        { borrow: "owned", expr: strPatternArg(args[0], analysis) },
      ],
    };
  }
  // `.padStart(n)` / `.padEnd(n)` — the 1-arg default-space form (series 098);
  // the 2-arg form falls through to `tryTslibMethod` (already shipped in 083).
  if (
    (methodName === "padStart" || methodName === "padEnd") &&
    args.length === 1 &&
    args[0]
  ) {
    const fn = methodName === "padStart" ? "pad_start" : "pad_end";
    return {
      kind: "call",
      callee: `tslib::string::${fn}`,
      args: [
        primRecvRef(m, analysis),
        ownedArg(args[0], analysis),
        { borrow: "ref", expr: { kind: "string", value: " " } },
      ],
    };
  }
  // `a.concat(b, c, …)` ≡ `a + b + c` → the 080 `strConcat` node (`format!`);
  // series 098. A spread arg isn't modeled (falls through).
  if (
    methodName === "concat" &&
    args.length >= 1 &&
    args.every((a) => a.type !== "SpreadElement")
  ) {
    return {
      kind: "strConcat",
      parts: [recv(), ...args.map((a) => lowerExpr(a as Expression, analysis))],
    };
  }
  // `.split(sep, limit)` — truncate to at most `limit` pieces (series 098). An
  // empty-string separator keeps the `split_chars` char-unit quirk.
  if (methodName === "split" && args.length === 2 && args[0] && args[1]) {
    const sep = args[0];
    if (sep.type === "Literal" && (sep as Literal).value === "") {
      return {
        kind: "call",
        callee: "tslib::string::split_chars_limit",
        args: [primRecvRef(m, analysis), ownedArg(args[1], analysis)],
      };
    }
    return {
      kind: "call",
      callee: "tslib::string::split_limit",
      args: [
        primRecvRef(m, analysis),
        { borrow: "owned", expr: strPatternArg(sep, analysis) },
        ownedArg(args[1], analysis),
      ],
    };
  }
  // `.substr(start[, length])` — deprecated but common (series 098); char-indexed,
  // negative `start` from the end.
  if (methodName === "substr" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::string::substr_from",
      args: [primRecvRef(m, analysis), ownedArg(args[0], analysis)],
    };
  }
  if (methodName === "substr" && args.length === 2 && args[0] && args[1]) {
    return {
      kind: "call",
      callee: "tslib::string::substr",
      args: [
        primRecvRef(m, analysis),
        ownedArg(args[0], analysis),
        ownedArg(args[1], analysis),
      ],
    };
  }
  // Deferred surface (series 098): a `String` receiver calling a known-unsupported
  // method fails loud with the reason, not a downstream cargo error.
  const deferred = STRING_METHOD_DEFERRED[methodName];
  if (deferred) throw new UnsupportedError({ type: deferred });
  return null;
}

/**
 * Number receiver methods (029 Number/Math rows). `.toString()` routes through
 * `tslib::number::to_js_string` for JS number→string fidelity (`-0`, magnitudes);
 * `.toFixed`/`.toString(radix)` are tslib. `Math.*` statics are handled in the
 * static-call path, not here (their receiver is the `Math` object).
 */
function numberMethod(
  methodName: string,
  m: MemberExpression,
  call: CallExpression,
  analysis: ModuleAnalysis,
): HirExpr | null {
  const args = call.arguments;
  // `n.toString()` (no radix) → tslib::number::to_js_string (JS fidelity).
  if (methodName === "toString" && args.length === 0) {
    return {
      kind: "call",
      callee: "tslib::number::to_js_string",
      args: [ownedArg(m.object as Expression, analysis)],
    };
  }
  // `n.toString(radix)` → tslib::number::to_radix.
  if (methodName === "toString" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::number::to_radix",
      args: [
        ownedArg(m.object as Expression, analysis),
        ownedArg(args[0], analysis),
      ],
    };
  }
  // `n.toFixed(d)` → tslib::number::to_fixed.
  if (methodName === "toFixed" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::number::to_fixed",
      args: [
        ownedArg(m.object as Expression, analysis),
        ownedArg(args[0], analysis),
      ],
    };
  }
  return null;
}

/**
 * `Math.*` / `Number.parseInt|parseFloat` global statics (series 083). Native
 * `f64` methods where the semantics match JS; `tslib` for the parse quirks; a
 * `min!`/`max!` macro (the sanctioned variadic Tm route) for `Math.min`/`max`.
 * Returns null for an unmodeled static (→ fall through → fail-loud).
 */
function lowerNumberStatic(
  global: string,
  methodName: string,
  call: CallExpression,
  analysis: ModuleAnalysis,
): HirExpr | null {
  const args = call.arguments as Expression[];
  // A method receiver that is a bare number literal (`3.7`) is an ambiguous
  // `{float}` in Rust (`3.7.floor()` fails E0689) — cast a literal receiver to
  // `f64` (`(3.7 as f64).floor()`). A non-literal `f64` receiver is unambiguous.
  // A receiver built ONLY from numeric literals (a single literal, or literal
  // arithmetic like `1.2 + 2.9`) has no typed leaf to anchor Rust's inference, so a
  // `.floor()`/`.sqrt()` on it is rejected as an ambiguous `{float}` (E0689, #73). A
  // receiver holding any identifier / call is already anchored. Arithmetic ops only:
  // a bitwise binary is already concrete (`i128`), so it needs no cast.
  const isPureNumericLiteral = (e: HirExpr): boolean =>
    e.kind === "number" ||
    (e.kind === "unary" && e.op === "-" && isPureNumericLiteral(e.operand)) ||
    (e.kind === "binary" &&
      !e.bitwise &&
      ["+", "-", "*", "/", "%"].includes(e.op) &&
      isPureNumericLiteral(e.left) &&
      isPureNumericLiteral(e.right));
  const f64Recv = (e: Expression): HirExpr => {
    const lowered = lowerExpr(e, analysis);
    return isPureNumericLiteral(lowered)
      ? { kind: "cast", expr: lowered, ty: { kind: "f64" } }
      : lowered;
  };
  if (global === "Math") {
    // `Math.random()` is fail-loud (series 089) — a hidden global PRNG cannot be
    // differential-stable against JS. Redirect to the explicit-seed `rng(seed)`
    // shim from "@ttr/std" (mirrors the bare-`JSON.parse` redirect precedent).
    if (methodName === "random") {
      throw new UnsupportedError({
        type: '`Math.random` is not accepted — import `rng` from "@ttr/std" and call `rng(seed)` (an explicit seed makes the stream differential-stable)',
      });
    }
    // `Math.floor/ceil/round/abs/trunc/sign/sqrt` — unary native `f64` methods.
    const unary: Record<string, string> = {
      floor: "floor",
      ceil: "ceil",
      round: "round",
      abs: "abs",
      trunc: "trunc",
      sqrt: "sqrt",
    };
    if (unary[methodName] && args.length === 1 && args[0]) {
      return {
        kind: "method",
        receiver: f64Recv(args[0]),
        name: unary[methodName] as string,
        args: [],
      };
    }
    // `Math.min`/`Math.max` — binary → native `f64::min`/`max`; variadic →
    // `min!`/`max!` macro (029 Tm). NaN-propagating like JS.
    if (
      (methodName === "min" || methodName === "max") &&
      args.length >= 1 &&
      args.every((a) => a)
    ) {
      if (args.length === 2 && args[0] && args[1]) {
        return {
          kind: "method",
          receiver: f64Recv(args[0]),
          name: methodName,
          args: [lowerExpr(args[1], analysis)],
        };
      }
      return {
        kind: "jsMinMax",
        op: methodName,
        args: args.map((a) => lowerExpr(a, analysis)),
      };
    }
    return null;
  }
  // `Number.parseInt(s[, radix])` / `Number.parseFloat(s)` → tslib (radix +
  // trailing-garbage tolerance quirks).
  if (methodName === "parseInt" && (args.length === 1 || args.length === 2)) {
    const a0 = args[0];
    if (!a0) return null;
    const callArgs: HirArg[] = [refArg(a0, analysis)];
    callArgs.push(
      args.length === 2 && args[1]
        ? ownedArg(args[1], analysis)
        : { borrow: "owned", expr: { kind: "number", value: 10 } },
    );
    return { kind: "call", callee: "tslib::number::parse_int", args: callArgs };
  }
  if (methodName === "parseFloat" && args.length === 1 && args[0]) {
    return {
      kind: "call",
      callee: "tslib::number::parse_float",
      args: [refArg(args[0], analysis)],
    };
  }
  return null;
}

/**
 * Lower a static call on the global `Object` (series 041). `keys`/`values` map
 * to a native iteration of the `IndexMap`-backed record (insertion order matches
 * JS); everything else — `entries` (needs pair-array access) and `assign` (merge
 * + variadic sources) included — is fail-loud, a tracked residual.
 */
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
const STD_IO_TARGETS: Record<
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
function lowerStdIoCall(
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
const IO_ASYNC_TARGETS: Record<string, Record<string, string>> = {
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
function lowerIoAsyncCall(
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

function lowerStdShimCall(
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
function assertModeledParseTarget(ty: RustType, analysis: ModuleAnalysis): void {
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
function redirectBareJson(e: Expression): void {
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
function redirectBareMathRandom(e: Expression): void {
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
function isParseJsonShimCall(e: Expression, analysis: ModuleAnalysis): boolean {
  if (e.type !== "CallExpression") return false;
  const callee = (e as CallExpression).callee;
  return (
    callee.type === "Identifier" &&
    analysis.stdShim.get((callee as Identifier).name) === "parseJson"
  );
}

/** Is `e` a call to the `@ttr/std` `rng(seed)` intrinsic (series 089)? Keyed off
 * the local alias recorded from the reserved-specifier import. */
function isRngShimCall(e: Expression, analysis: ModuleAnalysis): boolean {
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
const JSON_VALUE_METHODS = new Map<string, string>([
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
function isJsonBoundaryShimCall(e: Expression, analysis: ModuleAnalysis): boolean {
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
function isJsonValueExpr(e: Expression, analysis: ModuleAnalysis): boolean {
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
function isRngMethodInit(e: Expression, analysis: ModuleAnalysis): boolean {
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
function ioBindingRustType(init: HirExpr): RustType | null {
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
function isOptionReturningIoCall(e: Expression, analysis: ModuleAnalysis): boolean {
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
function isWriterReceiver(obj: Expression, analysis: ModuleAnalysis): boolean {
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
function isStdIoInit(e: Expression, analysis: ModuleAnalysis): boolean {
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

/** Is `e` a direct call to a declared generator (`g()`) — an `impl Iterator`
 * source for the 065 collecting consumers? */
function isGeneratorCall(e: Expression, analysis: ModuleAnalysis): boolean {
  return (
    e.type === "CallExpression" &&
    (e as CallExpression).callee.type === "Identifier" &&
    analysis.generators.has(
      ((e as CallExpression).callee as Identifier).name,
    )
  );
}

/** Is `e` an `Array.from(src, fn)` mapping-overload call (series 075)? */
function isArrayFromMapCall(e: Expression): boolean {
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
function resolveGeneratorNext(
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
function collectSteppedGenerators(
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
function isObjectEntriesCall(e: Expression): boolean {
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

function lowerObjectStatic(
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
function mapBuildParts(
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
function scalarKeyElemType(e: Expression, asKey: boolean): RustType {
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
function lowerMapNew(expr: NewExpression, analysis: ModuleAnalysis): HirExpr {
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
function lowerSetNew(expr: NewExpression, analysis: ModuleAnalysis): HirExpr {
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
function keyElemFromVecElem(vecElem: RustType): RustType {
  return vecElem.kind === "f64" ? { kind: "orderedFloat" } : vecElem;
}

/**
 * JS `Date` accessor → the `tslib::date::Date` snake_case method (series 102).
 * The short local accessors alias their `getUTC*` twin (UTC-normalized). All are
 * `&self` and take no args; `toJSON` aliases `toISOString`.
 */
const DATE_METHODS: Record<string, string> = {
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
const STRICT_ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z)?$/;

/**
 * A `clock(epochMs)` handle expression (series 102): a `clockBindings` identifier
 * or a direct `clock(...)` std-shim call (recognized by specifier, so an aliased
 * import routes too). Used to type a `.date()` bridge + route handle methods.
 */
function isClockExpr(
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
function isDateExpr(
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
function lowerDateNew(expr: NewExpression, analysis: ModuleAnalysis): HirExpr {
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
function lowerNew(expr: NewExpression, analysis: ModuleAnalysis): HirExpr {
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

function lowerMember(
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
function baseHopsToField(
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

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Lower a `Map` key / `Set` element type per the 061 key policy. `string` →
 * `String`; a scalar `number` → `OrderedFloat<f64>` (faithful to JS
 * SameValueZero); a named struct → its `struct` type (its `Hash+Eq` eligibility
 * — no `f64` field — is enforced later in `collectHashEqStructs`); `boolean` →
 * `bool`. Anything else is fail-loud (unhashable key).
 */
function lowerMapKeyType(
  ty: TSType,
  structs: Set<string>,
  typeParams: Set<string> = EMPTY_TYPE_PARAMS,
): RustType {
  switch (ty.type) {
    case "TSStringKeyword":
      return { kind: "String" };
    case "TSNumberKeyword":
      return { kind: "orderedFloat" };
    case "TSBooleanKeyword":
      return { kind: "bool" };
    default: {
      const lowered = lowerType(ty, structs, typeParams);
      if (lowered.kind === "struct") return lowered;
      throw new UnsupportedError({
        type: "Map/Set key type that is not string, number, boolean, or a struct",
      });
    }
  }
}

/**
 * Is a field type a **direct scalar `f64`** on the key struct (series 074)? Only a
 * bare `f64` — the newtype's custom impls wrap it in a single `OrderedFloat(...)`
 * at hash/eq time. An `f64` inside a `Vec`/`Option`/`set`/sub-struct is NOT a plain
 * scalar leaf: it needs an element-wise wrap this first slice does not emit, so
 * `hasBuriedF64` catches it and the key struct stays **fail-loud** (follow-up).
 */
function isDirectF64Leaf(ty: RustType): boolean {
  return ty.kind === "f64";
}

/**
 * Does a field type hide an `f64` anywhere *except* as a direct scalar field
 * (series 074)? An `f64` inside a `Vec`/`Option`/`set` (needs an element-wise
 * OrderedFloat wrap) or buried in a *sub-struct* (the parent newtype can't reach it
 * through the sub-struct's own `===`-faithful `PartialEq`). A key struct with one
 * stays **fail-loud** in this first slice (recurse in a follow-up).
 */
function hasBuriedF64(
  ty: RustType,
  structFields: Map<string, { name: string; ty: RustType }[]>,
  seen: Set<string> = new Set(),
): boolean {
  switch (ty.kind) {
    case "f64":
      // An `f64` reached *through* a collection/sub-struct — not a direct scalar.
      return seen.size > 0;
    case "vec":
      return hasBuriedF64(ty.elem, structFields, addSeen(seen, "vec"));
    case "option":
      return hasBuriedF64(ty.inner, structFields, addSeen(seen, "option"));
    case "set":
      return hasBuriedF64(ty.elem, structFields, addSeen(seen, "set"));
    case "struct": {
      if (seen.has(ty.name)) return false;
      const fields = structFields.get(ty.name);
      if (!fields) return false;
      const next = new Set(seen).add(ty.name);
      return fields.some((f) => hasBuriedF64(f.ty, structFields, next));
    }
    default:
      return false;
  }
}

/** A `seen` set marked non-empty (so a reached `f64` counts as "buried"). */
function addSeen(seen: Set<string>, tag: string): Set<string> {
  return new Set(seen).add(`${tag}#${seen.size}`);
}

/**
 * Synthesize the SameValueZero key newtype item `<Struct>Key(<Struct>)` for an
 * f64-bearing key struct (series 074). Records each wrapped field's `f64`-leaf
 * flag so the emitter wraps `f64` leaves in `OrderedFloat` at hash/eq time and
 * compares/hashes the rest with plain `==`/`.hash()`.
 */
function synthesizeStructKey(
  struct: string,
  structFields: Map<string, { name: string; ty: RustType }[]>,
): HirStructKey {
  const fields = (structFields.get(struct) ?? []).map((f) => ({
    name: f.name,
    f64: isDirectF64Leaf(f.ty),
  }));
  return { kind: "structKey", name: structKeyName(struct), struct, fields };
}

/**
 * Retarget every `Map`/`Set` key/element type carried on an item (series 074) —
 * struct/class field types and fn param/return types — to the `structKey`
 * newtype when the key struct is f64-bearing.
 */
function retargetItemTypes(item: HirItem, structKeys: Set<string>): void {
  const fn = (f: HirFn): void => {
    for (const p of f.params) retargetStructKey(p.ty, structKeys);
    retargetStructKey(f.ret, structKeys);
  };
  switch (item.kind) {
    case "struct":
    case "class":
      for (const field of item.fields) retargetStructKey(field.ty, structKeys);
      if (item.kind === "class") {
        if (item.ctor) fn(item.ctor);
        for (const m of item.methods) fn(m);
        for (const s of item.statics ?? []) fn(s);
      }
      return;
    case "fn":
      fn(item);
      return;
    case "trait":
      for (const m of item.methods) fn(m);
      return;
    default:
      return;
  }
}

/**
 * Is a type `Hash + Eq` eligible (a valid `Map` key / `Set` element)? Scalars
 * except `f64` are; `OrderedFloat` is; a struct is iff every field is (recursed).
 * An `f64` (a raw number field) is **not** — a struct with one is fail-loud.
 */
function isTypeHashEq(
  ty: RustType,
  structFields: Map<string, { name: string; ty: RustType }[]>,
  seen: Set<string> = new Set(),
): boolean {
  switch (ty.kind) {
    case "String":
    case "str":
    case "bool":
    case "i64":
    case "usize":
    case "orderedFloat":
      return true;
    case "vec":
      return isTypeHashEq(ty.elem, structFields, seen);
    case "option":
      return isTypeHashEq(ty.inner, structFields, seen);
    case "struct": {
      if (seen.has(ty.name)) return true;
      const fields = structFields.get(ty.name);
      if (!fields) return false;
      const next = new Set(seen).add(ty.name);
      return fields.every((f) => isTypeHashEq(f.ty, structFields, next));
    }
    default:
      return false; // f64, fnPtr, … are not Hash+Eq
  }
}

/**
 * Scan the resolved `bindingTypes` for struct `Map` keys / `Set` elements and
 * classify each (series 061 + 074), populating `analysis.hashEqStructs` and
 * `analysis.structKeyStructs`:
 *
 *  - **no `f64` anywhere** (`isTypeHashEq`) → the 061 path: derive
 *    `Hash, PartialEq, Eq` on the struct, key type = the struct itself.
 *  - **a *direct scalar* `f64` field** (`isDirectF64Leaf`, no `f64` buried in a
 *    collection or sub-struct) → the 074 path: a synthesized SameValueZero key
 *    newtype `<name>Key(<name>)`, key type = the newtype.
 *  - **an `f64` inside a `Vec`/`Option`/`set` or a sub-struct field**
 *    (`hasBuriedF64`) → **fail-loud** (needs an element-wise / nested wrap this
 *    slice doesn't emit; a follow-up recurses).
 */
function collectHashEqStructs(analysis: ModuleAnalysis): {
  hashEq: Set<string>;
  structKey: Set<string>;
} {
  const hashEq = new Set<string>();
  const structKey = new Set<string>();
  const consider = (ty: RustType): void => {
    if (ty.kind !== "struct") return;
    if (isTypeHashEq(ty, analysis.structFields)) {
      hashEq.add(ty.name);
      return;
    }
    const fields = analysis.structFields.get(ty.name) ?? [];
    // An `f64` buried in a `Vec`/`Option`/`set` or a sub-struct field is out of
    // this first slice's reach (needs an element-wise / nested wrap) — fail-loud.
    if (fields.some((f) => hasBuriedF64(f.ty, analysis.structFields))) {
      throw new UnsupportedError({
        type: `struct '${ty.name}' used as a Map key / Set element has an f64 nested inside a collection or sub-struct field — fail-loud (follow-up)`,
      });
    }
    // A direct scalar `f64` field → the 074 SameValueZero key newtype.
    if (fields.some((f) => isDirectF64Leaf(f.ty))) {
      structKey.add(ty.name);
      return;
    }
    // No `f64` reachable, yet not `Hash+Eq` eligible (an `fnPtr` field, …) — the
    // 061 non-hashable-key rejection stands.
    throw new UnsupportedError({
      type: `struct '${ty.name}' used as a Map key / Set element has a non-Hash+Eq field`,
    });
  };
  for (const ty of analysis.bindingTypes.values()) {
    if (ty.kind === "hashmap") consider(ty.key);
    if (ty.kind === "set") consider(ty.elem);
  }
  return { hashEq, structKey };
}

/**
 * Union pre-pass (series 093). Walks the whole tree once, synthesizing a
 * {@link HirUnionEnum} per literal union — named by its `type X = …` alias, or
 * `__anonymous_union_<hash>` for an inline/anonymous union (structurally deduped).
 * Runs before `structFields`/`bindingTypes` so a union reference resolves
 * nominally. A `type` alias with a non-union non-trivial RHS is fail-loud here.
 */
function collectUnions(program: Program, analysis: ModuleAnalysis): void {
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
    };
    const rhs = decl.typeAnnotation;
    if (rhs.type === "TSUnionType") {
      const real = (rhs as unknown as { types: TSType[] }).types.filter(
        (m) => !isNullishMember(m),
      );
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
      const nondisc = classifyNonDiscriminatedUnion(real);
      if (nondisc) {
        aliasUnionNodes.add(rhs);
        registerNonDiscriminatedUnion(decl.id.name, nondisc, analysis);
        continue;
      }
      // Mixed literal + object members (G, `"loading" | { kind: "done" }`) —
      // irregular two-level narrowing, a documented residual (design §9). Precise
      // fail-loud beats a downstream "unresolved type" error.
      if (isMixedLiteralObjectUnion(real)) {
        throw new UnsupportedError({
          type: `union alias '${decl.id.name}' mixes literal and object members (e.g. \`"loading" | { kind: "done" }\`) — not modeled yet (series 093 residual). Give every member a shared discriminant field, or split the object part into its own discriminated-union alias`,
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
    const nondisc = classifyNonDiscriminatedUnion(real);
    if (nondisc)
      registerNonDiscriminatedUnion(anonNonDiscUnionName(nondisc), nondisc, analysis);
  });
}

/**
 * Register (idempotently) a discriminated object union → a struct-variant enum
 * (series 093, stage 1b). Field types lower via `lowerType` (the struct set is
 * populated); the discriminant field is dropped from each variant and drives the
 * variant name + `discValue`. Derives `Clone, Debug, PartialEq` (a struct variant
 * may hold a `String`/struct field, so not `Copy`; no `Display`).
 */
function registerDiscriminatedUnion(
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
function registerNamedDiscriminatedUnion(
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
 * Register (idempotently) a primitive/mixed union → a **newtype**-variant enum
 * narrowed by `typeof` (series 093, stage 1d, case F): `Str(String)`, `Num(f64)`,
 * `Bool(bool)`, `Point(Point)`. Derives `Clone, Debug, PartialEq` (a `String`/struct
 * payload → no `Copy`; no `Display`). `narrow:"typeof"` drives the consumption path.
 */
function registerPrimitiveUnion(
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
function registerNonDiscriminatedUnion(
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

/** Register (idempotently) a literal-union enum + merge its name into `structs`. */
function registerUnionEnum(
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
function walkUnionTypes(node: unknown, visit: (ty: TSType) => void): void {
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
function coerceLiteralToUnion(
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
function unionTypeOfOperand(
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
function coerceObjectToUnion(
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

  // Non-discriminated (E): match the object's exact field-name set to a variant.
  if (info.narrow === "in") {
    const keys = [...propByName.keys()].sort();
    const variant = info.variants.find((vt) => {
      const set = vt.fields.map((f) => f.name).sort();
      return set.length === keys.length && set.every((n, i) => n === keys[i]);
    });
    if (!variant) return null;
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
function inferScalarInner(
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
function newtypeInnerMatches(a: RustType, b: RustType): boolean {
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
function coerceScalarToUnion(
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
function primMemberOf(t: RustType): PrimMember | null {
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
function synthPrimUnionForArms(
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

/**
 * `++`/`--` in a **statement** position (series 096) → the `assign` node `arg += 1`
 * / `arg -= 1`. Prefix/postfix collapse (the produced value is discarded). Supports
 * every target the assign supports — local, field (`this.n++`), index (`a[i]++`).
 */
function lowerUpdateAssign(
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
function lowerUpdateValue(
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
function lowerTemplate(
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

/**
 * Lower a ternary in an *untyped* value position (series 094). Homogeneous arms (or
 * arms the light typer can't resolve) become a bare `if`/`else` expression — rustc
 * enforces arm-type unity. **Heterogeneous** arms auto-synthesize an anonymous
 * primitive union (the chosen policy) and wrap each arm into its variant; a
 * non-primitive arm with no type context is fail-loud (annotate a declared union).
 */
function lowerCond(
  c: { test: Expression; consequent: Expression; alternate: Expression },
  analysis: ModuleAnalysis,
): HirExpr {
  const test = truthyCond(c.test, analysis);
  const ta = inferScalarInner(c.consequent, analysis);
  const tb = inferScalarInner(c.alternate, analysis);
  if (ta && tb && !newtypeInnerMatches(ta, tb)) {
    const info = synthPrimUnionForArms(ta, tb, analysis);
    if (info) {
      const conseq = coerceScalarToUnion(c.consequent, info, analysis);
      const alt = coerceScalarToUnion(c.alternate, info, analysis);
      if (conseq && alt) return { kind: "cond", test, conseq, alt };
    }
    throw new UnsupportedError({
      type: "heterogeneous ternary in an untyped value position with a non-primitive arm — annotate the target with a declared union type (`const x: A | B = …`)",
    });
  }
  return {
    kind: "cond",
    test,
    conseq: lowerExpr(c.consequent, analysis),
    alt: lowerExpr(c.alternate, analysis),
  };
}

/**
 * A discriminated-union `switch (obj.kind)` scrutinee (series 093, 1b): returns the
 * object binding name + its union enum when the discriminant is `<id>.<discField>`
 * over a discriminated-union binding, else null.
 */
function discriminatedScrutinee(
  disc: Expression,
  analysis: ModuleAnalysis,
): { objName: string; info: HirUnionEnum } | null {
  if (disc.type !== "MemberExpression") return null;
  const m = disc as MemberExpression;
  if (m.computed || m.object.type !== "Identifier" || m.property.type !== "Identifier") {
    return null;
  }
  const objName = (m.object as Identifier).name;
  const t = analysis.bindingTypes.get(objName);
  if (t?.kind !== "struct") return null;
  const info = analysis.unionEnums.get(t.name);
  if (!info || info.discField !== (m.property as Identifier).name) return null;
  return { objName, info };
}

/** Does the AST subtree read `<objName>.<anything>` (any non-computed member access)? */
function readsAnyMemberField(node: unknown, objName: string): boolean {
  if (Array.isArray(node)) {
    return node.some((n) => readsAnyMemberField(n, objName));
  }
  if (!node || typeof node !== "object") return false;
  const n = node as {
    type?: string;
    computed?: boolean;
    object?: { type?: string; name?: string };
    property?: { type?: string };
  };
  if (
    n.type === "MemberExpression" &&
    !n.computed &&
    n.object?.type === "Identifier" &&
    n.object.name === objName &&
    n.property?.type === "Identifier"
  ) {
    return true;
  }
  for (const k in node as Record<string, unknown>) {
    if (k === "type") continue;
    if (readsAnyMemberField((node as Record<string, unknown>)[k], objName)) {
      return true;
    }
  }
  return false;
}

/** Does the AST subtree read `<objName>.<field>` (a non-computed member access)? */
function readsMemberField(
  node: unknown,
  objName: string,
  field: string,
): boolean {
  if (Array.isArray(node)) {
    return node.some((n) => readsMemberField(n, objName, field));
  }
  if (!node || typeof node !== "object") return false;
  const n = node as {
    type?: string;
    computed?: boolean;
    object?: { type?: string; name?: string };
    property?: { type?: string; name?: string };
  };
  if (
    n.type === "MemberExpression" &&
    !n.computed &&
    n.object?.type === "Identifier" &&
    n.object.name === objName &&
    n.property?.type === "Identifier" &&
    n.property.name === field
  ) {
    return true;
  }
  for (const k in node as Record<string, unknown>) {
    if (k === "type") continue;
    if (readsMemberField((node as Record<string, unknown>)[k], objName, field)) {
      return true;
    }
  }
  return false;
}

function lowerType(
  ty: TSType,
  structs: Set<string>,
  // In-scope generic type-param names (series 081). A bare `TSTypeReference` whose
  // name is here resolves to a `{kind:"param"}` `RustType` (a type variable),
  // instead of failing loud as an undeclared struct. Threaded through recursion so
  // a nested `Vec<T>` / `Option<T>` resolves its inner `T` too. Empty by default
  // (a non-generic scope); the class/method path passes `analysis.typeParams`.
  typeParams: Set<string> = EMPTY_TYPE_PARAMS,
): RustType {
  switch (ty.type) {
    case "TSNumberKeyword":
      return { kind: "f64" };
    case "TSStringKeyword":
      return { kind: "String" };
    case "TSBooleanKeyword":
      return { kind: "bool" };
    case "TSVoidKeyword":
      return UNIT;
    case "TSArrayType": {
      // `T[]` / `number[]` shorthand → `Vec<T>` (series 081; equivalent to the
      // `Array<T>` reference form). The element resolves through the same
      // `typeParams` scope, so `U[]` in a generic method is `Vec<U>`.
      const elem = (ty as unknown as { elementType: TSType }).elementType;
      return { kind: "vec", elem: lowerType(elem, structs, typeParams) };
    }
    case "TSTypeReference": {
      const ref = ty as Extract<TSType, { type: "TSTypeReference" }>;
      // A bare `T` in scope of a generic class/method (series 081) → a type
      // variable. Checked *before* the built-in wrappers so a param named `Array`
      // etc. can't collide (a valid TS program never shadows those, but the scope
      // check is authoritative here). A param never carries type arguments.
      if (typeParams.has(ref.typeName.name) && !ref.typeArguments) {
        return { kind: "param", name: ref.typeName.name };
      }
      if (ref.typeName.name === "Promise") {
        // An `async fn`'s Rust return type is its resolved `T`, not a wrapper —
        // Rust wraps in `Future` implicitly. `Promise<void>` → `()`. In-dialect
        // `Promise` only ever annotates an `async` return (see design 014).
        const inner = ref.typeArguments?.params?.[0];
        if (!inner) throw new UnsupportedError(ty);
        return lowerType(inner, structs, typeParams);
      }
      if (ref.typeName.name === "Array") {
        const inner = ref.typeArguments?.params?.[0];
        if (!inner) throw new UnsupportedError(ty);
        return { kind: "vec", elem: lowerType(inner, structs, typeParams) };
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
          value: lowerType(value, structs, typeParams),
        };
      }
      if (ref.typeName.name === "Map") {
        // `Map<K, V>` → `IndexMap<K, V>` (series 061). The key type follows the
        // `Hash + Eq` key policy (`lowerMapKeyType`): `String`, gated struct, or
        // `OrderedFloat<f64>` for a scalar number.
        const [key, value] = ref.typeArguments?.params ?? [];
        if (!key || !value) throw new UnsupportedError(ty);
        return {
          kind: "hashmap",
          key: lowerMapKeyType(key, structs, typeParams),
          value: lowerType(value, structs, typeParams),
        };
      }
      if (ref.typeName.name === "Set") {
        // `Set<T>` → `IndexSet<T>` (series 061); element follows the key policy.
        const elem = ref.typeArguments?.params?.[0];
        if (!elem) throw new UnsupportedError(ty);
        return { kind: "set", elem: lowerMapKeyType(elem, structs, typeParams) };
      }
      // A reference to a declared `interface`/`class` → its nominal `struct` type.
      // A **generic instantiation** `Box<number>` (series 081) carries type
      // arguments → `{kind:"struct", name, args}` (emitted `Box<f64>`), so an
      // annotation `const b: Box<number> = …` matches the inferred ctor return. An
      // unknown type name stays fail-loud (`Promise`, `Map`, … are unsupported).
      if (structs.has(ref.typeName.name)) {
        const targs = ref.typeArguments?.params;
        if (targs && targs.length > 0) {
          return {
            kind: "struct",
            name: ref.typeName.name,
            args: targs.map((a) => lowerType(a, structs, typeParams)),
          };
        }
        return { kind: "struct", name: ref.typeName.name };
      }
      throw new UnsupportedError(ty);
    }
    case "TSFunctionType": {
      // A function-type annotation `(a: A, b: B) => R` → a bare `fn`-pointer
      // `fn(A, B) -> R` (series 048). oxc's TSFunctionType carries `params`
      // (each an `Identifier` with its own `typeAnnotation`) and a `returnType`
      // wrapped in a `TSTypeAnnotation`.
      const f = ty as unknown as {
        params: { typeAnnotation?: { typeAnnotation: TSType } | null }[];
        returnType?: { typeAnnotation: TSType } | null;
      };
      const params = f.params.map((p) => {
        const inner = p.typeAnnotation?.typeAnnotation;
        if (!inner) throw new UnsupportedError(ty);
        return lowerType(inner, structs, typeParams);
      });
      const ret = f.returnType
        ? lowerType(f.returnType.typeAnnotation, structs, typeParams)
        : UNIT;
      return { kind: "fnPtr", params, ret };
    }
    case "TSNullKeyword":
    case "TSUndefinedKeyword":
      // A bare `null`/`undefined` type (not in a `T | null` union) has no `T` to
      // make `Option` over — fail-loud (series 042).
      throw new UnsupportedError(ty);
    case "TSLiteralType": {
      // A singleton literal *type* used as a field annotation — `kind: "circle"` on
      // a discriminated-union member interface (series 093, 1d). We don't track
      // singleton types at the value level, so it widens to its base primitive (the
      // field holds that exact value at runtime; the union's variant already pins it).
      const lit = (ty as unknown as { literal?: { value?: unknown } }).literal;
      const v = lit?.value;
      if (typeof v === "string") return { kind: "String" };
      if (typeof v === "number") return { kind: "f64" };
      if (typeof v === "boolean") return { kind: "bool" };
      throw new UnsupportedError(ty);
    }
    case "TSUnionType": {
      // `T | undefined` / `T | null` / `T | null | undefined` → `Option<T>`
      // (series 042). A union of two *real* types is enum territory — fail-loud.
      const u = ty as unknown as { types: TSType[] };
      const real = u.types.filter(
        (m) => m.type !== "TSUndefinedKeyword" && m.type !== "TSNullKeyword",
      );
      const hasNullish = real.length !== u.types.length;
      // A literal union `"n" | "s"` / `0 | 1` → a nominal union `enum` (series 093),
      // referenced as `{kind:"struct", name}`. The name matches `collectUnions`'
      // registration (the alias name lives in `structs`/TSTypeReference; an inline
      // union computes the same `__anonymous_union_<hash>` here). A nullish member
      // wraps the enum in `Option`.
      const lits = classifyLiteralUnion(real);
      if (lits) {
        const inner: RustType = { kind: "struct", name: anonUnionName(lits) };
        return hasNullish ? { kind: "option", inner } : inner;
      }
      const dunion = classifyDiscriminatedUnion(real);
      if (dunion) {
        const inner: RustType = { kind: "struct", name: anonDiscUnionName(dunion) };
        return hasNullish ? { kind: "option", inner } : inner;
      }
      // Named-interface members (D): every member a bare `TSTypeReference`. The anon
      // name hashes the (order-independent) interface-name set, so it matches what
      // `collectUnions` registered — but only *if* it registered one (a discriminated
      // named union). `structs` carries every registered union name, so gate on that:
      // an unregistered named union (no shared discriminant) falls through to fail-loud.
      const namedNames = real.map((m) => namedRef(m));
      if (namedNames.every((n): n is string => n !== null)) {
        const nm = anonNamedUnionName(namedNames);
        if (structs.has(nm)) {
          const inner: RustType = { kind: "struct", name: nm };
          return hasNullish ? { kind: "option", inner } : inner;
        }
      }
      // Primitive / mixed union (F): `string | number`, `string | Point`. The anon
      // name hashes the primitive+named member set; gate on registration via `structs`.
      const prim = classifyPrimitiveUnion(real, (n) => structs.has(n));
      if (prim) {
        const nm = anonPrimUnionName(prim);
        if (structs.has(nm)) {
          const inner: RustType = { kind: "struct", name: nm };
          return hasNullish ? { kind: "option", inner } : inner;
        }
      }
      // Non-discriminated object union (E): `{a} | {b}`. Fully determined by the
      // type node (all inline objects, no discriminant), so no `structs` gate.
      const nondisc = classifyNonDiscriminatedUnion(real);
      if (nondisc) {
        const inner: RustType = { kind: "struct", name: anonNonDiscUnionName(nondisc) };
        return hasNullish ? { kind: "option", inner } : inner;
      }
      if (hasNullish && real.length === 1 && real[0]) {
        return { kind: "option", inner: lowerType(real[0], structs, typeParams) };
      }
      throw new UnsupportedError(ty);
    }
    default:
      throw new UnsupportedError(ty);
  }
}

/** A shared frozen empty set — the default `typeParams` of a non-generic `lowerType`
 * call (series 081), so no allocation per call and no accidental mutation. */
const EMPTY_TYPE_PARAMS: Set<string> = new Set();
