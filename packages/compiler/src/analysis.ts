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
import type { HirFn, RustType } from "./hir";

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
  structFields: Map<string, { name: string; ty: RustType }[]>;
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
   * Binding name → its resolved `RustType` (series 048). Populated by `lower()`
   * (it needs `lowerType`) over every `const`/`let`/`var` and function param.
   * Used by the callback-lifting pass to type a forwarded free variable and to
   * resolve a receiver's element type. Name-based, last-write-wins (a documented
   * limit, matching the rest of this intra-procedural analysis).
   */
  bindingTypes: Map<string, RustType>;
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
   * Bindings whose value is a `&dyn IA` / `Box<dyn IA>` element (series 053c),
   * keyed by the binding/param name → the base (trait-owning) class name. A
   * field read on such a binding routes through a trait accessor (`a.x()`), and
   * a method call dispatches virtually. Populated during lowering.
   */
  dynBindings: Map<string, string>;
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
  const params = fn.params.map((p) => {
    const isCopy = isCopyType(p.typeAnnotation, enums);
    // A base-typed param becomes `impl IA` (by value, series 053b/INH10), so it
    // must be passed owned — force `move` regardless of read-only use.
    const annotation = p.typeAnnotation?.typeAnnotation ?? null;
    if (isBaseTypedParam(p, extendedBases)) {
      return {
        name: p.name,
        ownership: "move" as const,
        isCopy: false,
        optional: isOptionalParam(p),
        annotation,
      };
    }
    return {
      name: p.name,
      ownership: classifyParam(p.name, fn.body, isCopy),
      isCopy,
      optional: isOptionalParam(p),
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

function mutableBindings(
  body: unknown,
  fns: Map<string, FnInfo>,
  mutatingMethods: Set<string>,
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

    const mutating = isMutatingMethodCall(n);
    if (mutating) mut.add(mutating.object);

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
  });
  return mut;
}

/** Does a body assign to a `this.<field>` (marking a method self-mutating)? */
function mutatesThis(body: unknown): boolean {
  let mutates = false;
  walk(body, (n) => {
    if (n.type !== "AssignmentExpression") return;
    const left = n.left;
    if (
      isNode(left) &&
      left.type === "MemberExpression" &&
      isNode((left as AnyNode).object) &&
      ((left as AnyNode).object as AnyNode).type === "ThisExpression"
    ) {
      mutates = true;
    }
  });
  return mutates;
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
      throws: bodyThrows(body),
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

  const mut = new Map<string, Set<string>>();
  for (const stmt of program.body) {
    const named = namedFunction(stmt);
    if (named)
      mut.set(named.name, mutableBindings(named.fn.body, fns, mutatingMethods));
  }
  mut.set(SCRIPT_SCOPE, mutableBindings(script, fns, mutatingMethods));
  // Each class method is its own mutability scope (`ClassName.method`).
  for (const m of methods) {
    mut.set(
      `${m.className}.${m.name}`,
      mutableBindings(m.body, fns, mutatingMethods),
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

  const { fallible, fallibleMethods, fallibleCtors } = analyzeFallible(
    program,
    script,
    panicScopes,
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
    // Field types are filled in by `lower()` (they need `lowerType`); empty here.
    structFields: new Map(),
    // Populated during lowering as `Object.entries` bindings are seen.
    entriesBindings: new Set(),
    // Populated during lowering when a binding's init is a `spawn` node (051c).
    joinHandleBindings: new Set(),
    mutatingMethods,
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
    rcScopes,
    arenaScopes,
    generators,
    // Filled in by `lower()` (needs `lowerType`); empty/zero here.
    bindingTypes: new Map(),
    readonlyFields: new Map(),
    baseInterfaces: new Set(),
    interfaceExtends: new Map(),
    dynInterfaceBindings: new Map(),
    liftedFns: [],
    liftCounter: 0,
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
