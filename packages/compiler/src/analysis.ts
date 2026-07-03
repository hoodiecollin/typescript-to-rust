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
 * Fixpoint over the top-level call graph: a function is fallible if it throws or
 * calls a fallible function. The generated `main` (`SCRIPT_SCOPE`) is included so
 * a script that propagates a throwing call returns `Result` too.
 */
function analyzeFallible(
  program: Program,
  script: Statement[],
): Set<string> {
  const throws = new Map<string, boolean>();
  const calls = new Map<string, Set<string>>();

  for (const stmt of program.body) {
    const named = namedFunction(stmt);
    if (!named) continue;
    throws.set(named.name, bodyThrows(named.fn.body));
    calls.set(named.name, calledNames(named.fn.body));
  }
  throws.set(SCRIPT_SCOPE, bodyThrows(script));
  calls.set(SCRIPT_SCOPE, calledNames(script));

  const fallible = new Set<string>();
  for (const [name, t] of throws) if (t) fallible.add(name);
  for (;;) {
    let changed = false;
    for (const [name, callees] of calls) {
      if (fallible.has(name)) continue;
      for (const c of callees) {
        if (fallible.has(c)) {
          fallible.add(name);
          changed = true;
          break;
        }
      }
    }
    if (!changed) return fallible;
  }
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
  const methods = classMethods(program);
  const mutatingMethods = new Set<string>();
  for (const m of methods) if (mutatesThis(m.body)) mutatingMethods.add(m.name);

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

  // Declared nominal types: interfaces and classes both resolve to a `struct`.
  const structs = new Set<string>();
  for (const stmt of program.body) {
    if (
      stmt.type === "TSInterfaceDeclaration" ||
      stmt.type === "ClassDeclaration"
    ) {
      const id = (stmt as { id?: { name?: string } }).id;
      if (id?.name) structs.add(id.name);
    }
  }

  const fallible = analyzeFallible(program, script);

  // Top-level `async` function declarations (drives the `await`-target check and
  // the un-awaited-call rejection in lowering).
  const asyncFns = new Set<string>();
  for (const stmt of program.body) {
    const named = namedFunction(stmt);
    if (named && named.fn.async) asyncFns.add(named.name);
  }

  return { fns, mut, structs, mutatingMethods, fallible, asyncFns };
}
