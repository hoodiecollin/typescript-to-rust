/**
 * Minimal symbol-table + ownership/mutability analysis (the "ownership spike").
 *
 * Results are attached in **side tables** keyed by scope/binding name, not baked
 * into a full HIR — that lands next, once the end-to-end POC is proven. This is
 * intentionally intra-procedural and name-based (no nested-scope shadowing); the
 * scope is documented and enforced by the dialect, not silently widened.
 *
 * Two inferences:
 *
 *  1. **Parameter ownership** (Option A). For a non-`Copy` parameter, decide how
 *     the callee borrows it *from its own body*:
 *       - a mutating use (`.push()`, `x[i] = …`, `x = …`)  → `&mut T`  (refMut)
 *       - any other read (`.length`, indexing, passing it) → `&T`      (ref)
 *       - no use at all                                     → `T`       (move)
 *     `Copy` types (`f64`, `bool`) are always taken by value.
 *
 *  2. **Local mutability.** A binding needs `mut` iff it is reassigned, has a
 *     mutating method called on it, has an element assigned, or is passed to a
 *     callee at a `&mut` position. (This replaces the crude `let`→`mut` rule.)
 *
 * Call-site adaptation (emitting `&x` / `&mut x` / `x`) is the emitter's job; it
 * reads the callee `FnInfo` produced here.
 */

import type { FunctionDeclaration, Program, Statement, TSType } from "./ast";
import type { HirFn, HirStruct, HirUnionEnum, RustType } from "./hir";
import {
  FALLIBLE_SYNC_IO,
  type StdShimName,
  collectStdShimBindings,
} from "./std-shim";
import type { TypeOracle } from "./type-oracle";

/** JS array/collection methods that mutate the receiver in place. */
const MUTATING_METHODS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
  "set",
  "insert",
  "clear",
  // `Map`/`Set` class mutators (series 061): `m.set`/`s.add`/`.delete` all need a
  // `mut` receiver (they lower to `.insert`/`.shift_remove`).
  "add",
  "delete",
]);

export type Ownership = "move" | "ref" | "refMut";

export interface ParamInfo {
  name: string;
  ownership: Ownership;
  /** `Copy` types are passed by value regardless of ownership. */
  isCopy: boolean;
  /**
   * An optional param — `(x?: T)` or `(x: T | undefined)` (series 042). Its Rust
   * type is `Option<T>`, so a call site `Some`-wraps a present argument and fills
   * an omitted trailing one with `None`.
   */
  optional: boolean;
  /**
   * The param's raw type annotation (series 059) — lets a call site lower an
   * object-literal argument into a `struct` literal against the declared param
   * type (the 032 residual). `null` if unannotated.
   */
  annotation: TSType | null;
}

export interface FnInfo {
  params: ParamInfo[];
  /**
   * The function's raw return-type annotation (`func.returnType?.typeAnnotation`),
   * or `null` if unannotated. Series 051a reads this to unwrap an async fn's
   * `Promise<T>` and compare `Promise.race` arm output types for homogeneity.
   */
  retAnn: TSType | null;
}

/** One declared field of a custom error class → an `AppError` variant field (049b). */
export interface ErrorField {
  name: string;
  ty: RustType;
}

export interface ModuleAnalysis {
  /** function name → signature ownership info */
  fns: Map<string, FnInfo>;
  /** scope key → set of binding names that must be `mut` */
  mut: Map<string, Set<string>>;
  /** names of declared `interface`s/`class`es — resolved to nominal `struct` types */
  structs: Set<string>;
  /**
   * Struct name → its lowered field types (series 032). Lets a struct object
   * literal recurse into a field whose declared type is *itself* a struct
   * (nested literals) or a `Vec` of struct (struct literals inside an array).
   * Populated by `lower()` after analysis (needs `lowerType`); empty here.
   */
  structFields: Map<
    string,
    { name: string; ty: RustType; omitIfNone?: boolean }[]
  >;
  /**
   * Struct names used as a `Map` key / `Set` element (series 061) — they derive
   * `Hash, PartialEq, Eq` (gated on every field being `Hash+Eq` eligible; an
   * `f64` field is fail-loud, its own issue). Populated by `lower()` after
   * `bindingTypes` (needs the resolved map/set types); empty here.
   */
  hashEqStructs: Set<string>;
  /**
   * Struct names used as a `Map` key / `Set` element that carry a (direct) `f64`
   * field (series 074) — they get a synthesized SameValueZero key newtype
   * `<name>Key(<name>)` rather than a derived `Hash/Eq`. The user struct keeps its
   * raw `f64` fields and `===`-faithful derived `PartialEq`; the newtype is the
   * collection's actual key type. Disjoint from `hashEqStructs`. Populated by
   * `lower()` alongside `hashEqStructs`; empty here.
   */
  structKeyStructs: Set<string>;
  /**
   * Names of bindings whose initializer is `Object.entries(...)` — a
   * `Vec<(K, V)>` of pairs (series 043). A pair index `es[i][0]`/`es[i][1]` on
   * such a binding lowers to tuple field access `.0`/`.1`. Populated during
   * lowering (like `structFields`).
   */
  entriesBindings: Set<string>;
  /**
   * Names of bindings whose initializer lowered to a `{kind:"spawn"}` node — a
   * `JoinHandle<T>` (series 051c increment 1, `const h = doWork()`). A later
   * `await h` on such a binding lowers to `{kind:"joinHandleAwait"}` →
   * `h.await.unwrap()` (not the plain `.await`). Populated during lowering, in
   * statement order, so the binding is recorded before its later `await`.
   */
  joinHandleBindings: Set<string>;
  /** names of class methods that mutate `this` (→ a `&mut self` receiver) */
  mutatingMethods: Set<string>;
  /**
   * `async` class **method names** (series 054a). An `await obj.M(...)` where `M`
   * is here lowers to `recv.M(...).await`. Name-based (like `mutatingMethods` /
   * `fallibleMethods`); the cross-class same-name edge is the documented limit.
   */
  asyncMethods: Set<string>;
  /**
   * All declared class **method names**. A method call whose name is here is a
   * user method (native call), so it is *not* hijacked by the library-method
   * routing (`map`/`filter`/`at`/… → closures/`tslib`, series 027/033).
   */
  methodNames: Set<string>;
  /**
   * Class **method name** → its params' inferred ownership (series 060). Method
   * params infer `&T`/`&mut T`/owned via the same analysis free fns use, so a
   * method reading a struct param borrows it (and the call site passes `&p`).
   * Name-based (like `mutatingMethods`); the cross-class same-name edge is the
   * documented limit.
   */
  methodParams: Map<string, ParamInfo[]>;
  /**
   * **Consuming-method candidates** (series 068, issue #35): a method name →
   * the class field it moves out of `this`. A candidate has the shape `m(): T {
   * return this.field }` — a bare `return this.field` (return is terminal, so
   * there is trivially no subsequent `self` use), with a non-`&mut self` receiver.
   * Whether a candidate is *actually* emitted consuming (`fn m(self)`, dropping the
   * 038 field clone) is finalized by the alias-escape pass, which demotes any whose
   * receiver is **reused after the call** (that receiver promotes to `Rc<RefCell<T>>`
   * and the method falls back to `&self` + clone). Name-based, like `mutatingMethods`.
   */
  consumingCandidates: Map<string, string>;
  /**
   * Per-class getter/setter names (series 060), populated during lowering. A read
   * `obj.g` of a getter → `obj.g()`; a write `obj.s = v` of a setter →
   * `obj.set_s(v)`. Drives the member-site rewrite in `lowerMember`/assignment.
   */
  accessors: Map<string, { getters: Set<string>; setters: Set<string> }>;
  /**
   * A monotonically increasing counter for unique `tryBlock` labels (series 063),
   * so nested labeled-block `try`s get distinct labels (`'try_0`, `'try_1`, …).
   * Mutated during lowering.
   */
  tryCounter: number;
  /**
   * Names of top-level functions that are *fallible* — they `throw` directly or
   * (transitively) call a fallible function, so their return type wraps in
   * `Result` and calls to them propagate with `?`. Includes the `SCRIPT_SCOPE`
   * sentinel when the generated `main` is fallible.
   */
  fallible: Set<string>;
  /**
   * Fallible class **method names** (series 023): a method that throws, or
   * transitively calls a fallible free fn / method / fallible-ctor `new`. A call
   * `obj.M(…)` / `this.M(…)` to such a name propagates with `?`. Name-based (like
   * `mutatingMethods`); the cross-class same-name edge is a documented limit.
   */
  fallibleMethods: Set<string>;
  /** Class **names** whose constructor is fallible (`new C(…)` propagates `?`). */
  fallibleCtors: Set<string>;
  /**
   * Declared **custom error classes** (`class X extends Error { … }`), keyed by
   * name and carrying each class's ordered typed fields (`message` is implicit —
   * these are the *extra* declared data fields, series 049b). They become
   * `AppError` enum variants (not general data structs, so they are *excluded*
   * from `structs`); a non-empty map upgrades the program error type from
   * `String` to `AppError`. The field shapes need `lowerType`, so analysis seeds
   * each entry with empty fields and `lower()` fills them (like `structFields`).
   */
  errorClasses: Map<string, { name: string; fields: ErrorField[] }>;
  /**
   * Names of top-level `async` function declarations. A call to one is only valid
   * `await`ed (an un-polled future never runs), and `await` only targets one of
   * these — both enforced in lowering. The generated `main` becomes
   * `#[tokio::main] async fn main()` when the script `await`s.
   */
  asyncFns: Set<string>;
  /**
   * Names of declared `enum`s (series 025). Like `structs`, they resolve to a
   * nominal type; distinct from `structs` so a member access `E.Variant` lowers
   * to a Rust path `E::Variant` (a variant), not a struct field read.
   */
  enums: Set<string>;
  /**
   * Union-type enums (series 093) — name → the synthesized {@link HirUnionEnum}.
   * Populated by the `collectUnions` pre-pass over `type X = A | B` aliases and
   * inline/anonymous unions; the names are also merged into `structs` so a
   * reference resolves nominally. Drives construction coercion (a literal → its
   * variant), `switch`/`===` variant matching, and the emitted enum items.
   */
  unionEnums: Map<string, HirUnionEnum>;
  /**
   * Scope keys (free-fn names + `SCRIPT_SCOPE`) that carry a leading `"use panic"`
   * directive (series 028a). In such a scope a `throw` becomes `panic!` and the
   * scope is treated as **infallible** — it never enters `fallible`, so its
   * signature stays non-`Result` and callers do not `?`-propagate.
   */
  panicScopes: Set<string>;
  /**
   * Names of declared (non-error) `class`es — the subset of `structs` that has an
   * `impl` (a constructor / methods), i.e. objects with identity. In a `"use rc"`
   * scope (series 028b) a binding of a class type is wrapped in `Rc<RefCell<…>>`;
   * `refineRc` uses this to distinguish class instances from plain interface data.
   */
  classes: Set<string>;
  /**
   * Names that route a member access `X.y` to a Rust **path** `X::y` (series 050d,
   * Axis 4) — a `namespace Foo` (its members live in `mod Foo`) and a namespace
   * import alias (`import * as ns` → `use crate::n as ns;`, so `ns.f()` → `ns::f()`).
   * The same routing enums/classes use (`E.Variant`/`Type.CONST`), so a member off
   * one of these names lowers to a path segment, not a field read. Filled by
   * `lower()` (namespaces) / `lowerCrate` (import aliases), empty from `analyzeModule`.
   */
  namespaces: Set<string>;
  /**
   * Top-level free-function names (series 071 increment 2). A reference to one
   * inside a synthesized interface-literal method is a path (valid in a
   * non-capturing closure), not an environment capture.
   */
  topLevelFns: Set<string>;
  /**
   * Scope keys (free-fn names + `SCRIPT_SCOPE`) carrying a leading `"use rc"`
   * directive (series 028b). In such a scope, class-typed bindings translate under
   * `Rc<RefCell<T>>` (shared, interior-mutable) instead of plain moves, so
   * shared-mutable aliasing the borrow model can't express compiles.
   */
  rcScopes: Set<string>;
  /**
   * Scope keys (free-fn names + `SCRIPT_SCOPE`) carrying a leading `"use arena"`
   * directive (series 028c). In such a scope, `Vec` literals are built from a
   * bump arena (`bumpalo`), freed at scope exit. An arena value that escapes the
   * scope is a lifetime error the oracle (cargo) rejects — cargo is the escape
   * check, so this stays fail-loud without a bespoke analysis.
   */
  arenaScopes: Set<string>;
  /**
   * Names of top-level sync generator functions (`function* g()`, series 025d).
   * A generator lowers to a `fn -> impl Iterator`; a `for (const x of g())` over
   * such a call consumes the iterator directly (no `.iter()`, bound by value).
   */
  generators: Set<string>;
  /**
   * Generator names that are consumed by a **manual `step()`** surface (series 075):
   * a manual `it.next()` / `g().next()` read, a fixed-arity destructure
   * `const [a, b] = g()`, or a `yield*` whose completion value is read. Such a
   * generator must lower to the state-machine struct (which carries `step()` /
   * `Steppable`), never the straight-line `vec![…].into_iter()` fast path. Populated
   * by a whole-program pre-scan in `lower()`.
   */
  steppedGenerators: Set<string>;
  /**
   * Local binding name → the generator fn it was bound to (series 075) — from
   * `const it = g()`. Lets a later `it.next()` / `it.step()` resolve the generator
   * instance (065 gated manual consumers to a *direct* `g().next()` call). Name-based,
   * last-write-wins (matching the rest of this intra-procedural analysis).
   */
  generatorInstances: Map<string, string>;
  /**
   * Generator name → its declared completion type `R` (series 075), from the 2nd
   * `Generator<Y, R>` type arg. Used to type a read `yield*` delegate's `Steppable<Y,
   * R>` box and the bound completion value. Absent → the delegate's `R` is unit.
   */
  generatorRetTypes: Map<string, RustType>;
  /**
   * Generator name → its yield type `Y` (series 075), from the 1st `Generator<Y, R>`
   * type arg. Used with `generatorRetTypes` to check `Y === R` for a `{ value, done }`
   * read (so the `value` binding is a single Rust type).
   */
  generatorItemTypes: Map<string, RustType>;
  /**
   * Generator name → its resume-in type `TNext` (series 076), from the 3rd
   * `Generator<Y, R, TNext>` type arg. Types `resume(&mut self, sent: TNext)`.
   * Absent for a generator that declares no 3rd arg — a read yield result over such
   * a generator is fail-loud (can't type `sent`).
   */
  generatorNextTypes: Map<string, RustType>;
  /**
   * Generator names whose yield **result is read** (`const x = yield e`), making
   * them **bidirectional** (series 076): the struct gains an inherent
   * `resume(&mut self, sent: TNext) -> GenStep<Y, R>` (the value-**in** path), and
   * the pull-only `step()` / `impl Iterator` surfaces route through
   * `resume(<default>)` when `TNext` is defaultable. Populated by a pre-scan in
   * `lower()`.
   */
  bidirectionalGenerators: Set<string>;
  /**
   * Binding name → its resolved `RustType` (series 048). Populated by `lower()`
   * (it needs `lowerType`) over every `const`/`let`/`var` and function param.
   * Used by the callback-lifting pass to type a forwarded free variable and to
   * resolve a receiver's element type. Name-based, last-write-wins (a documented
   * limit, matching the rest of this intra-procedural analysis).
   */
  bindingTypes: Map<string, RustType>;
  /**
   * Names currently narrowed from `Option<T>` to their inner `T` (series 066).
   * Inside an `if let Some(x) = x { … }` block, `x` is a plain `T`, so the
   * arithmetic-on-optional fail-loud guard (and the print/truthiness Option paths)
   * must not treat `x` as optional there. `lowerIf` adds the binding before
   * lowering the some-body and removes it after (a stack discipline via the
   * `Set`). Name-based, matching the rest of this intra-procedural analysis.
   */
  narrowedOptions: Set<string>;
  /**
   * A TypeScript-checker-backed type resolver coupled to oxc (series 082,
   * spike #44), or null when `lower()` was called without source text. Consulted
   * by `collectionOf` as a fallback: when the hand-rolled `bindingTypes` lookup
   * can't resolve a Map/Set receiver (any non-identifier shape — `this.field`,
   * `local.field`, `getX()`), the oracle answers via `getTypeAtLocation`. Only
   * ever turns a previously-null result into a resolution — never overrides a
   * positive `bindingTypes` answer — so identifier receivers are unchanged.
   */
  typeOracle: TypeOracle | null;
  /**
   * Struct name → the set of its `readonly` field names (series 059). An
   * assignment to such a field (`s.f = …`) is a `DialectError`; construction (a
   * struct literal) is allowed. Populated by `lower()`. Empty here.
   */
  readonlyFields: Map<string, Set<string>>;
  /**
   * Interface inheritance (series 059). `baseInterfaces` = interface names that are
   * `extends`ed (so they get a getter trait `I<name>`). `interfaceExtends` maps a
   * derived interface to its immediate base. `dynInterfaceBindings` maps a param
   * bound to a base-interface type (`&impl IA`) → the base name, so a field read
   * through it routes to the getter. Populated by `lower()`.
   */
  baseInterfaces: Set<string>;
  interfaceExtends: Map<string, string>;
  dynInterfaceBindings: Map<string, string>;
  /**
   * Behavioral interfaces (series 071): interface names declaring ≥1 method
   * signature → a synthesized `trait I<name>` (methods + 059 getters for any data
   * fields). `interfaceMethods` holds each such interface's method signatures
   * (bodyless `HirFn`s) for the trait item and the per-class `impl` forwarders.
   * A behavioral interface emits **no** `struct` (its values are backed by a
   * concrete class). Populated by `lower()`.
   */
  behavioralInterfaces: Set<string>;
  interfaceMethods: Map<string, HirFn[]>;
  /**
   * The top-level `fn`s synthesized by callback lifting (series 048), collected
   * during lowering and appended to the module's `items` before the refine passes.
   * Each is a `__cb_<method>_<n>` pure function whose params are the callback's own
   * parameters followed by its read-only free variables.
   */
  liftedFns: HirFn[];
  /**
   * A per-module counter for the `__cb_<method>_<n>` naming (series 048),
   * incremented once per lifted callback so two callbacks get distinct names.
   */
  liftCounter: number;
  /**
   * Object-literal interface synthesis (series 071 increment 2): the per-literal
   * `struct <Interface>__litN` items synthesized when an object literal is typed
   * as a behavioral interface. Collected during lowering and appended to the
   * module's `items` (like `liftedFns`) before the refine passes.
   */
  litStructs: HirStruct[];
  /**
   * A per-module counter for the `<Interface>__litN` naming (series 071), so two
   * object literals of the same interface type get distinct struct names.
   */
  litCounter: number;
  /**
   * Anonymous structs synthesized for object-rest destructuring (series 097):
   * `const { x, ...rest } = obj` synthesizes an `__anonymous_struct_<hash>`
   * holding the remaining fields. Keyed by the FNV-1a canonical name so two
   * structurally-identical rests dedupe to one definition (mirrors the 093
   * anon-union registry). Drained into the module `items` before the refine pass.
   */
  restStructs: Map<string, HirStruct>;
  /**
   * Class inheritance (series 053). Subclass name → its direct base class name
   * (from `decl.superClass`). Drives the synthetic `base: A` embed and the
   * multi-level `.base` hops for an inherited-field read.
   */
  superclass: Map<string, string>;
  /**
   * Per class, the field names owned by its ancestors (transitive). A `field`
   * read `b.x` is classified own-vs-inherited against this set to decide whether
   * to inject the `.base` hop(s).
   */
  inheritedFields: Map<string, Set<string>>;
  /**
   * Per subclass, the method names it redefines (vs. inheriting the trait
   * default). Drives which methods appear in `impl IA for B` as overrides and
   * which fall through to the default via a forwarder.
   */
  overrides: Map<string, Set<string>>;
  /**
   * Classes that are extended by some subclass — each needs a synthesized
   * `trait IA` (series 053b). A leaf/never-extended class needs no trait.
   */
  baseClasses: Set<string>;
  /**
   * Shared/base field names read through a `dyn IA` position (series 053c),
   * keyed by the base (trait-owning) class name. Gates on-demand accessor
   * synthesis — a pure reuse+override program collects none.
   */
  dynFieldReads: Map<string, Set<string>>;
  /**
   * Per class, the field names it declares itself (series 053) — property
   * definitions + `constructor(public x: T)` parameter properties. Used with
   * `superclass` to count `.base` hops to the ancestor that owns a field.
   */
  ownClassFields: Map<string, Set<string>>;
  /**
   * The class currently being lowered (series 053a) — set transiently by
   * `lowerMethod`/`lowerConstructor` so a `this.<field>` read can be classified
   * own-vs-inherited (injecting the `.base` hop for an inherited field). Absent
   * outside a class body.
   */
  currentClass?: string;
  /**
   * Type-parameter names in scope of the class/method currently being lowered
   * (series 081). Set transiently by `lowerClass` (the class's `<T, …>`) and
   * extended by a generic method (its own `<U>`) for that signature/body only, so
   * `lowerType` resolves a bare `T` here to a `{kind:"param"}` `RustType` instead
   * of failing loud. Empty (never `undefined` after init) outside a generic scope.
   */
  typeParams: Set<string>;
  /**
   * The **class-level** generic params of the class currently being lowered
   * (series 088) — the subset of `typeParams` an operator-on-`T` may bind an
   * operator trait onto. A method's own `<U>` is *not* here (its clause is a bare
   * `<U: Clone>` with no operator-bound slot), so a same-`U` operator stays
   * fail-loud. Empty outside a generic class scope.
   */
  classTypeParams: Set<string>;
  /**
   * JS-operator trait bounds accumulated during a generic class body's lowering
   * (series 088), keyed by class-level param name → the set of fully-qualified
   * tslib trait paths (`tslib::ops::JsAdd`) its operators demand. Merged onto the
   * class's `GenericParam[]` in `lowerClassBody` after the method loop. Reset per
   * class.
   */
  opBounds: Map<string, Set<string>>;
  /**
   * Bindings whose value is a `&dyn IA` / `Box<dyn IA>` element (series 053c),
   * keyed by the binding/param name → the base (trait-owning) class name. A
   * field read on such a binding routes through a trait accessor (`a.x()`), and
   * a method call dispatches virtually. Populated during lowering.
   */
  dynBindings: Map<string, string>;
  /**
   * `@t2r/std` std-shim (series 084): local-alias → intrinsic-name map, from
   * `import { parseJson as pj, stringifyJson } from "@t2r/std"`. A call whose
   * identifier callee is a key here routes to the intrinsic lowering (never the
   * generic user-fn path). Recognition is by the reserved specifier, not a name.
   */
  stdShim: Map<string, StdShimName>;
  /**
   * Bindings whose value is a `parseJson<T>` result (series 084) → their inner
   * `T` (the deserialized `RustType`). A member access `.ok`/`.value`/`.error`
   * on such a binding lowers to the `ParseResult<T>` surface. Populated during
   * lowering as `const r = parseJson<T>(…)` bindings are seen.
   */
  parseResultBindings: Map<string, RustType>;
  /**
   * Bindings whose value is an `rng(seed)` handle (series 089) — a
   * `tslib::rng::Rng`. A member/method access `.next()`/`.int()`/`.pick()`/
   * `.shuffle()` on such a binding routes to the handle surface, and is checked
   * **before** the generator `.next()` protocol so the rng handle wins. Populated
   * during lowering as `const r = rng(seed)` bindings are seen; the binding is
   * emitted `let mut` (the methods take `&mut self`).
   */
  rngBindings: Set<string>;
  /**
   * Bindings whose value is a `JsonValue` (series 090) — the opt-in dynamic JSON
   * type. A member/method access like `.get(k)`, `.asNumber()`, or the `.length`
   * property on such a binding routes to the JsonValue accessor surface. Populated
   * during lowering as JsonValue-typed bindings are seen (`const v = r.value`,
   * `const e = v.at(i)`, `const w = toJsonValue<T>(x)`). Emitted as an ordinary
   * `let` — the accessors take `&self`.
   */
  jsonValueBindings: Set<string>;
  /**
   * Bindings whose value is a `stdout()`/`stderr()` `Writer` handle (series 100)
   * — a `tslib::io::Writer`. A `.write(s)`/`.writeLine(s)`/`.flush()` on such a
   * binding routes to the handle surface (fallible `?`); an unknown method is
   * fail-loud. Populated during lowering; emitted `let mut` (methods take
   * `&mut self`). Reuses the 089 rng-handle machinery.
   */
  writerBindings: Set<string>;
  /**
   * Bindings whose value is an `http.get`/`http.post` result (series 100) — a
   * `tslib::http::HttpResponse`. A member access `.status`/`.ok` reads the public
   * field; `.body` is the `self`-consuming `body()` accessor. Mirrors the 084
   * `parseResultBindings` surface. Populated during lowering (`const res = await
   * http.get(u)`).
   */
  httpResponseBindings: Set<string>;
  /**
   * `@t2r/std` async-I/O namespace bindings (series 100): local alias →
   * `"fsAsync"`/`"http"`, from `import { fsAsync, http } from "@t2r/std"`. A
   * member call `ns.m(...)` on such a local routes to the async I/O target
   * (`.await?`); a non-awaited one is fail-loud (the 051 un-polled-future rule).
   */
  ioAsyncNamespaces: Map<string, "fsAsync" | "http">;
  /**
   * Bindings whose value is a compiled regex (series 101) — a `tslib::regex::Regex`
   * from `const re = /pat/flags` or `new RegExp("lit", "flags")`. The mapped
   * `{ global }` records the JS `g` flag so a later `s.match(re)` picks the
   * `captures` (no `g`) vs `find_all` (`g`) shape, and `matchAll`/`replaceAll`
   * gate on it. A `re.test`/`re.exec` on such a binding routes to the regex
   * method surface. Populated during lowering (statements lower top-to-bottom).
   */
  regexBindings: Map<string, { global: boolean }>;
  /**
   * Bindings whose value is a first-match regex result (series 101) — an
   * `Option<tslib::regex::Match>` from `s.match(re)` (no `g`) or `re.exec(s)`. A
   * positional index `m![i]` routes to `Match::get`, and `m!.groups!.name` to
   * `Match::group`; both yield `Option<String>` (the 066 Option model, `None` →
   * JS `undefined`). Populated during lowering.
   */
  matchBindings: Set<string>;
  /**
   * Bindings whose value is a `Date` (series 102) — a `tslib::date::Date` from
   * `new Date(ms | isoString | fields)` or a `clock(...).date()` bridge. A method
   * call `.getTime()`/`.getUTCHours()`/`.toISOString()`/… routes to the `Date`
   * accessor surface (all `&self`, so emitted as a plain `let`); a setter, a
   * locale formatter, or an unknown method is fail-loud. Populated during
   * lowering (statements lower top-to-bottom).
   */
  dateBindings: Set<string>;
  /**
   * Bindings whose value is a `clock(epochMs)` handle (series 102) — a
   * `tslib::date::Clock`, the seeded differential-stable replacement for ambient
   * `Date.now()`/`new Date()`. A `.now()`/`.date()`/`.tick(ms)` routes to the
   * handle surface; the binding is emitted `let mut` (`tick` takes `&mut self`).
   * Direct structural twin of `rngBindings`. Populated during lowering.
   */
  clockBindings: Set<string>;
}

/** Scope key for the generated `fn main()` wrapping top-level script statements. */
export const SCRIPT_SCOPE = "<script>";

/**
 * The leading string-literal *directives* of a statement list (the `"use strict"`
 * position): each leading `ExpressionStatement` whose expression is a string
 * `Literal`. The scan stops at the first non-directive statement (series 028).
 */
export function leadingDirectives(stmts: Statement[] | undefined): string[] {
  const out: string[] = [];
  for (const s of stmts ?? []) {
    if (s.type !== "ExpressionStatement") break;
    const e = (s as { expression?: { type?: string; value?: unknown } })
      .expression;
    if (e?.type !== "Literal" || typeof e.value !== "string") break;
    out.push(e.value);
  }
  return out;
}

// ── Generic AST walk ─────────────────────────────────────────────────────────

interface AnyNode {
  type: string;
  [key: string]: unknown;
}

function isNode(x: unknown): x is AnyNode {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as AnyNode).type === "string"
  );
}

function walk(node: unknown, visit: (n: AnyNode) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isNode(node)) return;
  visit(node);
  for (const key in node) {
    if (key === "type") continue;
    walk(node[key], visit);
  }
}

/** Name of an identifier node, else null. */
function identName(node: unknown): string | null {
  return isNode(node) && node.type === "Identifier"
    ? (node.name as string)
    : null;
}

/** Is a member expression a mutating method call on `target`? e.g. `target.push(…)`. */
function isMutatingMethodCall(
  call: AnyNode,
  target?: string,
): { object: string } | null {
  if (call.type !== "CallExpression") return null;
  const callee = call.callee;
  if (!isNode(callee) || callee.type !== "MemberExpression") return null;
  const obj = identName(callee.object);
  const prop = identName(callee.property);
  if (!obj || !prop || !MUTATING_METHODS.has(prop)) return null;
  if (target !== undefined && obj !== target) return null;
  return { object: obj };
}

/** Is a node an assignment whose lvalue touches `target`? Returns kind of touch. */
function assignmentTarget(node: AnyNode): string | null {
  // `++`/`--` (series 096) mutates its argument exactly as `arg += 1` would, so it
  // marks the same binding `mut`: an identifier, or the root of an element write.
  if (node.type === "UpdateExpression") {
    const arg = node.argument;
    if (!isNode(arg)) return null;
    if (arg.type === "Identifier") return arg.name as string;
    if (arg.type === "MemberExpression" && arg.computed)
      return identName(arg.object);
    return null;
  }
  if (node.type !== "AssignmentExpression") return null;
  const left = node.left;
  if (!isNode(left)) return null;
  if (left.type === "Identifier") return left.name as string;
  // element assignment: `x[i] = …`
  if (left.type === "MemberExpression" && left.computed)
    return identName(left.object);
  return null;
}

// ── Type classification ──────────────────────────────────────────────────────

/**
 * Is a parameter optional (`Option<T>` in Rust, series 042)? Either the `x?: T`
 * flag, or an annotation `T | undefined` / `T | null` (a union with a nullish
 * member).
 */
function isOptionalParam(p: {
  optional?: boolean;
  typeAnnotation?: unknown;
}): boolean {
  if (p.optional === true) return true;
  const ann = isNode(p.typeAnnotation) ? p.typeAnnotation.typeAnnotation : undefined;
  if (isNode(ann) && ann.type === "TSUnionType") {
    const types = (ann as { types?: { type: string }[] }).types ?? [];
    return types.some(
      (t) => t.type === "TSUndefinedKeyword" || t.type === "TSNullKeyword",
    );
  }
  return false;
}

function isCopyType(annotation: unknown, enums: ReadonlySet<string>): boolean {
  const inner = isNode(annotation) ? annotation.typeAnnotation : undefined;
  const t = isNode(inner) ? inner.type : undefined;
  if (t === "TSNumberKeyword" || t === "TSBooleanKeyword") return true;
  // A function-type annotation lowers to a `fn`-pointer, which is `Copy` — so a
  // fn-value param is passed by value, not borrowed (series 048).
  if (t === "TSFunctionType") return true;
  // A C-like `enum` derives `Copy`, so it too passes by value (series 025).
  if (t === "TSTypeReference" && isNode(inner)) {
    const name = (inner.typeName as { name?: string } | undefined)?.name;
    return typeof name === "string" && enums.has(name);
  }
  // A literal-union annotation `"a" | "b"` / `0 | 1` lowers to a fieldless `Copy`
  // union `enum` (series 093), so an inline-union param passes by value.
  if (t === "TSUnionType" && isNode(inner)) {
    const members = (inner as { types?: { type: string }[] }).types ?? [];
    const real = members.filter(
      (m) => m.type !== "TSUndefinedKeyword" && m.type !== "TSNullKeyword",
    );
    return real.length > 0 && real.every((m) => m.type === "TSLiteralType");
  }
  return false;
}

// ── Parameter ownership ──────────────────────────────────────────────────────

function classifyParam(
  name: string,
  body: unknown,
  isCopy: boolean,
): Ownership {
  if (isCopy) return "move";
  let mutated = false;
  let read = false;
  walk(body, (n) => {
    if (assignmentTarget(n) === name) mutated = true;
    if (isMutatingMethodCall(n, name)) mutated = true;
    if (n.type === "Identifier" && n.name === name) read = true;
  });
  // Priority: a mutating use dominates a read; no use at all → move.
  return mutated ? "refMut" : read ? "ref" : "move";
}

function analyzeFunction(
  fn: FunctionDeclaration,
  enums: ReadonlySet<string>,
  extendedBases: ReadonlySet<string> = new Set(),
): FnInfo {
  const params = fn.params.map((rawP) => {
    // A default param `(x: T = d)` is an `AssignmentPattern` wrapping the real
    // binding on `.left` (series 066). See through it for ownership/type analysis;
    // it is `Option<T>` at the call boundary (a present arg `Some`-wrapped, an
    // omitted one `None`), resolved by an `unwrap_or(d)` body prelude — so it is
    // `optional` here for the call-site Some/None machinery.
    const isDefault =
      (rawP as { type?: string }).type === "AssignmentPattern";
    const p = isDefault
      ? ((rawP as unknown as { left: typeof rawP }).left)
      : rawP;
    const isCopy = isCopyType(p.typeAnnotation, enums);
    // A base-typed param becomes `impl IA` (by value, series 053b/INH10), so it
    // must be passed owned — force `move` regardless of read-only use.
    const annotation = p.typeAnnotation?.typeAnnotation ?? null;
    if (isBaseTypedParam(p, extendedBases)) {
      return {
        name: p.name,
        ownership: "move" as const,
        isCopy: false,
        optional: isDefault || isOptionalParam(p),
        annotation,
      };
    }
    return {
      name: p.name,
      ownership: classifyParam(p.name, fn.body, isCopy),
      isCopy,
      optional: isDefault || isOptionalParam(p),
      annotation,
    };
  });
  return { params, retAnn: fn.returnType?.typeAnnotation ?? null };
}

/** Is a param annotated with an extended base class type (→ `impl IA`, 053b)? */
function isBaseTypedParam(
  p: { typeAnnotation?: unknown },
  extendedBases: ReadonlySet<string>,
): boolean {
  const ann = (p.typeAnnotation as { typeAnnotation?: AnyNode } | undefined)
    ?.typeAnnotation;
  if (!ann || !isNode(ann) || ann.type !== "TSTypeReference") return false;
  const ref = (ann as AnyNode).typeName;
  return (
    isNode(ref) &&
    ref.type === "Identifier" &&
    extendedBases.has(ref.name as string)
  );
}

// ── Local mutability ─────────────────────────────────────────────────────────

/**
 * Does `node` contain an assignment whose target is `name` or a member access
 * rooted at `name` (`p.x = …`, `p.a.b = …`)? Used to mark a for-of iterable `mut`
 * when its element is mutated in place (series 064).
 */
function mutatesRoot(node: unknown, name: string): boolean {
  let found = false;
  const rootedAt = (n: unknown): boolean => {
    if (!isNode(n)) return false;
    if (n.type === "Identifier") return identName(n) === name;
    if (n.type === "MemberExpression") return rootedAt((n as AnyNode).object);
    return false;
  };
  walk(node, (n) => {
    if (n.type === "AssignmentExpression" && rootedAt((n as AnyNode).left)) {
      found = true;
    }
    // `x++`/`--x` (series 096) mutates its argument's root, like an assignment.
    if (n.type === "UpdateExpression" && rootedAt((n as AnyNode).argument)) {
      found = true;
    }
  });
  return found;
}

function mutableBindings(
  body: unknown,
  fns: Map<string, FnInfo>,
  mutatingMethods: Set<string>,
  methodParams: Map<string, ParamInfo[]> = new Map(),
): Set<string> {
  const mut = new Set<string>();
  // Bindings aliased by a bare-identifier initializer (`const b = a`) — for these,
  // field-mutation-induced `mut` is withheld (series 059): a mutated *and* aliased
  // value is the shared-mutable-aliasing case the ownership clone pass turns into a
  // silent divergence, so it must stay fail-loud (cargo-caught) until series 062.
  const aliased = new Set<string>();
  walk(body, (n) => {
    if (n.type === "VariableDeclarator" && isNode(n.init) && n.init.type === "Identifier") {
      const src = identName(n.init);
      if (src) aliased.add(src);
    }
  });
  walk(body, (n) => {
    const assigned = assignmentTarget(n);
    if (assigned) mut.add(assigned);

    // A local struct field mutation `s.x = …` needs `mut s` (series 059). This is
    // *local* only — it does not flow into param ownership (`&mut Point` through a
    // borrowed param rides #23), so it lives here, not in `assignmentTarget`.
    if (n.type === "AssignmentExpression" && isNode(n.left)) {
      const left = n.left as AnyNode;
      if (
        left.type === "MemberExpression" &&
        !left.computed &&
        isNode(left.object) &&
        (left.object as AnyNode).type === "Identifier"
      ) {
        const name = identName(left.object);
        if (name && name !== "self" && !aliased.has(name)) mut.add(name);
      }
    }

    // A local struct field increment `s.x++` (series 096) needs `mut s`, mirroring
    // the `s.x = …` case above.
    if (n.type === "UpdateExpression" && isNode(n.argument)) {
      const arg = n.argument as AnyNode;
      if (
        arg.type === "MemberExpression" &&
        !arg.computed &&
        isNode(arg.object) &&
        (arg.object as AnyNode).type === "Identifier"
      ) {
        const name = identName(arg.object);
        if (name && name !== "self" && !aliased.has(name)) mut.add(name);
      }
    }

    // A `for (const p of xs) { p.f = … }` mutates `xs`'s elements in place, so
    // `xs` iterates `&mut xs` and must be a `mut` local (series 064). Withheld
    // when `xs` is aliased, mirroring the local-field-mutation guard above.
    if (n.type === "ForOfStatement") {
      const iterName = identName(n.right);
      const left = n.left as AnyNode | undefined;
      const decls = left?.declarations;
      const decl = Array.isArray(decls)
        ? (decls[0] as AnyNode | undefined)
        : undefined;
      const loopVar =
        decl && isNode(decl.id) && (decl.id as AnyNode).type === "Identifier"
          ? identName(decl.id)
          : null;
      if (
        iterName &&
        loopVar &&
        !aliased.has(iterName) &&
        mutatesRoot(n.body, loopVar)
      ) {
        mut.add(iterName);
      }
    }

    const mutating = isMutatingMethodCall(n);
    if (mutating) mut.add(mutating.object);

    // A collection-mutating method on a `localVar.field` receiver
    // (`c.entries.set(…)`, `c.tags.add(…)`, series 078 / issue #45) mutates the
    // field-held collection through the owning local, so — exactly like a mutating
    // call on a bare local (above) or a local field write (`s.x = …` below) — the
    // owner must be a `mut` binding. Withheld when the owner is **aliased**: a
    // mutated-and-aliased field-held collection is the shared-mutable case the
    // alias-escape pass promotes to `Rc<RefCell<T>>` (interior mutability, never
    // `mut`), so declaring it `mut` here would fight that promotion. This is the
    // `localVar.field` clean-owner piece the 072 clean path did not wire.
    if (
      n.type === "CallExpression" &&
      isNode(n.callee) &&
      n.callee.type === "MemberExpression" &&
      isNode((n.callee as AnyNode).object) &&
      ((n.callee as AnyNode).object as AnyNode).type === "MemberExpression"
    ) {
      const field = (n.callee as AnyNode).object as AnyNode;
      const prop = identName((n.callee as AnyNode).property);
      const root =
        isNode(field.object) && field.object.type === "Identifier"
          ? identName(field.object)
          : null;
      if (root && root !== "self" && prop && MUTATING_METHODS.has(prop)) {
        if (!aliased.has(root)) mut.add(root);
      }
    }

    // `delete obj[k]` (series 061) → `obj.shift_remove(&k)`, which needs `mut obj`.
    if (
      n.type === "UnaryExpression" &&
      (n as AnyNode).operator === "delete" &&
      isNode((n as AnyNode).argument)
    ) {
      const arg = (n as AnyNode).argument as AnyNode;
      if (arg.type === "MemberExpression" && arg.computed) {
        const name = identName(arg.object);
        if (name && !aliased.has(name)) mut.add(name);
      }
    }

    // A call to a self-mutating class method (`c.increment()`) needs `mut c`.
    if (
      n.type === "CallExpression" &&
      isNode(n.callee) &&
      n.callee.type === "MemberExpression"
    ) {
      const recv = identName((n.callee as AnyNode).object);
      const method = identName((n.callee as AnyNode).property);
      if (recv && method && mutatingMethods.has(method)) mut.add(recv);
    }

    // Args passed at a `&mut` position must be `mut` locals.
    if (
      n.type === "CallExpression" &&
      isNode(n.callee) &&
      n.callee.type === "Identifier"
    ) {
      const sig = fns.get(n.callee.name as string);
      const args = n.arguments;
      if (sig && Array.isArray(args)) {
        args.forEach((arg, i) => {
          const name = identName(arg);
          if (name && sig.params[i]?.ownership === "refMut") mut.add(name);
        });
      }
    }

    // A method arg at a `&mut` position must be a `mut` local too (series 060) —
    // name-based via `methodParams` (the documented cross-class same-name limit).
    if (
      n.type === "CallExpression" &&
      isNode(n.callee) &&
      n.callee.type === "MemberExpression" &&
      isNode((n.callee as AnyNode).property)
    ) {
      const method = identName((n.callee as AnyNode).property);
      const info = method ? methodParams.get(method) : undefined;
      const args = n.arguments;
      if (info && Array.isArray(args)) {
        args.forEach((arg, i) => {
          const name = identName(arg);
          if (name && info[i]?.ownership === "refMut") mut.add(name);
        });
      }
    }
  });
  return mut;
}

/** Does a body assign to a `this.<field>` (marking a method self-mutating)? */
function mutatesThis(body: unknown): boolean {
  let mutates = false;
  walk(body, (n) => {
    // A direct field write `this.x = …`, or an indexed field-element write
    // `this.items[i] = …` (the computed lvalue's root is still `this`) — both need
    // `&mut self`.
    if (n.type === "AssignmentExpression") {
      const left = n.left;
      if (isNode(left) && left.type === "MemberExpression") {
        const obj = (left as AnyNode).object;
        // `this.x = …`.
        if (isNode(obj) && obj.type === "ThisExpression") mutates = true;
        // `this.field[i] = …` — the lvalue is a computed member over `this.field`.
        else if (
          (left as AnyNode).computed &&
          isNode(obj) &&
          obj.type === "MemberExpression" &&
          isNode((obj as AnyNode).object) &&
          ((obj as AnyNode).object as AnyNode).type === "ThisExpression"
        ) {
          mutates = true;
        }
      }
      return;
    }
    // A field increment `this.n++` / `this.items[i]++` (series 096) mutates self,
    // exactly like the `this.n = …` writes above.
    if (n.type === "UpdateExpression") {
      const arg = n.argument;
      if (isNode(arg) && arg.type === "MemberExpression") {
        const obj = (arg as AnyNode).object;
        if (isNode(obj) && obj.type === "ThisExpression") mutates = true;
        else if (
          (arg as AnyNode).computed &&
          isNode(obj) &&
          obj.type === "MemberExpression" &&
          isNode((obj as AnyNode).object) &&
          ((obj as AnyNode).object as AnyNode).type === "ThisExpression"
        ) {
          mutates = true;
        }
      }
      return;
    }
    // A collection-mutating method call on a `this.field` receiver
    // (`this.cache.set(…)`, `this.items.push(…)`, series 082): mutating a field
    // through a method requires `&mut self`, exactly as a mutating call on a
    // local binding marks that binding `mut` (`mutableBindings`). Syntactic and
    // field-shape-only, matching that existing name-based treatment.
    if (n.type === "CallExpression") {
      const callee = (n as AnyNode).callee;
      if (
        isNode(callee) &&
        callee.type === "MemberExpression" &&
        isNode(callee.object) &&
        callee.object.type === "MemberExpression" &&
        isNode((callee.object as AnyNode).object) &&
        ((callee.object as AnyNode).object as AnyNode).type === "ThisExpression"
      ) {
        const prop = identName(callee.property);
        if (prop && MUTATING_METHODS.has(prop)) mutates = true;
      }
    }
  });
  return mutates;
}

/**
 * The class field a method **consumes** out of `this` (series 068), or null. A
 * consuming candidate's body ends in a bare `return this.field;` — a terminal move
 * of the field out of the receiver. Because the move is the `return`, no `self` use
 * can follow it (return is terminal), which is exactly the design's "moves a field
 * out and does not use `self` after" condition, established syntactically without a
 * separate CFG pass. Broader move-out shapes (into an owned local, into a call arg)
 * stay non-consuming here — they keep the 038 clone / cargo backstop (fail-loud).
 *
 * The **non-`Copy`** gate is applied later (in the alias-escape pass, which has the
 * lowered field types): a `return this.n` of a `number` field is a candidate here
 * but is never emitted consuming (a Copy field needs no move-avoidance).
 */
function consumingField(body: unknown): string | null {
  // `classMethods` passes the `FunctionExpression`; its statement list is `body.body`.
  const fnBody = (body as { body?: { body?: AnyNode[] } } | null)?.body?.body;
  if (!Array.isArray(fnBody) || fnBody.length === 0) return null;
  const last = fnBody[fnBody.length - 1];
  if (!isNode(last) || last.type !== "ReturnStatement") return null;
  const arg = (last as AnyNode).argument;
  if (
    !isNode(arg) ||
    arg.type !== "MemberExpression" ||
    !isNode((arg as AnyNode).object) ||
    ((arg as AnyNode).object as AnyNode).type !== "ThisExpression"
  ) {
    return null;
  }
  return identName((arg as AnyNode).property);
}

/** Does a body call a self-mutating method on `this` (`this.<mutating>()`)? */
function callsMutatingThisMethod(
  body: unknown,
  mutating: Set<string>,
): boolean {
  let found = false;
  // `walk` (not `walkOwn`): `classMethods` passes the `FunctionExpression`
  // wrapper, which `walkOwn` treats as a boundary — matching `mutatesThis`.
  walk(body, (n) => {
    if (n.type !== "CallExpression") return;
    const callee = n.callee;
    if (
      isNode(callee) &&
      callee.type === "MemberExpression" &&
      isNode(callee.object) &&
      callee.object.type === "ThisExpression"
    ) {
      const prop = identName(callee.property);
      if (prop && mutating.has(prop)) found = true;
    }
  });
  return found;
}

/** Every method of a `class` declaration, with its class name. */
function classMethods(
  program: Program,
): { className: string; name: string; body: unknown; async: boolean }[] {
  const out: {
    className: string;
    name: string;
    body: unknown;
    async: boolean;
  }[] = [];
  for (const stmt of program.body) {
    if (stmt.type !== "ClassDeclaration") continue;
    const decl = stmt as unknown as {
      id?: { name?: string };
      body?: { body?: AnyNode[] };
    };
    const className = decl.id?.name;
    if (!className) continue;
    for (const m of decl.body?.body ?? []) {
      if (m.type === "MethodDefinition") {
        const name = identName((m as AnyNode).key);
        const value = (m as AnyNode).value;
        const isAsync = !!(value as { async?: boolean } | undefined)?.async;
        if (name) out.push({ className, name, body: value, async: isAsync });
      }
    }
  }
  return out;
}

// ── Fallibility (throw / Result propagation) ─────────────────────────────────

/**
 * Walk a subtree but stop at a nested function/class boundary — a `throw` or
 * call inside a nested function belongs to *that* function's fallibility, not the
 * enclosing one. (Nested functions are outside the dialect and fail loud in
 * lowering; the barrier keeps this analysis honest regardless.)
 */
function walkOwn(node: unknown, visit: (n: AnyNode) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walkOwn(child, visit);
    return;
  }
  if (!isNode(node)) return;
  visit(node);
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "ClassDeclaration"
  ) {
    return;
  }
  // A `try` with a `catch` handler *catches* its block's throws/fallible calls,
  // so they must not count toward the enclosing scope's fallibility. Skip the
  // `block`, but walk the `handler` and `finalizer` (a re-throw or un-caught
  // fallible call there still propagates). A `try` with no handler is walked
  // whole (errors propagate; lowering rejects that shape anyway).
  if (node.type === "TryStatement" && node.handler) {
    walkOwn(node.handler, visit);
    walkOwn(node.finalizer, visit);
    return;
  }
  for (const key in node) {
    if (key === "type") continue;
    walkOwn(node[key], visit);
  }
}

/** Does this body `throw` at its own level (not inside a nested function)? */
function bodyThrows(body: unknown): boolean {
  let found = false;
  walkOwn(body, (n) => {
    if (n.type === "ThrowStatement") found = true;
  });
  return found;
}

/**
 * Whether this body makes an **async-I/O namespace call** — `ns.m(...)` where
 * `ns` is a `fsAsync`/`http` local (series 100). Try-shielded like `bodyThrows`
 * (a caught async-I/O call is recovered by the try IIFE, not propagated). Such a
 * call is fallible + awaited (`.await?`), so its presence makes the enclosing
 * scope `Result`-returning, exactly as a `throw` or a fallible-fn call does.
 */
function bodyUsesAsyncIo(
  body: unknown,
  namespaces: ReadonlySet<string>,
): boolean {
  if (namespaces.size === 0) return false;
  let found = false;
  walkOwn(body, (n) => {
    if (n.type !== "CallExpression") return;
    const callee = n.callee;
    if (
      isNode(callee) &&
      callee.type === "MemberExpression" &&
      isNode(callee.object) &&
      callee.object.type === "Identifier" &&
      namespaces.has(callee.object.name as string)
    ) {
      found = true;
    }
  });
  return found;
}

/** The names this body calls directly (identifier callees, own level only). */
function calledNames(body: unknown): Set<string> {
  const names = new Set<string>();
  walkOwn(body, (n) => {
    if (n.type !== "CallExpression") return;
    const callee = n.callee;
    if (isNode(callee) && callee.type === "Identifier") {
      names.add(callee.name as string);
    }
  });
  return names;
}

/**
 * Callees inside a dynamic fan-out callback (series 051b): the arrow bodies of
 * `Promise.all(arr.map(f))`. `walkOwn` stops at an arrow boundary, so a fallible
 * async call inside the map callback is invisible to the enclosing scope's
 * `callsFree` — yet a fallible `Promise.all` fan-out emits `try_join_all(…).await?`,
 * whose `?` requires the enclosing scope to be `Result`. This descends *only* into
 * the `Promise.all` fan-out arrows (NOT `Promise.allSettled`, which never
 * `?`-propagates — each settled outcome stays `Result<T, String>`) so the fallible
 * inner callee counts toward the enclosing scope's fallibility.
 */
function fanOutCalledNames(body: unknown): Set<string> {
  const names = new Set<string>();
  walkOwn(body, (n) => {
    if (n.type !== "CallExpression") return;
    const callee = n.callee;
    // `Promise.all(<arg>)`.
    if (
      !isNode(callee) ||
      callee.type !== "MemberExpression" ||
      !isNode(callee.object) ||
      identName(callee.object) !== "Promise" ||
      identName(callee.property) !== "all"
    ) {
      return;
    }
    const args = n.arguments as AnyNode[] | undefined;
    const arg0 = args?.[0];
    // `<arr>.map(<arrow>)`.
    if (
      !isNode(arg0) ||
      arg0.type !== "CallExpression" ||
      !isNode(arg0.callee) ||
      arg0.callee.type !== "MemberExpression" ||
      identName(arg0.callee.property) !== "map"
    ) {
      return;
    }
    const mapArgs = arg0.arguments as AnyNode[] | undefined;
    const arrow = mapArgs?.[0];
    if (!isNode(arrow) || arrow.type !== "ArrowFunctionExpression") return;
    // Descend the arrow body explicitly (walkOwn stops at the boundary above).
    for (const inner of calledNames(arrow.body)) names.add(inner);
  });
  return names;
}

/**
 * Method names this body calls (`obj.M(…)` / `this.M(…)`), restricted to `known`
 * declared class-method names so built-ins (`.push`, `console.log`) never count.
 */
function calledMethodNames(body: unknown, known: Set<string>): Set<string> {
  const names = new Set<string>();
  walkOwn(body, (n) => {
    if (n.type !== "CallExpression") return;
    const callee = n.callee;
    if (isNode(callee) && callee.type === "MemberExpression") {
      const prop = identName(callee.property);
      if (prop && known.has(prop)) names.add(prop);
    }
  });
  return names;
}

/** Class names `new`ed in this body (`new C(…)`, identifier callees). */
function newedClassNames(body: unknown): Set<string> {
  const names = new Set<string>();
  walkOwn(body, (n) => {
    if (n.type !== "NewExpression") return;
    const name = identName(n.callee);
    if (name) names.add(name);
  });
  return names;
}

/** One scope in the fallibility fixpoint (a free fn, the script, a method, or a ctor). */
interface FallScope {
  key: string;
  throws: boolean;
  callsFree: Set<string>;
  callsMethod: Set<string>;
  newsClass: Set<string>;
  /** Set for a free fn / the script (contributes to the public `fallible` set). */
  freeOrScript?: boolean;
  /** Set for a class method (its name feeds method-call fallibility). */
  methodName?: string;
  /** Set for a constructor (its class feeds `new`-fallibility). */
  ctorClass?: string;
}

/** Methods and constructors of every non-error class, as fallibility scopes. */
function classFallScopes(program: Program): {
  className: string;
  methodName?: string;
  ctorClass?: string;
  body: unknown;
}[] {
  const out: {
    className: string;
    methodName?: string;
    ctorClass?: string;
    body: unknown;
  }[] = [];
  for (const stmt of program.body) {
    if (stmt.type !== "ClassDeclaration" || isErrorSubclass(stmt)) continue;
    const decl = stmt as unknown as {
      id?: { name?: string };
      body?: { body?: AnyNode[] };
    };
    const className = decl.id?.name;
    if (!className) continue;
    for (const m of decl.body?.body ?? []) {
      if (m.type !== "MethodDefinition") continue;
      const kind = (m as AnyNode).kind;
      // The method's block body (not the FunctionExpression) — `walkOwn` stops at
      // a function boundary, so passing the wrapper would hide every throw/call.
      const value = (m as AnyNode).value;
      const body = isNode(value) ? value.body : undefined;
      if (kind === "constructor") {
        out.push({ className, ctorClass: className, body });
      } else if (kind === "method") {
        const name = identName((m as AnyNode).key);
        if (name) out.push({ className, methodName: name, body });
      }
    }
  }
  return out;
}

/**
 * Fixpoint over the whole call graph — free functions, the script, class methods,
 * and constructors. A scope is fallible if it `throw`s (own-level, `try`-shielded)
 * or calls a fallible free fn / method (by name) / fallible-ctor `new`. Method
 * fallibility feeds back in, so method→method propagation converges here. Returns
 * the public free-fn+script set plus the derived fallible method names and ctor
 * class names.
 */
function analyzeFallible(
  program: Program,
  script: Statement[],
  panicScopes: ReadonlySet<string>,
  ioSyncFallibleLocals: ReadonlySet<string>,
  ioAsyncNamespaces: ReadonlySet<string>,
): {
  fallible: Set<string>;
  fallibleMethods: Set<string>;
  fallibleCtors: Set<string>;
} {
  const classScopes = classFallScopes(program);
  const methodUniverse = new Set<string>();
  for (const s of classScopes)
    if (s.methodName) methodUniverse.add(s.methodName);

  const scopes: FallScope[] = [];
  const record = (key: string, body: unknown, extra: Partial<FallScope>) => {
    const callsFree = calledNames(body);
    // A fallible `Promise.all(arr.map(f))` fan-out `?`-propagates in this scope, so
    // its inner callee counts here even though it sits inside the map arrow (series
    // 051b; `walkOwn` otherwise stops at the arrow boundary).
    for (const c of fanOutCalledNames(body)) callsFree.add(c);
    scopes.push({
      key,
      // An awaited async-I/O namespace call (series 100) is fallible + awaited,
      // so — like a `throw` — it makes this scope `Result`-returning.
      throws: bodyThrows(body) || bodyUsesAsyncIo(body, ioAsyncNamespaces),
      callsFree,
      callsMethod: calledMethodNames(body, methodUniverse),
      newsClass: newedClassNames(body),
      ...extra,
    });
  };

  for (const stmt of program.body) {
    const named = namedFunction(stmt);
    if (named) record(named.name, named.fn.body, { freeOrScript: true });
  }
  record(SCRIPT_SCOPE, script, { freeOrScript: true });
  for (const s of classScopes) {
    const key = s.ctorClass
      ? `new ${s.className}`
      : `${s.className}.${s.methodName}`;
    record(key, s.body, { methodName: s.methodName, ctorClass: s.ctorClass });
  }

  const fallible = new Set<string>();
  // Seed the fallible set with the sync-fallible I/O local aliases (series 100):
  // `readFile`/`writeFile`/… act as fallible **leaf** names, so any scope whose
  // `callsFree` includes one propagates to `Result` through the fixpoint below —
  // exactly as a call to a fallible user fn does. (They are not scope keys, so
  // they never leak into the extracted public set.)
  for (const local of ioSyncFallibleLocals) fallible.add(local);
  // A `"use panic"` scope's own `throw`s become `panic!`, so they do not make it
  // fallible; it also never *becomes* fallible via propagation (excluded below).
  for (const s of scopes)
    if (s.throws && !panicScopes.has(s.key)) fallible.add(s.key);
  for (;;) {
    const methodNames = new Set<string>();
    const ctorClasses = new Set<string>();
    for (const s of scopes) {
      if (!fallible.has(s.key)) continue;
      if (s.methodName) methodNames.add(s.methodName);
      if (s.ctorClass) ctorClasses.add(s.ctorClass);
    }
    let changed = false;
    for (const s of scopes) {
      if (fallible.has(s.key) || panicScopes.has(s.key)) continue;
      const hit =
        [...s.callsFree].some((c) => fallible.has(c)) ||
        [...s.callsMethod].some((m) => methodNames.has(m)) ||
        [...s.newsClass].some((c) => ctorClasses.has(c));
      if (hit) {
        fallible.add(s.key);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const publicFallible = new Set<string>();
  const fallibleMethods = new Set<string>();
  const fallibleCtors = new Set<string>();
  for (const s of scopes) {
    if (!fallible.has(s.key)) continue;
    if (s.freeOrScript) publicFallible.add(s.key);
    if (s.methodName) fallibleMethods.add(s.methodName);
    if (s.ctorClass) fallibleCtors.add(s.ctorClass);
  }
  return { fallible: publicFallible, fallibleMethods, fallibleCtors };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/** A top-level function declaration with a name, else null. */
function namedFunction(
  stmt: Statement,
): { name: string; fn: FunctionDeclaration } | null {
  if (stmt.type !== "FunctionDeclaration") return null;
  const fn = stmt as FunctionDeclaration;
  return fn.id ? { name: fn.id.name, fn } : null;
}

export function analyzeModule(program: Program): ModuleAnalysis {
  // Declared `enum`s — collected first so param-ownership (`isCopyType`) sees them.
  const enums = new Set<string>();
  for (const stmt of program.body) {
    if (stmt.type === "TSEnumDeclaration") {
      const id = (stmt as { id?: { name?: string } }).id;
      if (id?.name) enums.add(id.name);
    }
  }

  // Pre-scan the extended base classes (series 053b) — a base-typed param is
  // `impl IA` (by value), so its call-site ownership must be `move`, not a
  // borrow. Needed before `analyzeFunction` classifies param ownership.
  const extendedBases = new Set<string>();
  {
    const clsNames = new Set<string>();
    for (const stmt of program.body) {
      if (stmt.type === "ClassDeclaration" && !isErrorSubclass(stmt)) {
        const id = (stmt as { id?: { name?: string } }).id;
        if (id?.name) clsNames.add(id.name);
      }
    }
    for (const stmt of program.body) {
      if (stmt.type !== "ClassDeclaration" || isErrorSubclass(stmt)) continue;
      const sup = (stmt as { superClass?: unknown }).superClass;
      if (isNode(sup) && sup.type === "Identifier" && clsNames.has(sup.name as string)) {
        extendedBases.add(sup.name as string);
      }
    }
  }

  const fns = new Map<string, FnInfo>();
  const script: Statement[] = [];

  for (const stmt of program.body) {
    const named = namedFunction(stmt);
    if (named) {
      fns.set(named.name, analyzeFunction(named.fn, enums, extendedBases));
    } else script.push(stmt);
  }

  // Self-mutating methods (→ `&mut self`, and `mut` for their call-site receiver).
  // A method mutates `self` if it assigns a `this.<field>` directly, or — a
  // fixpoint — calls another self-mutating method on `this` (so `pay` that calls
  // `this.withdraw()` is itself `&mut self`).
  const methods = classMethods(program);
  const methodNames = new Set<string>(methods.map((m) => m.name));
  // `async` method names (series 054a). Name-based, like `mutatingMethods` /
  // `fallibleMethods` — an `await obj.M(...)` recognizes `M` as async through
  // this set (the same-name-across-classes edge is the documented method limit).
  const asyncMethods = new Set<string>();
  for (const m of methods) if (m.async) asyncMethods.add(m.name);
  // Method-parameter ownership (series 060): reuse the free-fn analysis over each
  // method's body so a param resolves to `ref`/`refMut`/`move`. Name-keyed (a
  // same-name method across classes: last wins — the documented method limit).
  const methodParams = new Map<string, ParamInfo[]>();
  for (const m of methods) {
    methodParams.set(
      m.name,
      analyzeFunction(m.body as FunctionDeclaration, enums, extendedBases).params,
    );
  }
  const mutatingMethods = new Set<string>();
  for (const m of methods) if (mutatesThis(m.body)) mutatingMethods.add(m.name);
  for (;;) {
    let changed = false;
    for (const m of methods) {
      if (mutatingMethods.has(m.name)) continue;
      if (callsMutatingThisMethod(m.body, mutatingMethods)) {
        mutatingMethods.add(m.name);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Consuming-method candidates (series 068): a `m(): T { … return this.field }`
  // whose receiver is *not* already `&mut self` (a mutating method keeps its
  // name-based receiver). The non-`Copy` gate and the call-site-reuse demotion are
  // applied later, in the alias-escape pass (which has the lowered field types).
  const consumingCandidates = new Map<string, string>();
  for (const m of methods) {
    if (mutatingMethods.has(m.name)) continue;
    const field = consumingField(m.body);
    if (field) consumingCandidates.set(m.name, field);
  }

  const mut = new Map<string, Set<string>>();
  for (const stmt of program.body) {
    const named = namedFunction(stmt);
    if (named)
      mut.set(
        named.name,
        mutableBindings(named.fn.body, fns, mutatingMethods, methodParams),
      );
  }
  mut.set(
    SCRIPT_SCOPE,
    mutableBindings(script, fns, mutatingMethods, methodParams),
  );
  // Each class method is its own mutability scope (`ClassName.method`).
  for (const m of methods) {
    mut.set(
      `${m.className}.${m.name}`,
      mutableBindings(m.body, fns, mutatingMethods, methodParams),
    );
  }

  // Custom error classes (`class X extends Error`) are collected separately and
  // kept *out* of `structs` — they map to error types, not general data structs.
  const errorClasses = new Map<
    string,
    { name: string; fields: ErrorField[] }
  >();
  for (const stmt of program.body) {
    if (stmt.type === "ClassDeclaration" && isErrorSubclass(stmt)) {
      const id = (stmt as { id?: { name?: string } }).id;
      // Fields need `lowerType`, so seed empty here; `lower()` fills them in.
      if (id?.name) errorClasses.set(id.name, { name: id.name, fields: [] });
    }
  }

  // Declared nominal types: interfaces and (non-error) classes resolve to a `struct`.
  // `classes` is the class-only subset (objects with an `impl` — identity), used
  // by `refineRc` to decide which bindings a `"use rc"` scope wraps in `Rc`.
  const structs = new Set<string>();
  const classes = new Set<string>();
  for (const stmt of program.body) {
    if (
      stmt.type === "TSInterfaceDeclaration" ||
      (stmt.type === "ClassDeclaration" && !isErrorSubclass(stmt))
    ) {
      const id = (stmt as { id?: { name?: string } }).id;
      if (id?.name) structs.add(id.name);
    }
    if (stmt.type === "ClassDeclaration" && !isErrorSubclass(stmt)) {
      const id = (stmt as { id?: { name?: string } }).id;
      if (id?.name) classes.add(id.name);
    }
  }

  // Top-level free-function names (series 071 increment 2): a reference to one
  // inside a synthesized interface-literal method is a path, not a capture.
  const topLevelFns = new Set<string>();
  for (const stmt of program.body) {
    if (stmt.type === "FunctionDeclaration") {
      const id = (stmt as { id?: { name?: string } }).id;
      if (id?.name) topLevelFns.add(id.name);
    }
  }

  // ── Class inheritance facts (series 053) ────────────────────────────────────
  // `superclass`: subclass → its direct base (a plain `extends A`, not `extends
  // Error`). `ownFields`: per class, the field names it declares (property
  // definitions + `constructor(public x: T)` parameter properties). `ownMethods`:
  // per class, its own method names.
  const superclass = new Map<string, string>();
  const ownFields = new Map<string, Set<string>>();
  const ownMethods = new Map<string, Set<string>>();
  for (const stmt of program.body) {
    if (stmt.type !== "ClassDeclaration" || isErrorSubclass(stmt)) continue;
    const decl = stmt as unknown as {
      id?: { name?: string };
      superClass?: unknown;
      body?: { body?: AnyNode[] };
    };
    const name = decl.id?.name;
    if (!name) continue;
    const sup = decl.superClass;
    if (isNode(sup) && sup.type === "Identifier") {
      superclass.set(name, sup.name as string);
    }
    const fields = new Set<string>();
    const methods = new Set<string>();
    for (const m of decl.body?.body ?? []) {
      if (m.type === "PropertyDefinition") {
        const fn = identName((m as AnyNode).key);
        if (fn) fields.add(fn);
      } else if (m.type === "MethodDefinition") {
        const mn = (m as AnyNode).kind;
        if (mn === "constructor") {
          const ctorParams =
            ((m as AnyNode).value as AnyNode)?.params ?? [];
          for (const p of ctorParams as AnyNode[]) {
            if (p.type === "TSParameterProperty") {
              const pn = identName((p as AnyNode).parameter);
              if (pn) fields.add(pn);
            }
          }
        } else if (mn === "method") {
          const nm = identName((m as AnyNode).key);
          if (nm) methods.add(nm);
        }
      }
    }
    ownFields.set(name, fields);
    ownMethods.set(name, methods);
  }
  // `baseClasses`: every class named as some subclass's base. `inheritedFields`:
  // transitive ancestor own-fields. `overrides`: methods a subclass redefines
  // that an ancestor also declares (so they shadow the trait default).
  const baseClasses = new Set<string>();
  for (const base of superclass.values()) {
    if (classes.has(base)) baseClasses.add(base);
  }
  const inheritedFields = new Map<string, Set<string>>();
  const overrides = new Map<string, Set<string>>();
  for (const cls of classes) {
    const inh = new Set<string>();
    const ovr = new Set<string>();
    const own = ownMethods.get(cls) ?? new Set();
    let cur = superclass.get(cls);
    while (cur && classes.has(cur)) {
      for (const f of ownFields.get(cur) ?? []) inh.add(f);
      for (const m of own) {
        if ((ownMethods.get(cur) ?? new Set()).has(m)) ovr.add(m);
      }
      cur = superclass.get(cur);
    }
    inheritedFields.set(cls, inh);
    overrides.set(cls, ovr);
  }
  const dynFieldReads = new Map<string, Set<string>>();

  // Scopes carrying a leading `"use panic"` directive (series 028a). Detected
  // before fallibility so `analyzeFallible` can treat them as infallible.
  const panicScopes = new Set<string>();
  for (const stmt of program.body) {
    const named = namedFunction(stmt);
    if (named && leadingDirectives(named.fn.body?.body).includes("use panic")) {
      panicScopes.add(named.name);
    }
  }
  if (leadingDirectives(script).includes("use panic")) {
    panicScopes.add(SCRIPT_SCOPE);
  }

  // Scopes carrying a leading `"use rc"` directive (series 028b) — the same
  // detection as `"use panic"`, in the `"use strict"` prologue position.
  const rcScopes = new Set<string>();
  for (const stmt of program.body) {
    const named = namedFunction(stmt);
    if (named && leadingDirectives(named.fn.body?.body).includes("use rc")) {
      rcScopes.add(named.name);
    }
  }
  if (leadingDirectives(script).includes("use rc")) {
    rcScopes.add(SCRIPT_SCOPE);
  }

  // Scopes carrying a leading `"use arena"` directive (series 028c) — same
  // detection as `"use panic"`/`"use rc"`, in the prologue position.
  const arenaScopes = new Set<string>();
  for (const stmt of program.body) {
    const named = namedFunction(stmt);
    if (named && leadingDirectives(named.fn.body?.body).includes("use arena")) {
      arenaScopes.add(named.name);
    }
  }
  if (leadingDirectives(script).includes("use arena")) {
    arenaScopes.add(SCRIPT_SCOPE);
  }

  // `@t2r/std` bindings (series 084) + the series-100 I/O derivations. Computed
  // once here so `analyzeFallible` can seed the fallible I/O leaves + detect
  // awaited async-I/O usage, and the result is reused in the returned analysis.
  const stdShim = collectStdShimBindings(program);
  const ioSyncFallibleLocals = new Set<string>();
  const ioAsyncNamespaces = new Map<string, "fsAsync" | "http">();
  for (const [local, intrinsic] of stdShim) {
    if (FALLIBLE_SYNC_IO.has(intrinsic)) ioSyncFallibleLocals.add(local);
    if (intrinsic === "fsAsync") ioAsyncNamespaces.set(local, "fsAsync");
    if (intrinsic === "http") ioAsyncNamespaces.set(local, "http");
  }

  const { fallible, fallibleMethods, fallibleCtors } = analyzeFallible(
    program,
    script,
    panicScopes,
    ioSyncFallibleLocals,
    new Set(ioAsyncNamespaces.keys()),
  );

  // Top-level `async` function declarations (drives the `await`-target check and
  // the un-awaited-call rejection in lowering).
  const asyncFns = new Set<string>();
  for (const stmt of program.body) {
    const named = namedFunction(stmt);
    if (named?.fn.async) asyncFns.add(named.name);
  }

  // Top-level sync generator declarations (series 025d) — a `for-of` over a call
  // to one consumes the returned `impl Iterator` directly.
  const generators = new Set<string>();
  for (const stmt of program.body) {
    if (
      stmt.type === "FunctionDeclaration" &&
      (stmt as { generator?: boolean }).generator === true
    ) {
      const id = (stmt as { id?: { name?: string } }).id;
      if (id?.name) generators.add(id.name);
    }
  }

  return {
    fns,
    mut,
    structs,
    // `@t2r/std` std-shim bindings (series 084) — recognized by the reserved
    // import specifier. `parseResultBindings` fills during lowering.
    stdShim,
    parseResultBindings: new Map(),
    // Populated during lowering as `const r = rng(seed)` handle bindings are seen (089).
    rngBindings: new Set(),
    jsonValueBindings: new Set(),
    // I/O handle bindings (series 100), filled during lowering; the async-I/O
    // namespace map is derived from the imports above.
    writerBindings: new Set(),
    httpResponseBindings: new Set(),
    ioAsyncNamespaces,
    // Regex bindings + first-match result bindings (series 101), filled during lowering.
    regexBindings: new Map(),
    matchBindings: new Set(),
    // Date + clock handle bindings (series 102), filled during lowering.
    dateBindings: new Set(),
    clockBindings: new Set(),
    // Union-type enums (093) — filled by the `collectUnions` pre-pass in `lower()`.
    unionEnums: new Map(),
    // Field types are filled in by `lower()` (they need `lowerType`); empty here.
    structFields: new Map(),
    // Filled by `lower()` after `bindingTypes` (needs the resolved map/set types).
    hashEqStructs: new Set(),
    structKeyStructs: new Set(),
    // Populated during lowering as `Object.entries` bindings are seen.
    entriesBindings: new Set(),
    // Populated during lowering when a binding's init is a `spawn` node (051c).
    joinHandleBindings: new Set(),
    mutatingMethods,
    methodParams,
    consumingCandidates,
    // Filled during lowering as getters/setters are seen (like `structFields`).
    accessors: new Map(),
    tryCounter: 0,
    asyncMethods,
    methodNames,
    fallible,
    fallibleMethods,
    fallibleCtors,
    errorClasses,
    asyncFns,
    enums,
    panicScopes,
    classes,
    // Namespace / import-alias path roots (050d) — filled by `lower()`/`lowerCrate`.
    namespaces: new Set(),
    topLevelFns,
    rcScopes,
    arenaScopes,
    generators,
    // Filled by `lower()` — needs `bindingTypes` to resolve `const it = g()` binds.
    steppedGenerators: new Set(),
    // Filled by `lower()` — `const it = g()` binding → generator fn name.
    generatorInstances: new Map(),
    // Filled by `lower()` (needs `lowerType`) — generator name → declared `R`.
    generatorRetTypes: new Map(),
    // Filled by `lower()` (needs `lowerType`) — generator name → yield type `Y`.
    generatorItemTypes: new Map(),
    // Filled by `lower()` (needs `lowerType`) — generator name → declared `TNext`.
    generatorNextTypes: new Map(),
    // Filled by `lower()` — generator names whose yield result is read (#32).
    bidirectionalGenerators: new Set(),
    // Filled in by `lower()` (needs `lowerType`); empty/zero here.
    bindingTypes: new Map(),
    // Names currently narrowed to their inner `T` (series 066): inside an
    // `if let Some(x)` block `x` is a plain `T`, not `Option<T>`, so the arithmetic
    // fail-loud guard must skip it. Pushed/popped by `lowerIf` around the some-body.
    narrowedOptions: new Set(),
    // In-scope generic type-param names (series 081); pushed/popped by `lowerClass`
    // and generic methods. Empty outside a generic scope.
    typeParams: new Set(),
    // Class-level generic params + accumulated JS-operator trait bounds (series 088);
    // set/reset by `lowerClass`, filled during body lowering, merged in `lowerClassBody`.
    classTypeParams: new Set(),
    opBounds: new Map(),
    // Built by `lower()` only when source text is threaded in (series 082); null
    // otherwise, in which case `collectionOf` uses the `bindingTypes` path alone.
    typeOracle: null,
    readonlyFields: new Map(),
    baseInterfaces: new Set(),
    interfaceExtends: new Map(),
    dynInterfaceBindings: new Map(),
    behavioralInterfaces: new Set(),
    interfaceMethods: new Map(),
    liftedFns: [],
    liftCounter: 0,
    litStructs: [],
    litCounter: 0,
    restStructs: new Map(),
    superclass,
    inheritedFields,
    overrides,
    baseClasses,
    dynFieldReads,
    dynBindings: new Map(),
    ownClassFields: ownFields,
  };
}

/** Is a class declaration `class X extends Error { … }` (a custom error type)? */
export function isErrorSubclass(stmt: Statement): boolean {
  if (stmt.type !== "ClassDeclaration") return false;
  const sup = (stmt as { superClass?: unknown }).superClass;
  return (
    isNode(sup) && sup.type === "Identifier" && (sup.name as string) === "Error"
  );
}
