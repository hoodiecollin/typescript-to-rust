/**
 * Front-mutated arrays → `VecDeque` (series 116, issue #78). An array binding that
 * is ever `shift`/`unshift`-ed lowers to a `VecDeque<T>` for O(1) front operations
 * (`pop_front`/`push_front`) instead of O(n) `Vec::remove(0)`/`insert(0, …)`.
 *
 * A standalone, pure HIR → HIR pass mirroring `refineSplitLazy`/`refineStrings`. Per
 * function/method/`main` body it (1) collects the local bindings that are front-
 * mutated (a `method` named `shift`/`unshift`, or an `arrayMutLen` from `unshift`),
 * then (2) rewrites, for each such binding: the `let` type (`vec` → `vec{deque}`),
 * the construction (`init` wrapped in `tslib::array::deque_from_vec`), and every
 * mutating call — `push`→`push_back`, `pop`→`pop_back`, `shift`→`pop_front`,
 * `unshift`→`push_front`, and `splice`→`deque_splice`. `VecDeque` supports index /
 * `len` / iteration natively, so the array's other operations are untouched; a
 * `Vec`-only op (`sort`/`join`/…) on a deque binding routes through the shared
 * interop helpers (`tslib::array::deque_*`) — see the design.
 *
 * Detection is per-body and by binding name; a binding that crosses a function
 * boundary (passed to / returned from a fn typed `Vec`) stays `Vec` at the boundary
 * and fails loud at cargo rather than silently diverging — the whole-program
 * propagation is a follow-up, not a silent cap.
 */

import type { HirExpr, HirModule, HirStmt } from "./hir";

/** JS mutation-method name → the `VecDeque` method it lowers to. */
const DEQUE_METHOD: Record<string, string> = {
  push: "push_back",
  pop: "pop_back",
  shift: "pop_front",
  unshift: "push_front",
};

export function refineDeque(module: HirModule): HirModule {
  for (const body of moduleBodies(module)) {
    const deque = collectDeque(body);
    if (deque.size > 0) rewriteDeque(body, deque);
  }
  return module;
}

function moduleBodies(module: HirModule): HirStmt[][] {
  const bodies: HirStmt[][] = [];
  for (const item of module.items) {
    if (item.kind === "fn") bodies.push(item.body);
    else if (item.kind === "class") {
      if (item.ctor) bodies.push(item.ctor.body);
      for (const m of item.methods) bodies.push(m.body);
    }
  }
  bodies.push(module.main);
  return bodies;
}

function isObj(n: unknown): n is Record<string, unknown> {
  return n !== null && typeof n === "object";
}

/** The ident name of an expression receiver, if it is a bare identifier. */
function identName(e: unknown): string | null {
  return isObj(e) && e.kind === "ident" && typeof e.name === "string"
    ? e.name
    : null;
}

/** Depth-first visit of every plain-object node in the HIR subtree. */
function walkAny(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const c of node) walkAny(c, visit);
    return;
  }
  if (!isObj(node)) return;
  visit(node);
  for (const k in node) walkAny(node[k], visit);
}

/** Collect the bindings front-mutated (`shift`/`unshift`) anywhere in the body. */
function collectDeque(body: HirStmt[]): Set<string> {
  const names = new Set<string>();
  walkAny(body, (n) => {
    if (n.kind === "method" && (n.name === "shift" || n.name === "unshift")) {
      const r = identName(n.receiver);
      if (r) names.add(r);
    }
    if (n.kind === "arrayMutLen" && n.pushMethod === "unshift") {
      const r = identName(n.receiver);
      if (r) names.add(r);
    }
  });
  return names;
}

/** Rewrite every deque-binding site: decl type, construction, and mutating calls. */
function rewriteDeque(body: HirStmt[], names: Set<string>): void {
  walkAny(body, (n) => {
    // The declaration: mark the `vec` type `deque` and seed the `VecDeque` from the
    // (Vec-producing) init via the shared helper.
    if (
      n.kind === "let" &&
      typeof n.name === "string" &&
      names.has(n.name) &&
      isObj(n.ty) &&
      n.ty.kind === "vec"
    ) {
      (n.ty as { deque?: boolean }).deque = true;
      n.init = {
        kind: "call",
        callee: "tslib::array::deque_from_vec",
        args: [{ borrow: "owned", expr: n.init as HirExpr }],
      };
    }
    // A mutating method on a deque receiver → its `VecDeque` equivalent.
    if (
      n.kind === "method" &&
      typeof n.name === "string" &&
      identName(n.receiver) &&
      names.has(identName(n.receiver) as string) &&
      DEQUE_METHOD[n.name]
    ) {
      n.name = DEQUE_METHOD[n.name];
    }
    // A value-position push/unshift block → the deque push method.
    if (
      n.kind === "arrayMutLen" &&
      identName(n.receiver) &&
      names.has(identName(n.receiver) as string)
    ) {
      if (n.pushMethod === "unshift" || n.pushMethod === "push_front") {
        n.pushMethod = "push_front";
      } else if (n.pushMethod === "push") {
        n.pushMethod = "push_back";
      }
    }
    // `splice` on a deque receiver → the `VecDeque` helper.
    if (
      n.kind === "call" &&
      n.callee === "tslib::array::splice" &&
      Array.isArray(n.args) &&
      isObj(n.args[0]) &&
      identName((n.args[0] as { expr?: unknown }).expr) &&
      names.has(identName((n.args[0] as { expr?: unknown }).expr) as string)
    ) {
      n.callee = "tslib::array::deque_splice";
    }
  });
}
