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

function mutableBindings(body: unknown, fns: Map<string, FnInfo>): Set<string> {
  const mut = new Set<string>();
  walk(body, (n) => {
    const assigned = assignmentTarget(n);
    if (assigned) mut.add(assigned);

    const mutating = isMutatingMethodCall(n);
    if (mutating) mut.add(mutating.object);

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

  const mut = new Map<string, Set<string>>();
  for (const stmt of program.body) {
    const named = namedFunction(stmt);
    if (named) mut.set(named.name, mutableBindings(named.fn.body, fns));
  }
  mut.set(SCRIPT_SCOPE, mutableBindings(script, fns));

  return { fns, mut };
}
