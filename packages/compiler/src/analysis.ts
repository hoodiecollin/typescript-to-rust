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

import type { FunctionDeclaration, Program, Statement } from "./ast";

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
}

export interface FnInfo {
  params: ParamInfo[];
}

export interface ModuleAnalysis {
  /** function name → signature ownership info */
  fns: Map<string, FnInfo>;
  /** scope key → set of binding names that must be `mut` */
  mut: Map<string, Set<string>>;
  /** names of declared `interface`s/`class`es — resolved to nominal `struct` types */
  structs: Set<string>;
  /** names of class methods that mutate `this` (→ a `&mut self` receiver) */
  mutatingMethods: Set<string>;
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
   * Names of declared **custom error classes** (`class X extends Error { … }`).
   * They are emitted as error `struct`s + `Display`/`Error` impls (not general
   * data structs, so they are *excluded* from `structs`); a `throw new X(…)`
   * boxes them, and a non-empty set upgrades the program error type from `String`
   * to `Box<dyn Error>`.
   */
  errorClasses: Set<string>;
  /**
   * Names of top-level `async` function declarations. A call to one is only valid
   * `await`ed (an un-polled future never runs), and `await` only targets one of
   * these — both enforced in lowering. The generated `main` becomes
   * `#[tokio::main] async fn main()` when the script `await`s.
   */
  asyncFns: Set<string>;
}

/** Scope key for the generated `fn main()` wrapping top-level script statements. */
export const SCRIPT_SCOPE = "<script>";

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

function isCopyType(annotation: unknown): boolean {
  const inner = isNode(annotation) ? annotation.typeAnnotation : undefined;
  const t = isNode(inner) ? inner.type : undefined;
  return t === "TSNumberKeyword" || t === "TSBooleanKeyword";
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

function analyzeFunction(fn: FunctionDeclaration): FnInfo {
  const params = fn.params.map((p) => {
    const isCopy = isCopyType(p.typeAnnotation);
    return {
      name: p.name,
      ownership: classifyParam(p.name, fn.body, isCopy),
      isCopy,
    };
  });
  return { params };
}

// ── Local mutability ─────────────────────────────────────────────────────────

function mutableBindings(
  body: unknown,
  fns: Map<string, FnInfo>,
  mutatingMethods: Set<string>,
): Set<string> {
  const mut = new Set<string>();
  walk(body, (n) => {
    const assigned = assignmentTarget(n);
    if (assigned) mut.add(assigned);

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
): { className: string; name: string; body: unknown }[] {
  const out: { className: string; name: string; body: unknown }[] = [];
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
        if (name) out.push({ className, name, body: value });
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
    scopes.push({
      key,
      throws: bodyThrows(body),
      callsFree: calledNames(body),
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
  for (const s of scopes) if (s.throws) fallible.add(s.key);
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
      if (fallible.has(s.key)) continue;
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
  const fns = new Map<string, FnInfo>();
  const script: Statement[] = [];

  for (const stmt of program.body) {
    const named = namedFunction(stmt);
    if (named) fns.set(named.name, analyzeFunction(named.fn));
    else script.push(stmt);
  }

  // Self-mutating methods (→ `&mut self`, and `mut` for their call-site receiver).
  // A method mutates `self` if it assigns a `this.<field>` directly, or — a
  // fixpoint — calls another self-mutating method on `this` (so `pay` that calls
  // `this.withdraw()` is itself `&mut self`).
  const methods = classMethods(program);
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
  const errorClasses = new Set<string>();
  for (const stmt of program.body) {
    if (stmt.type === "ClassDeclaration" && isErrorSubclass(stmt)) {
      const id = (stmt as { id?: { name?: string } }).id;
      if (id?.name) errorClasses.add(id.name);
    }
  }

  // Declared nominal types: interfaces and (non-error) classes resolve to a `struct`.
  const structs = new Set<string>();
  for (const stmt of program.body) {
    if (
      stmt.type === "TSInterfaceDeclaration" ||
      (stmt.type === "ClassDeclaration" && !isErrorSubclass(stmt))
    ) {
      const id = (stmt as { id?: { name?: string } }).id;
      if (id?.name) structs.add(id.name);
    }
  }

  const { fallible, fallibleMethods, fallibleCtors } = analyzeFallible(
    program,
    script,
  );

  // Top-level `async` function declarations (drives the `await`-target check and
  // the un-awaited-call rejection in lowering).
  const asyncFns = new Set<string>();
  for (const stmt of program.body) {
    const named = namedFunction(stmt);
    if (named && named.fn.async) asyncFns.add(named.name);
  }

  return {
    fns,
    mut,
    structs,
    mutatingMethods,
    fallible,
    fallibleMethods,
    fallibleCtors,
    errorClasses,
    asyncFns,
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
