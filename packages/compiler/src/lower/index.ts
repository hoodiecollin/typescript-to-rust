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
} from "../analysis";
import { refineArena } from "../arena";
import type { SourceModule } from "../crate";
import type {
  CallExpression,
  ClassDeclaration,
  Expression,
  ExpressionStatement,
  FunctionDeclaration,
  Identifier,
  Literal,
  MemberExpression,
  MethodDefinition,
  ObjectPattern,
  Program,
  Statement,
  TSEnumDeclaration,
  TSInterfaceDeclaration,
  TSType,
  TSTypeAnnotation,
  VariableDeclaration,
} from "../ast";
import { DialectError, UnsupportedError } from "../errors";
import { normalizeArrows } from "./arrows";
import {
  applyBaseParamTraits,
  interfaceMethodSigs,
  lowerClass,
  lowerEnum,
  lowerInterface,
  synthesizeInterfaceTraits,
  synthesizeTraits,
} from "./classes";
import { lowerGenerator } from "./generators";
import { hirHasAwait, lowerErrorClass, makeFallible } from "./try-carrier";
import {
  DEFAULT_EXPORT_SYM,
  EMPTY_TYPE_PARAMS,
  ERR_STRING,
  UNIT,
} from "./constants";
import {
  isAstNode,
  isScalarType,
  refExpr,
  resultType,
  shortHash,
} from "./utils";
import {
  collectHashEqStructs,
  lowerType,
  retargetItemTypes,
  synthesizeStructKey,
} from "./types";
import {
  collectBindingTypes,
  collectBothPresentWarnings,
  collectSteppedGenerators,
  lowerExpr,
} from "./expressions";
import {
  collectReadonlyFields,
  collectStructFields,
  lowerStatements,
  lowerTyped,
} from "./statements";
import { receiverTypeOf } from "./typing";
import { collectUnions } from "./unions";
import type {
  HirErrorEnum,
  HirExpr,
  HirFn,
  HirItem,
  HirMod,
  HirModule,
  HirParam,
  HirStmt,
  RustType,
  SelfRecv,
  Vis,
} from "../hir";
import { refineBitwise } from "../bitwise";
import { refineNumerics } from "../numeric";
import { refineOwnership } from "../ownership";
import { refineTaskEscape } from "../task-escape";
import { refineRc } from "../rc";
import { computeAutoRc } from "../alias-escape";
import { refineStrAppend } from "../str-append";
import { refineStrings } from "../strings";
import { refineIterFusion } from "../iter-fusion";
import { refineSplitLazy } from "../split-lazy";
import { refinePlugins } from "../plugins";
import {
  createCrateTypeOracle,
  createTypeOracle,
  type OracleFile,
} from "../type-oracle";
import { validate } from "../validate";

/**
 * A `<T, U extends I>` type-parameter declaration on a class/method/fn (series
 * 081) — the oxc `TSTypeParameterDeclaration` shape we read: each param's name and
 * its (optional) `extends` constraint.
 */
export interface TSTypeParamDecl {
  params: {
    name: { name: string };
    constraint?: TSType | null;
  }[];
}


/**
 * The program-wide error type: the synthesized `AppError` enum when any custom
 * error class is declared (series 049), else `String`. Uniform across every
 * fallible function so `?` composes.
 */
export function programErrType(analysis: ModuleAnalysis): RustType {
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
                  refineStrings(refineNumerics(refineBitwise(refinePlugins(module)))),
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
export function takeDirectives(
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
 * The resolved `Map`/`Set` (or `Record`) `RustType` of a member receiver, or
 * null. Series 061 routes `Map`/`Set` methods and record query ops by the
 * receiver's binding type; only a plain identifier binding is resolved today
 * (a `this.field` map is a later slice).
 */
export function collectionOf(
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


/**
 * Wrap a `Map` key / `Set` element for its Rust key type: a scalar `number` key
 * becomes `OrderedFloat(k)` (series 061); an f64-bearing struct key becomes
 * `<Struct>Key(k)` (series 074, the SameValueZero newtype); every other key is
 * passed through.
 */
export function wrapKey(expr: HirExpr, keyTy: RustType, forLookup = false): HirExpr {
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
export function structKeyName(struct: string): string {
  return `${struct}Key`;
}

/**
 * Rewrite (in place) a `Map`/`Set` key/element `struct` type to its `structKey`
 * newtype when the struct is f64-bearing (series 074). Recurses into nested
 * collections/options so a `Map<Point, V[]>` value or an `Option<Map<Point,V>>`
 * is retargeted too. Also handles the `mapNew`/`setNew` HIR construction nodes
 * (same `key`/`value`/`elem` shape) so `new Map<Point,V>()` keys on the newtype.
 */
export function retargetStructKey(node: unknown, structKeys: Set<string>): void {
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
export function tryMapSetMethod(
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
export function tryHashMapInsert(
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

export function lowerMethod(
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

export function lowerParam(
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
