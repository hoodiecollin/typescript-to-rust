/**
 * Front-mutated arrays → `VecDeque` (series 116/117, issues #78/#101). An array binding
 * ever `shift`/`unshift`-ed lowers to a `VecDeque<T>` for O(1) front operations
 * (`pop_front`/`push_front`) instead of O(n) `Vec::remove(0)`/`insert(0, …)`.
 *
 * A standalone, pure HIR → HIR pass mirroring `refineSplitLazy`/`refineStrings`.
 * Series 117 lifts it from per-body to **whole-module two-phase**:
 *
 *   1. **Classify** (`classify`) — a call-graph fixpoint (the same shape as ownership's
 *      `refMut` propagation) computing, per binding/param/return, whether it is a deque.
 *      Seeds: any binding (a `let` or a param) front-mutated (`shift`/`unshift`). Edges,
 *      to a fixpoint: `arg→param` (a deque passed to `f(a)` promotes `f`'s param),
 *      `param→arg` backward (a deque param promotes every caller's bare-ident arg —
 *      the `drain(q)` case), `return` (a fn returning a deque types its ret `VecDeque`),
 *      and alias (`let b = a`).
 *   2. **Rewrite** (`rewriteBody` + `applyParamRetTypes`) — flips each classified `let`
 *      type (`vec` → `vec{deque}`) + construction (`tslib::array::deque_from_vec`, unless
 *      the init is already a deque value — no double wrap), param/return types, and every
 *      mutating call (`push`→`push_back`, `pop`→`pop_back`, `shift`→`pop_front`,
 *      `unshift`→`push_front`, `splice`→`deque_splice`). A multi-arg `push_front` reverses
 *      its args so `unshift(x, y)` lands `[x, y, …]` (JS order).
 *
 * `VecDeque` supports index / `len` / iteration natively; a **`Vec`-only op** on a deque
 * binding (`sort`/`join`/`concat`/`flat`) routes through the shared interop helpers
 * (`tslib::array::deque_as_slice_mut` for in-place sort via `make_contiguous`,
 * `deque_to_vec` for a `&[T]` boundary) rather than fail-loud. A `VecDeque` import is
 * emitted wherever a `deque` type is present.
 *
 * Free functions propagate fully (callee is a bare name); class methods are name-keyed
 * (the documented same-name limitation ownership's `methodParams` also carries) — a
 * genuinely unresolvable cross-class case stays cargo-loud, never silently wrong.
 */

import type { HirExpr, HirFn, HirModule, HirStmt } from "./hir";

/** JS mutation-method name → the `VecDeque` method it lowers to. */
const DEQUE_METHOD: Record<string, string> = {
  push: "push_back",
  pop: "pop_back",
  shift: "pop_front",
  unshift: "push_front",
};

/** A body under analysis: its statements plus (for a free fn / method) its signature. */
interface Body {
  /** The propagation key: a free-fn or method name; `null` for a ctor / `main`. */
  fnName: string | null;
  /** The `HirFn` whose params/ret get flipped; `null` for `main`. */
  fn: HirFn | null;
  stmts: HirStmt[];
}

/** The deque classification: which params / returns / local bindings are deques. */
interface Classification {
  /** fn/method name → the param indices that are deques. */
  paramDeque: Map<string, Set<number>>;
  /** fn/method names whose return value is a deque. */
  retDeque: Set<string>;
  /** body → the local binding names that are deques (keyed by the stmts array identity). */
  localDeque: Map<HirStmt[], Set<string>>;
}

export function refineDeque(module: HirModule): HirModule {
  const bodies = moduleBodies(module);
  const cls = classify(bodies);
  for (const b of bodies) {
    const local = cls.localDeque.get(b.stmts);
    if (local && local.size > 0) rewriteBody(b.stmts, local, cls);
  }
  applyParamRetTypes(module, cls);
  return module;
}

function moduleBodies(module: HirModule): Body[] {
  const bodies: Body[] = [];
  for (const item of module.items) {
    if (item.kind === "fn") bodies.push({ fnName: item.name, fn: item, stmts: item.body });
    else if (item.kind === "class") {
      // A ctor is `new C(…)` — name-keyed differently, so it does not participate in
      // free-fn/method propagation (local rewrites only).
      if (item.ctor) bodies.push({ fnName: null, fn: item.ctor, stmts: item.ctor.body });
      for (const m of item.methods) bodies.push({ fnName: m.name, fn: m, stmts: m.body });
    }
  }
  bodies.push({ fnName: null, fn: null, stmts: module.main });
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

/** Bindings front-mutated (`shift`/`unshift`) anywhere in the body. */
function collectFrontMutated(body: HirStmt[]): Set<string> {
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

/** A value is a deque if it is a deque-local ident, a call to a deque-returning fn, or
 *  already `deque_from_vec(…)`. */
function exprIsDeque(
  e: unknown,
  local: Set<string>,
  retDeque: Set<string>,
): boolean {
  if (!isObj(e)) return false;
  const nm = identName(e);
  if (nm && local.has(nm)) return true;
  if (e.kind === "call" && typeof e.callee === "string") {
    if (e.callee === "tslib::array::deque_from_vec") return true;
    if (retDeque.has(e.callee)) return true;
  }
  return false;
}

/** Phase 1 — the whole-module deque classification fixpoint. */
function classify(bodies: Body[]): Classification {
  const paramDeque = new Map<string, Set<number>>();
  const retDeque = new Set<string>();
  const localDeque = new Map<HirStmt[], Set<string>>();
  for (const b of bodies) localDeque.set(b.stmts, new Set());

  let changed = true;
  const addLocal = (stmts: HirStmt[], name: string | null): void => {
    if (!name) return;
    const s = localDeque.get(stmts);
    if (s && !s.has(name)) {
      s.add(name);
      changed = true;
    }
  };
  const addParam = (fn: string, i: number): void => {
    let s = paramDeque.get(fn);
    if (!s) {
      s = new Set();
      paramDeque.set(fn, s);
    }
    if (!s.has(i)) {
      s.add(i);
      changed = true;
    }
  };
  const addRet = (fn: string | null): void => {
    if (fn != null && !retDeque.has(fn)) {
      retDeque.add(fn);
      changed = true;
    }
  };

  while (changed) {
    changed = false;
    for (const b of bodies) {
      const local = localDeque.get(b.stmts) as Set<string>;
      // Seed: front-mutated bindings, and front-mutated params.
      for (const n of collectFrontMutated(b.stmts)) addLocal(b.stmts, n);
      if (b.fnName != null && b.fn) {
        const pd = paramDeque.get(b.fnName);
        b.fn.params.forEach((p, i) => {
          // A front-mutated param → a deque param.
          if (local.has(p.name)) addParam(b.fnName as string, i);
          // A deque param is a deque local of its own body, so intra-body edges
          // (forwarding it onward, aliasing, returning it) see it as a deque.
          if (pd?.has(i)) addLocal(b.stmts, p.name);
        });
      }
      // Edges.
      walkAny(b.stmts, (n) => {
        // alias / return-binding: `let x = <deque value>` → x is a deque.
        if (
          n.kind === "let" &&
          typeof n.name === "string" &&
          exprIsDeque(n.init, local, retDeque)
        ) {
          addLocal(b.stmts, n.name);
        }
        // `return <deque value>` → this fn returns a deque.
        if (n.kind === "return" && exprIsDeque(n.value, local, retDeque)) {
          addRet(b.fnName);
        }
        // A call to a **user** free function (callee is a bare name — skip `tslib::…`
        // intrinsics, which we never rewrite the signature of).
        if (
          n.kind === "call" &&
          typeof n.callee === "string" &&
          !n.callee.includes("::") &&
          Array.isArray(n.args)
        ) {
          const callee = n.callee;
          n.args.forEach((arg, i) => {
            const e = isObj(arg) ? (arg as { expr?: unknown }).expr : undefined;
            // forward arg→param
            if (exprIsDeque(e, local, retDeque)) addParam(callee, i);
            // backward param→arg (a deque param promotes the caller's bare-ident arg)
            if (paramDeque.get(callee)?.has(i)) addLocal(b.stmts, identName(e));
          });
        }
      });
    }
  }
  return { paramDeque, retDeque, localDeque };
}

/** Is `receiver` a bare ident bound to a deque in this body? */
function isDequeRecv(receiver: unknown, local: Set<string>): boolean {
  const nm = identName(receiver);
  return nm != null && local.has(nm);
}

/** Phase 2a — rewrite one body's deque binding sites, mutating calls, and interop ops. */
function rewriteBody(
  body: HirStmt[],
  local: Set<string>,
  cls: Classification,
): void {
  walkAny(body, (n) => {
    // The declaration: mark the `vec` type `deque` and seed the `VecDeque` from the
    // (Vec-producing) init — unless the init is already a deque value (an alias, or a
    // call to a deque-returning fn), which must not be double-wrapped.
    if (
      n.kind === "let" &&
      typeof n.name === "string" &&
      local.has(n.name) &&
      isObj(n.ty) &&
      n.ty.kind === "vec"
    ) {
      (n.ty as { deque?: boolean }).deque = true;
      if (!exprIsDeque(n.init, local, cls.retDeque)) {
        n.init = {
          kind: "call",
          callee: "tslib::array::deque_from_vec",
          args: [{ borrow: "owned", expr: n.init as HirExpr }],
        };
      }
    }
    // A mutating method on a deque receiver → its `VecDeque` equivalent.
    if (
      n.kind === "method" &&
      typeof n.name === "string" &&
      isDequeRecv(n.receiver, local) &&
      DEQUE_METHOD[n.name]
    ) {
      n.name = DEQUE_METHOD[n.name];
    }
    // A value-position push/unshift block → the deque push method. A multi-arg
    // `push_front` (`unshift(x, y)`) reverses its args so the front ends `[x, y, …]`.
    if (n.kind === "arrayMutLen" && isDequeRecv(n.receiver, local)) {
      if (n.pushMethod === "unshift" || n.pushMethod === "push_front") {
        n.pushMethod = "push_front";
        if (Array.isArray(n.args)) n.args = [...n.args].reverse();
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
      isDequeRecv((n.args[0] as { expr?: unknown }).expr, local)
    ) {
      n.callee = "tslib::array::deque_splice";
    }
    // Interop — an in-place `sort` on a deque goes through `deque_as_slice_mut`.
    if (
      (n.kind === "iterSortDefault" || n.kind === "iterSortBy") &&
      isDequeRecv(n.receiver, local)
    ) {
      (n as { deque?: boolean }).deque = true;
    }
    // Interop — `join`/`concat`/`flat` need a contiguous `&[T]`; wrap any deque arg in
    // `deque_to_vec(&d)` (a `&Vec<T>` that coerces), leaving the outer `borrow` intact.
    if (
      n.kind === "call" &&
      (n.callee === "tslib::array::join" ||
        n.callee === "tslib::array::concat" ||
        n.callee === "tslib::array::flat") &&
      Array.isArray(n.args)
    ) {
      for (const arg of n.args) {
        if (isObj(arg) && isDequeRecv((arg as { expr?: unknown }).expr, local)) {
          const inner = (arg as { expr: HirExpr }).expr;
          (arg as { expr: HirExpr }).expr = {
            kind: "call",
            callee: "tslib::array::deque_to_vec",
            args: [{ borrow: "ref", expr: inner }],
          };
        }
      }
    }
  });
}

/** The `vec` type reachable through any `ref` wrappers (a `&mut Vec<T>` param carries its
 *  `vec` behind a `ref`), or `null` if the type is not vec-shaped. */
function dequeableVec(ty: unknown): { deque?: boolean } | null {
  let t = ty;
  while (isObj(t) && t.kind === "ref") t = (t as { inner?: unknown }).inner;
  return isObj(t) && t.kind === "vec" ? (t as { deque?: boolean }) : null;
}

/** Phase 2b — flip the deque params' and returns' declared `vec` types to `VecDeque`,
 *  descending through the `&`/`&mut` a borrowed param wraps its element container in. */
function applyParamRetTypes(module: HirModule, cls: Classification): void {
  const applyFn = (fn: HirFn): void => {
    const pd = cls.paramDeque.get(fn.name);
    if (pd) {
      fn.params.forEach((p, i) => {
        if (pd.has(i)) {
          const v = dequeableVec(p.ty);
          if (v) v.deque = true;
        }
      });
    }
    if (cls.retDeque.has(fn.name)) {
      const v = dequeableVec(fn.ret);
      if (v) v.deque = true;
    }
  };
  for (const item of module.items) {
    if (item.kind === "fn") applyFn(item);
    else if (item.kind === "class") for (const m of item.methods) applyFn(m);
  }
}
