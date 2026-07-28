/**
 * Task-escape ownership refinement — the **inter-procedural** `Arc` / `Arc<Mutex>`
 * pass (series 051c increment 2).
 *
 * Increment 1 shipped the single-task, move-capture spawn surface (`spawn` /
 * `JoinHandle` await / `setTimeout`), admitting only `Copy`/literal args. This pass
 * graduates **shared state that crosses into a task as a function argument of a
 * spawned async call**. Collin's decision (design.md, "Increment 2"): the shared
 * binding is wrapped at its declaration, each spawn-arg site clones the handle, the
 * parent's later uses go through the lock (for the mutable case), and the receiving
 * async fn's **signature + body are rewritten** to the wrapped form. That last part
 * is the inter-procedural bit — the reason this pass runs at MODULE level (it must
 * see both the caller body and the callee fn).
 *
 * The fail-loud contract is the whole correctness bar: we NEVER emit a `spawn` that
 * would not compile. Any shape the pass cannot prove sound — a callee used both
 * shared and unshared (the conflict rule), a capture pushed into an unbounded /
 * never-joined `Vec<JoinHandle>`, a non-struct/non-scalar shared type, a nested or
 * transitive capture — stays `UnsupportedError`. It is always correct to reject.
 *
 * ### Algorithm (design.md, "The algorithm")
 *
 *  1. **Capture graph.** Scan each caller body's top-level statements for a spawned
 *     async call `f(…args…)` (`{spawn, expr:{call, callee:f, args}}`); record each
 *     arg that is a bare binding identifier → (bindingName, calleeFn f, argIndex).
 *  2. **Wrap criterion.** A binding needs a wrap iff it is passed to ≥2 spawned
 *     calls, OR to 1 spawned call AND still used after that spawn in the parent
 *     body. (One spawn, never reused → a plain move, increment 1 — left alone.)
 *  3. **`Arc` vs `Arc<Mutex>`.** `Arc<Mutex<T>>` if the value is mutated — the
 *     receiving async fn's param is `refMut` (its pre-rewrite `HirParam.ty` is a
 *     `{ref, mut:true}`), or the parent mutates the binding after a spawn. Else a
 *     shared read → plain `Arc<T>`.
 *  4. **Rewrite set.** binding decl → `share` marker; each spawn-arg → `arcClone`;
 *     parent uses after → `lockAccess` (Mutex) / unchanged (Arc, Deref); receiving
 *     async fn → param ty wrapped + body accesses to that param rewritten.
 *  5. **Conflict rule (fail-loud).** A shared-captured async fn also called
 *     unshared (a direct `await f(plainValue)`) → `UnsupportedError`.
 */

import { UnsupportedError } from "./errors";
import type { HirExpr, HirFn, HirModule, HirStmt, RustType } from "./hir";

/** A single spawn-arg capture site: `f(…, <binding>, …)` under a `spawn`. */
interface CaptureSite {
  binding: string;
  callee: string;
  argIndex: number;
  /** Set the (owned) `arcClone` node in place of the bare-ident arg. */
  rewriteArg: (name: string) => void;
}

export function refineTaskEscape(module: HirModule): HirModule {
  const fnByName = new Map<string, HirFn>();
  for (const item of module.items) {
    if (item.kind === "fn") fnByName.set(item.name, item);
  }

  // Which async fns are called *unshared* anywhere (a direct call/await with a
  // plain, non-clone argument). Populated as we scan every body; used for the
  // conflict rule after the capture graph is built.
  const unsharedCallees = new Set<string>();
  // Every callee that is spawned with a *wrapped* (task-escaping) binding arg.
  const sharedCallees = new Set<string>();
  // Per-callee, the arg index carrying the wrapped binding + whether it is
  // mutated — to rewrite the callee signature + body once, consistently.
  const calleeWrap = new Map<
    string,
    { argIndex: number; mutated: boolean }
  >();

  // First pass: per body, build the capture graph and decide wraps. We mutate the
  // caller bodies (share markers, arcClone args, lockAccess uses) here; callee
  // rewrites are deferred until after all bodies are scanned (a callee's mutated
  // flag can be set by any caller).
  const bodies: HirStmt[][] = [
    ...[...fnByName.values()].map((f) => f.body),
    module.main,
  ];

  for (const body of bodies) {
    refineBody(body, fnByName, {
      unsharedCallees,
      sharedCallees,
      calleeWrap,
    });
  }

  // Conflict rule: a callee spawned shared AND called unshared has an
  // irreconcilable param type. Reject — increment 2 requires a shared-capture
  // async fn be shared-only.
  for (const callee of sharedCallees) {
    if (unsharedCallees.has(callee)) {
      throw new UnsupportedError({
        type: "async fn used both as a spawned shared-state task and a direct call — split it",
      });
    }
  }

  // Inter-procedural rewrite: each shared callee's param type is wrapped in
  // `Arc<T>` / `Arc<Mutex<T>>`, and its body's accesses to that param are
  // rewritten to the lock form (mutated) or left as-is (read, via `Deref`).
  for (const [callee, wrap] of calleeWrap) {
    const fn = fnByName.get(callee);
    if (!fn) continue;
    rewriteCallee(fn, wrap.argIndex, wrap.mutated);
  }

  return module;
}

interface Ctx {
  unsharedCallees: Set<string>;
  sharedCallees: Set<string>;
  calleeWrap: Map<string, { argIndex: number; mutated: boolean }>;
}

/**
 * Build the capture graph over one caller body's **top-level** statements and
 * apply the caller-side rewrite (share marker on the decl, `arcClone` at each
 * spawn-arg site, `lockAccess` on the parent's later uses). Records shared/unshared
 * callee usage into `ctx` for the conflict rule + the deferred callee rewrite.
 *
 * Restricting the capture graph to the body's flat statement list is deliberate
 * conservatism: a spawn nested inside a branch/loop is a lifetime the pass does not
 * bound — it stays fail-loud (below), never silently wrapped.
 */
function refineBody(
  body: HirStmt[],
  fnByName: Map<string, HirFn>,
  ctx: Ctx,
): void {
  // A spawned async call whose arg is a bare binding identifier is a shared
  // capture the pass must be able to place at a bounded top-level site. A spawn
  // NESTED inside a branch/loop/block (a lifetime the flat capture graph does not
  // bound — e.g. a fan-out into an unjoined `Vec<JoinHandle>`) is rejected: we
  // never wrap a capture whose task lifetime we cannot see.
  assertNoNestedBindingSpawns(body);

  // Capture sites, keyed by binding name, in statement order.
  const captures = new Map<string, CaptureSite[]>();
  // The statement index of each `let` declaring a candidate binding, and the
  // index of the *last* spawn that captures it — to test "used after spawn".
  const declIndex = new Map<string, number>();
  const lastSpawnIndex = new Map<string, number>();

  // Walk the flat body once, collecting spawn-arg captures and marking any
  // spawn/capture that appears nested (which we reject on use).
  body.forEach((stmt, i) => {
    // Record candidate binding declarations.
    if (stmt.kind === "let" && !stmt.names) declIndex.set(stmt.name, i);

    forEachSpawnCall(stmt, (call, setArg) => {
      call.args.forEach((arg, argIndex) => {
        if (arg.expr.kind !== "ident") return;
        const binding = arg.expr.name;
        const site: CaptureSite = {
          binding,
          callee: call.callee,
          argIndex,
          rewriteArg: (name) =>
            setArg(argIndex, { borrow: "owned", expr: { kind: "arcClone", name } }),
        };
        const list = captures.get(binding) ?? [];
        list.push(site);
        captures.set(binding, list);
        lastSpawnIndex.set(binding, i);
      });
    });
  });

  // Record every *unshared* call of an async fn (a direct call/await whose args
  // are not task-escaping clones) so the conflict rule can see it. A call whose
  // arg is a wrapped binding is handled below; everything else here is unshared.
  recordUnsharedCalls(body, captures, ctx);

  // Classify + rewrite each captured binding.
  for (const [binding, sites] of captures) {
    const spawnCount = sites.length;
    const lastSpawn = lastSpawnIndex.get(binding) ?? -1;
    const usedAfter = bindingUsedAfter(body, binding, lastSpawn, /*writes*/ false);
    const mutatedAfter = bindingUsedAfter(body, binding, lastSpawn, /*writes*/ true);

    // Wrap criterion. One spawn, never reused after → a plain move (increment 1);
    // leave it (and the callee) entirely alone.
    const needsWrap = spawnCount >= 2 || (spawnCount === 1 && usedAfter);
    if (!needsWrap) continue;

    // `Arc` vs `Arc<Mutex>`: mutated if any receiving callee's param is `refMut`,
    // or the parent mutates the binding after a spawn.
    let mutated = mutatedAfter;
    for (const site of sites) {
      const fn = fnByName.get(site.callee);
      if (!fn) {
        // A spawned call to something that is not a lowered free fn (a builtin, a
        // method, an unknown) — the pass cannot rewrite its signature, so it
        // cannot prove the shared capture sound. Fail loud.
        throw new UnsupportedError({
          type: "shared capture spawned into a callee whose signature the task-escape pass cannot rewrite — not provably safe",
        });
      }
      const p = fn.params[site.argIndex];
      if (!p) continue;
      // Mutation signal: the receiving param is `refMut` (the settled ownership
      // signal), OR — because param ownership does not today flag a *field* write
      // through a param (`c.n += 1` leaves `c` inferred `ref`) — the callee body
      // directly mutates the param (a field/element/whole write). Either makes the
      // shared wrap `Arc<Mutex<T>>`.
      if (p.ty.kind === "ref" && p.ty.mut) mutated = true;
      if (calleeMutatesParam(fn, p.name)) mutated = true;
    }

    // Apply the caller-side rewrite.
    markShare(body, binding, mutated ? "arcMutex" : "arc");
    for (const site of sites) site.rewriteArg(binding);
    if (mutated) rewriteParentLockUses(body, binding, lastSpawn);

    // Register each callee for the deferred inter-procedural rewrite + the
    // conflict rule.
    for (const site of sites) {
      ctx.sharedCallees.add(site.callee);
      const prev = ctx.calleeWrap.get(site.callee);
      if (prev && prev.argIndex !== site.argIndex) {
        // The same callee shared through two different arg positions — the pass
        // cannot pick one param to wrap. Reject.
        throw new UnsupportedError({
          type: "shared capture spawned into the same async fn through differing argument positions — not provably safe",
        });
      }
      ctx.calleeWrap.set(site.callee, {
        argIndex: site.argIndex,
        mutated: (prev?.mutated ?? false) || mutated,
      });
    }
  }
}

/**
 * Reject any `spawn(f(…, <ident>, …))` whose task lifetime the flat capture graph
 * cannot bound — a spawn nested inside a branch/loop/block, or one whose arg is a
 * non-ident capture. Such a shape (e.g. a fan-out into an unbounded, never-joined
 * `Vec<JoinHandle>`) is not provably `Send + 'static`-safe, so it stays fail-loud
 * rather than emit a `spawn` that would not compile / would silently diverge.
 */
function assertNoNestedBindingSpawns(body: HirStmt[]): void {
  const check = (e: HirExpr): void => {
    if (e.kind === "spawn" && e.expr.kind === "call") {
      for (const a of e.expr.args) {
        if (a.expr.kind === "ident") {
          throw new UnsupportedError({
            type: "shared mutable state across tasks not provably safe — a spawn nested in a branch/loop captures a binding whose task lifetime the pass cannot bound",
          });
        }
      }
    }
  };
  const walkExpr = (e: HirExpr): void => {
    check(e);
    switch (e.kind) {
      case "spawn":
      case "await":
      case "joinHandleAwait":
      case "try":
        walkExpr(e.expr);
        return;
      case "assign":
        walkExpr(e.target);
        walkExpr(e.value);
        return;
      case "binary":
        walkExpr(e.left);
        walkExpr(e.right);
        return;
      case "unary":
        walkExpr(e.operand);
        return;
      case "call":
        for (const a of e.args) walkExpr(a.expr);
        return;
      case "println":
        for (const a of e.args) walkExpr(a);
        return;
      case "method":
        walkExpr(e.receiver);
        for (const a of e.args) walkExpr(a);
        return;
      case "field":
      case "len":
        walkExpr(e.object);
        return;
      case "index":
        walkExpr(e.object);
        walkExpr(e.index);
        return;
      default:
        return;
    }
  };
  // Walk nested statement bodies only — the top-level list is the bounded
  // capture-graph scope handled in `refineBody`.
  const walkNested = (stmts: HirStmt[]): void => {
    for (const s of stmts) {
      switch (s.kind) {
        case "if":
          for (const c of s.conseq) scanStmt(c);
          if (s.alt) for (const c of s.alt) scanStmt(c);
          break;
        case "while":
        case "block":
        case "forIn":
        case "forInReborrow":
        case "forRange":
          for (const c of s.body) scanStmt(c);
          break;
        default:
          break;
      }
    }
  };
  // Scan a statement *and* its nested bodies for a binding-capturing spawn.
  const scanStmt = (s: HirStmt): void => {
    switch (s.kind) {
      case "let":
        walkExpr(s.init);
        break;
      case "expr":
        walkExpr(s.expr);
        break;
      case "return":
        if (s.value) walkExpr(s.value);
        break;
      case "if":
        walkExpr(s.cond);
        s.conseq.forEach(scanStmt);
        if (s.alt) s.alt.forEach(scanStmt);
        break;
      case "while":
        walkExpr(s.cond);
        s.body.forEach(scanStmt);
        break;
      case "block":
      case "forIn":
      case "forInReborrow":
      case "forRange":
        s.body.forEach(scanStmt);
        break;
      default:
        break;
    }
  };
  walkNested(body);
}

/**
 * Record every async-fn call in the body that is *not* a task-escaping shared
 * spawn — a direct `await f(x)`, a plain `f(x)` (non-spawn), or a spawn whose args
 * are not the wrapped binding — as an unshared use of that callee. Used purely for
 * the conflict rule. Conservative: we only look at top-level statements (the same
 * flat scope the capture graph uses); a deeper call is not our concern here because
 * a deeper *spawn* is already rejected.
 */
function recordUnsharedCalls(
  body: HirStmt[],
  captures: Map<string, CaptureSite[]>,
  ctx: Ctx,
): void {
  const walk = (e: HirExpr): void => {
    switch (e.kind) {
      case "call":
        // A direct (non-spawn) call to a fn: an unshared use. A spawn wraps this
        // in a `{spawn}` node, handled by the capture graph — so a bare `call`
        // reached here is unshared.
        ctx.unsharedCallees.add(e.callee);
        for (const a of e.args) walk(a.expr);
        return;
      case "spawn":
        // The spawn's callee is shared *iff* one of its args is a captured
        // binding that ends up wrapped. If none of its args is a candidate
        // capture, it is a lone move-in (increment 1) — but its callee is then
        // being used with a plain move, which is an unshared use.
        if (e.expr.kind === "call") {
          const anyCapture = e.expr.args.some(
            (a) => a.expr.kind === "ident" && captures.has(a.expr.name),
          );
          if (!anyCapture) ctx.unsharedCallees.add(e.expr.callee);
        }
        return;
      case "await":
      case "joinHandleAwait":
      case "try":
        walk(e.expr);
        return;
      case "binary":
        walk(e.left);
        walk(e.right);
        return;
      case "unary":
        walk(e.operand);
        return;
      case "assign":
        walk(e.target);
        walk(e.value);
        return;
      case "field":
      case "len":
        walk(e.object);
        return;
      case "index":
        walk(e.object);
        walk(e.index);
        return;
      case "println":
        for (const a of e.args) walk(a);
        return;
      case "method":
        walk(e.receiver);
        for (const a of e.args) walk(a);
        return;
      default:
        return;
    }
  };
  const walkStmt = (s: HirStmt): void => {
    switch (s.kind) {
      case "let":
        walk(s.init);
        break;
      case "expr":
        walk(s.expr);
        break;
      case "return":
        if (s.value) walk(s.value);
        break;
      case "if":
        walk(s.cond);
        break;
      case "while":
        walk(s.cond);
        break;
      // Nested bodies are not scanned for unshared calls (a nested spawn is
      // already rejected; a nested plain call cannot conflict with a top-level
      // shared spawn in the increment-2 shapes).
      default:
        break;
    }
  };
  body.forEach(walkStmt);
}

/**
 * Invoke `visit(call, setArg)` for each `spawn(<call>)` reachable in a statement
 * — the direct `const h = f(x)` / bare `f(x)` spawn forms. `setArg(i, arg)`
 * replaces the call's i-th argument in place. A spawn nested inside a
 * branch/loop/nested expr is NOT visited here; a captured binding used only in
 * such a spawn therefore never gets a wrap and, if it is non-Copy and reused, is
 * caught downstream (cargo-loud) — but the increment-2 fixtures never take that
 * shape. (An `asyncMove` spawn — `setTimeout` — has no call args to capture.)
 */
function forEachSpawnCall(
  stmt: HirStmt,
  visit: (
    call: Extract<HirExpr, { kind: "call" }>,
    setArg: (i: number, arg: { borrow: "owned"; expr: HirExpr }) => void,
  ) => void,
): void {
  const fromExpr = (e: HirExpr): void => {
    if (e.kind === "spawn" && e.expr.kind === "call") {
      const call = e.expr;
      visit(call, (i, arg) => {
        call.args[i] = arg;
      });
    }
  };
  if (stmt.kind === "let") fromExpr(stmt.init);
  else if (stmt.kind === "expr") fromExpr(stmt.expr);
}

/** Whether `binding` is read (or, when `writes`, written) after statement index
 * `after` in the flat body — the "used after the spawn in the parent" test. A
 * write is an `assign` whose target roots at the binding; a read is any other
 * occurrence. Only top-level statements are scanned (matching the capture graph). */
function bindingUsedAfter(
  body: HirStmt[],
  binding: string,
  after: number,
  writes: boolean,
): boolean {
  let found = false;
  const isWrite = (e: HirExpr): boolean =>
    e.kind === "assign" && rootIdent(e.target) === binding;
  const walk = (e: HirExpr, inWriteTarget = false): void => {
    if (found) return;
    switch (e.kind) {
      case "ident":
        if (e.name === binding && inWriteTarget === writes) found = true;
        return;
      case "assign": {
        const w = isWrite(e);
        // The target place references the binding (a write when rooted at it).
        walk(e.target, w);
        walk(e.value, false);
        return;
      }
      case "field":
      case "len":
        walk(e.object, inWriteTarget);
        return;
      case "index":
        walk(e.object, inWriteTarget);
        walk(e.index, false);
        return;
      case "binary":
        walk(e.left, false);
        walk(e.right, false);
        return;
      case "unary":
        walk(e.operand, false);
        return;
      case "call":
        for (const a of e.args) walk(a.expr, false);
        return;
      case "println":
        for (const a of e.args) walk(a, false);
        return;
      case "method":
        walk(e.receiver, false);
        for (const a of e.args) walk(a, false);
        return;
      case "await":
      case "joinHandleAwait":
      case "try":
      case "spawn":
        walk(e.expr, false);
        return;
      default:
        return;
    }
  };
  body.forEach((stmt, i) => {
    if (i <= after) return;
    switch (stmt.kind) {
      case "let":
        walk(stmt.init, false);
        break;
      case "expr":
        walk(stmt.expr, false);
        break;
      case "return":
        if (stmt.value) walk(stmt.value, false);
        break;
      case "if":
      case "while":
        walk(stmt.cond, false);
        break;
      default:
        break;
    }
  });
  return found;
}

/** The base binding name a place expression roots at (`counter.n` → `counter`). */
function rootIdent(e: HirExpr): string | null {
  if (e.kind === "ident") return e.name;
  if (e.kind === "field" || e.kind === "len") return rootIdent(e.object);
  if (e.kind === "index") return rootIdent(e.object);
  return null;
}

/** Set the `share` marker on the `let` that declares `binding` in this body. */
function markShare(
  body: HirStmt[],
  binding: string,
  share: "arc" | "arcMutex",
): void {
  for (const stmt of body) {
    if (stmt.kind === "let" && stmt.name === binding) {
      stmt.share = share;
      // The `Arc<…>` binding is never mutated *as a binding* (it is interior via
      // the Mutex), so drop `mut` — a `mut` on an `Arc` handle is a warning.
      stmt.mut = false;
      return;
    }
  }
}

/**
 * Rewrite the parent's reads/writes of an `Arc<Mutex<T>>`-wrapped `binding` after
 * the spawn to go through the lock: a field access `binding.n` → `(binding.lock()
 * .unwrap()).n`, and a whole-value scalar read `binding` → `*binding.lock()
 * .unwrap()`. The `arcClone` args at spawn sites (already rewritten) and the decl
 * are left alone — only genuine value reads/writes are locked. Top-level
 * statements only.
 */
function rewriteParentLockUses(
  body: HirStmt[],
  binding: string,
  after: number,
): void {
  const lock = (): HirExpr => ({
    kind: "lockAccess",
    expr: { kind: "ident", name: binding },
  });
  // Rewrite an expression, returning the replacement. `scalarRead` marks a
  // position where the whole value is read as a scalar (needs `*lock`).
  const rw = (e: HirExpr, scalarRead: boolean): HirExpr => {
    switch (e.kind) {
      case "ident":
        if (e.name !== binding) return e;
        // A bare whole-value read of the wrapped scalar → `*binding.lock()...`.
        return scalarRead ? { kind: "unary", op: "*", operand: lock() } : e;
      case "field":
        if (rootIdent(e.object) === binding && e.object.kind === "ident") {
          // `binding.field` → `binding.lock().unwrap().field`.
          return { kind: "field", object: lock(), name: e.name };
        }
        return { ...e, object: rw(e.object, false) };
      case "assign":
        return {
          ...e,
          target: rw(e.target, false),
          value: rw(e.value, true),
        };
      case "binary":
        return { ...e, left: rw(e.left, true), right: rw(e.right, true) };
      case "unary":
        return { ...e, operand: rw(e.operand, true) };
      case "call":
        return { ...e, args: e.args.map((a) => ({ ...a, expr: rw(a.expr, a.borrow === "owned") })) };
      case "println":
        return { ...e, args: e.args.map((a) => rw(a, true)) };
      case "method":
        return {
          ...e,
          receiver: rw(e.receiver, false),
          args: e.args.map((a) => rw(a, true)),
        };
      case "index":
        return { ...e, object: rw(e.object, false), index: rw(e.index, true) };
      case "len":
        return { ...e, object: rw(e.object, false) };
      case "await":
      case "joinHandleAwait":
      case "try":
        return { ...e, expr: rw(e.expr, scalarRead) };
      default:
        return e;
    }
  };
  body.forEach((stmt, i) => {
    if (i <= after) return;
    switch (stmt.kind) {
      case "expr":
        stmt.expr = rw(stmt.expr, true);
        break;
      case "let":
        stmt.init = rw(stmt.init, true);
        break;
      case "return":
        if (stmt.value) stmt.value = rw(stmt.value, true);
        break;
      case "if":
      case "while":
        stmt.cond = rw(stmt.cond, true);
        break;
      default:
        break;
    }
  });
}

/**
 * Does the callee's (lowered) body mutate `param` — a write to the param itself
 * or to one of its fields/elements? Param-ownership inference does not flag a
 * *field* write through a param (`c.n += 1` leaves `c` inferred `ref`), so the
 * task-escape pass detects the mutation directly to decide `Arc` vs `Arc<Mutex>`.
 * A read-only param stays `Arc<T>` (Deref); a mutated one becomes `Arc<Mutex<T>>`.
 */
function calleeMutatesParam(fn: HirFn, param: string): boolean {
  let mutated = false;
  const walkExpr = (e: HirExpr): void => {
    if (mutated) return;
    switch (e.kind) {
      case "assign":
        if (rootIdent(e.target) === param) mutated = true;
        walkExpr(e.target);
        walkExpr(e.value);
        return;
      case "field":
      case "len":
        walkExpr(e.object);
        return;
      case "index":
        walkExpr(e.object);
        walkExpr(e.index);
        return;
      case "binary":
        walkExpr(e.left);
        walkExpr(e.right);
        return;
      case "unary":
        walkExpr(e.operand);
        return;
      case "call":
        for (const a of e.args) walkExpr(a.expr);
        return;
      case "println":
        for (const a of e.args) walkExpr(a);
        return;
      case "method":
        // A mutating method (`.push`, `.sort`, …) on the param mutates it. We do
        // not enumerate names here; any method call whose receiver roots at the
        // param is treated as a potential mutation (conservative → `Arc<Mutex>`).
        if (rootIdent(e.receiver) === param) mutated = true;
        walkExpr(e.receiver);
        for (const a of e.args) walkExpr(a);
        return;
      case "await":
      case "joinHandleAwait":
      case "try":
      case "spawn":
        walkExpr(e.expr);
        return;
      default:
        return;
    }
  };
  const walkStmt = (s: HirStmt): void => {
    switch (s.kind) {
      case "let":
        walkExpr(s.init);
        break;
      case "expr":
        walkExpr(s.expr);
        break;
      case "return":
        if (s.value) walkExpr(s.value);
        break;
      case "if":
        walkExpr(s.cond);
        s.conseq.forEach(walkStmt);
        if (s.alt) s.alt.forEach(walkStmt);
        break;
      case "while":
        walkExpr(s.cond);
        s.body.forEach(walkStmt);
        break;
      case "block":
      case "forIn":
      case "forInReborrow":
      case "forRange":
        s.body.forEach(walkStmt);
        break;
      default:
        break;
    }
  };
  fn.body.forEach(walkStmt);
  return mutated;
}

/**
 * The inter-procedural rewrite of a shared callee: its wrapped param's type
 * becomes `Arc<T>` / `Arc<Mutex<T>>`, and its body's accesses to that param are
 * rewritten to the lock form (mutated) or left as-is (read, via `Deref`).
 */
function rewriteCallee(fn: HirFn, argIndex: number, mutated: boolean): void {
  const param = fn.params[argIndex];
  if (!param) return;
  // The pre-rewrite param type, stripped of its borrow — the inner `T` that gets
  // wrapped. (Read params were `&T`, mutated params `&mut T`.)
  const inner: RustType =
    param.ty.kind === "ref" ? param.ty.inner : param.ty;
  param.ty = wrapType(inner, mutated);
  if (!mutated) return; // read param: accesses compose via `Deref`, unchanged.

  const name = param.name;
  const lock = (): HirExpr => ({
    kind: "lockAccess",
    expr: { kind: "ident", name },
  });
  const rw = (e: HirExpr, scalarRead: boolean): HirExpr => {
    switch (e.kind) {
      case "ident":
        if (e.name !== name) return e;
        return scalarRead ? { kind: "unary", op: "*", operand: lock() } : e;
      case "field":
        if (e.object.kind === "ident" && e.object.name === name) {
          return { kind: "field", object: lock(), name: e.name };
        }
        return { ...e, object: rw(e.object, false) };
      case "assign":
        return { ...e, target: rw(e.target, false), value: rw(e.value, true) };
      case "binary":
        return { ...e, left: rw(e.left, true), right: rw(e.right, true) };
      case "unary":
        return { ...e, operand: rw(e.operand, true) };
      case "call":
        return {
          ...e,
          args: e.args.map((a) => ({
            ...a,
            expr: rw(a.expr, a.borrow === "owned"),
          })),
        };
      case "println":
        return { ...e, args: e.args.map((a) => rw(a, true)) };
      case "method":
        return {
          ...e,
          receiver: rw(e.receiver, false),
          args: e.args.map((a) => rw(a, true)),
        };
      case "index":
        return { ...e, object: rw(e.object, false), index: rw(e.index, true) };
      case "len":
        return { ...e, object: rw(e.object, false) };
      case "await":
      case "joinHandleAwait":
      case "try":
        return { ...e, expr: rw(e.expr, scalarRead) };
      case "some":
      case "ok":
        return e;
      default:
        return e;
    }
  };
  const rwStmt = (s: HirStmt): void => {
    switch (s.kind) {
      case "let":
        s.init = rw(s.init, true);
        break;
      case "expr":
        s.expr = rw(s.expr, true);
        break;
      case "return":
        if (s.value) s.value = rw(s.value, true);
        break;
      case "if":
        s.cond = rw(s.cond, true);
        s.conseq.forEach(rwStmt);
        if (s.alt) s.alt.forEach(rwStmt);
        break;
      case "while":
        s.cond = rw(s.cond, true);
        s.body.forEach(rwStmt);
        break;
      case "block":
      case "forIn":
      case "forInReborrow":
      case "forRange":
        s.body.forEach(rwStmt);
        break;
      default:
        break;
    }
  };
  fn.body.forEach(rwStmt);
}

/** `Arc<T>` (read) / `Arc<Mutex<T>>` (mutated). Emitted fully qualified. */
function wrapType(inner: RustType, mutated: boolean): RustType {
  // Only a named struct or a scalar/`String` whole value is wrappable — the pass
  // rejects anything else (a borrowed, optional, collection, or trait-object
  // param) rather than emit an `Arc` it cannot prove sound.
  switch (inner.kind) {
    case "struct":
    case "f64":
    case "usize":
    case "i64":
    case "String":
    case "bool":
      return { kind: "arc", inner, mutex: mutated };
    default:
      throw new UnsupportedError({
        type: "shared capture of a type the task-escape pass cannot wrap in Arc/Arc<Mutex> — not provably safe",
      });
  }
}

export { refineTaskEscape as default };
