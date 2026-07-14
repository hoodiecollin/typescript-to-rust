/**
 * Ownership refinement — inter-procedural moves via **CFG + backward liveness**
 * (series 037a; supersedes the straight-line 034 heuristic).
 *
 * Option A emits plain moves. A non-Copy value that is *moved* (bound to another
 * `let`, or passed as an owned call/ctor argument) and then **used again** is a
 * Rust `E0382` (use of moved value). This pass inserts a `.clone()` at exactly the
 * move sites whose moved-from binding is still **live** after the move — where
 * "live" is computed by real liveness over the body's control-flow graph, so a
 * loop back-edge (a use reached next iteration) and a branch join (a use on some
 * path after the merge) are both accounted for. The last dynamic use on every path
 * is left a bare move — no needless clone.
 *
 * The engine is syntax-directed: the HIR is structured (the only non-lexical edges
 * are `break`/`continue`, both lexically scoped to the nearest loop), so the CFG's
 * edges are encoded directly in the per-statement transfer functions rather than a
 * materialised basic-block graph. Loops are solved to a fixpoint (monotone, finite
 * lattice bounded by the movable set → terminates). Liveness is a *may*-analysis
 * (union at joins), so it over-approximates live-ness — it errs toward *more*
 * clones, never fewer. Worst case is therefore a needless clone (slower, still
 * correct) or, for a shape it still can't prove, a bare move that cargo rejects
 * **loudly** — never a wrong value. This preserves the project's #1 fail-loud
 * contract.
 *
 * Coverage (epic #1): moves of a bare **name** into a `let`, an owned call/method
 * argument, a struct/array/hashmap literal element, or an assignment value
 * (move-through-store); and non-Copy **projection** reads (`obj.field`, `arr[i]`)
 * that move out of a place they can't be moved from — an index, a borrowed param,
 * or a reused owned base (move-out-of-place / partial moves, 038). Structs join the
 * movable set once they carry a `Clone` derive (037b). `Clone`-able types only
 * (`String`, `Vec`/`HashMap` of cloneable elements, cloneable structs); a
 * non-cloneable move stays bare → cargo-loud.
 */

import {
  type StructTable,
  buildStructTable,
  isStructCloneable,
  isTypeCloneable,
} from "./derives";
import type {
  HirExpr,
  HirFn,
  HirModule,
  HirParam,
  HirStmt,
  RustType,
} from "./hir";

export function refineOwnership(module: HirModule): HirModule {
  // The struct table lets a struct-typed binding join the movable set exactly when
  // it carries a `Clone` derive (037b) — kept in lockstep with the emitter via the
  // shared `derives.ts` cloneability test.
  const structs = buildStructTable(module.items);
  for (const item of module.items) {
    if (item.kind === "fn") {
      refineBody(item.params, item.body, structs);
    } else if (item.kind === "class") {
      if (item.ctor) refineBody(item.ctor.params, item.ctor.body, structs);
      for (const method of item.methods) {
        refineBody(selfParams(method, item.name), method.body, structs);
      }
    } else if (item.kind === "trait") {
      // Class inheritance (series 053): trait *default* bodies are ordinary
      // method bodies over `&self`. `self`'s concrete type isn't known here (it
      // varies per impl), so the receiver is left out of the env — a field read
      // returned by value from a trait default is cloned via the `self` receiver
      // typed as a borrow of an opaque struct (below, in `selfParams`).
      for (const method of item.methods) {
        refineBody(selfParams(method, item.name), method.body, structs);
      }
    }
  }
  refineBody([], module.main, structs);
  return module;
}

/**
 * A `Clone`-able non-Copy type: cloning is both needed (non-Copy) and legal.
 * `String`, `Vec`/`HashMap` of cloneable elements, and a `struct` whose fields are
 * all cloneable (037b). Copy scalars need no clone; refs can't move.
 */
function isCloneableMovable(
  ty: RustType | null,
  structs: StructTable,
): boolean {
  if (!ty) return false;
  switch (ty.kind) {
    case "String":
      return true;
    case "vec":
      return isTypeCloneable(ty.elem, structs);
    case "hashmap":
      return (
        isTypeCloneable(ty.key, structs) && isTypeCloneable(ty.value, structs)
      );
    case "set":
      return isTypeCloneable(ty.elem, structs);
    case "orderedFloat":
      return true;
    case "struct":
      return isStructCloneable(ty.name, structs);
    default:
      return false;
  }
}

/**
 * A method's params with a synthetic leading `self` receiver (series 053/038),
 * typed as a shared borrow of the class struct so a `return self.field` of a
 * non-Copy field clones (move-out-of-borrow). `ownerName` is the class name for
 * an inherent/impl method, or a trait name (`IAnimal`) for a trait default — for
 * a trait the receiver struct is the base class (strip the leading `I`), whose
 * fields drive the projection-clone decision.
 */
function selfParams(method: HirFn, ownerName: string): HirParam[] {
  if (!method.recv) return method.params;
  const structName = ownerName.startsWith("I")
    ? ownerName.slice(1)
    : ownerName;
  const self: HirParam = {
    name: "self",
    ty: {
      kind: "ref",
      mut: method.recv === "refMut",
      inner: { kind: "struct", name: structName },
    },
  };
  return [self, ...method.params];
}

/** Wrap an expression in a `.clone()` method call. */
function cloneOf(e: HirExpr): HirExpr {
  return { kind: "method", receiver: e, name: "clone", args: [] };
}

// ── Set helpers ──────────────────────────────────────────────────────────────

type Live = Set<string>;

function union(...sets: Live[]): Live {
  const out: Live = new Set();
  for (const s of sets) for (const n of s) out.add(n);
  return out;
}

function setEq(a: Live, b: Live): boolean {
  if (a.size !== b.size) return false;
  for (const n of a) if (!b.has(n)) return false;
  return true;
}

// ── Body driver ──────────────────────────────────────────────────────────────

function refineBody(
  params: HirParam[],
  body: HirStmt[],
  structs: StructTable,
): void {
  const movable: Live = new Set();
  for (const p of params) {
    if (isCloneableMovable(p.ty, structs)) movable.add(p.name);
  }
  collectLetBindings(body, movable, structs);

  // liveOut per statement — the CFG liveness solution.
  const liveOut = new Map<HirStmt, Live>();
  liveInOfSeq(
    body,
    new Set(),
    { brk: new Set(), cont: new Set() },
    movable,
    liveOut,
  );

  // Type environment + which params sit behind a reference — needed for the
  // move-out-of-place (projection) clone decisions (038). A projection clone can
  // be required even when no *name* is movable (e.g. returning a field of a
  // borrowed struct param), so we do not early-return on an empty movable set.
  const env = buildEnv(params, body);
  const refParams = new Set(
    params.filter((p) => p.ty.kind === "ref").map((p) => p.name),
  );
  placeSeq(body, { movable, map: liveOut, structs, env, refParams });
}

/** Per-body placement context: the movable set, liveness, types, and ref-params. */
interface PlaceCtx {
  movable: Live;
  map: Map<HirStmt, Live>;
  structs: StructTable;
  env: Map<string, RustType>;
  refParams: Set<string>;
}

/** Declared value types of every param and `let` binding in the body. */
function buildEnv(params: HirParam[], body: HirStmt[]): Map<string, RustType> {
  const env = new Map<string, RustType>();
  for (const p of params) env.set(p.name, p.ty);
  collectLetTypes(body, env);
  return env;
}

function collectLetTypes(body: HirStmt[], env: Map<string, RustType>): void {
  for (const s of body) {
    switch (s.kind) {
      case "let":
        if (s.ty) env.set(s.name, s.ty);
        break;
      case "if":
        collectLetTypes(s.conseq, env);
        if (s.alt) collectLetTypes(s.alt, env);
        break;
      case "while":
      case "block":
      case "forIn":
      case "forRange":
        collectLetTypes(s.body, env);
        break;
      case "match":
        for (const arm of s.arms) collectLetTypes(arm.body, env);
        break;
      case "tryCatch":
        collectLetTypes(s.tryBody, env);
        collectLetTypes(s.catchBody, env);
        if (s.finallyBody) collectLetTypes(s.finallyBody, env);
        break;
      case "tryBlock":
      case "carrierTry":
        collectLetTypes(s.tryBody, env);
        if (s.catchBody) collectLetTypes(s.catchBody, env);
        if (s.finallyBody) collectLetTypes(s.finallyBody, env);
        break;
    }
  }
}

// ── Backward liveness ────────────────────────────────────────────────────────

/** Loop-jump targets: the live-sets a `break` / `continue` transfers to. */
interface JumpCtx {
  brk: Live;
  cont: Live;
}

/**
 * Process a statement list backward, returning its `liveIn`. Records `liveOut`
 * (the live-set flowing *out* of each statement toward its successor) into `map`
 * for every statement, including nested ones.
 */
function liveInOfSeq(
  stmts: HirStmt[],
  liveAfter: Live,
  ctx: JumpCtx,
  movable: Live,
  map: Map<HirStmt, Live>,
): Live {
  let live = liveAfter;
  for (let i = stmts.length - 1; i >= 0; i--) {
    const s = stmts[i];
    if (s) live = transfer(s, live, ctx, movable, map);
  }
  return live;
}

function transfer(
  s: HirStmt,
  liveAfter: Live,
  ctx: JumpCtx,
  movable: Live,
  map: Map<HirStmt, Live>,
): Live {
  switch (s.kind) {
    case "let": {
      map.set(s, liveAfter);
      const out = new Set(liveAfter);
      if (movable.has(s.name)) out.delete(s.name); // the binding (re)defines its name
      return union(exprUses(s.init, movable), out);
    }
    case "expr": {
      map.set(s, liveAfter);
      if (s.expr.kind === "assign")
        return assignTransfer(s.expr, liveAfter, movable);
      return union(exprUses(s.expr, movable), liveAfter);
    }
    case "return": {
      map.set(s, new Set()); // a return jumps to the body exit — nothing lives after
      return s.value ? exprUses(s.value, movable) : new Set();
    }
    case "throw": {
      map.set(s, new Set());
      return exprUses(s.value, movable);
    }
    case "break": {
      map.set(s, new Set(ctx.brk));
      return new Set(ctx.brk);
    }
    case "continue": {
      map.set(s, new Set(ctx.cont));
      return new Set(ctx.cont);
    }
    case "block": {
      map.set(s, liveAfter);
      return liveInOfSeq(s.body, liveAfter, ctx, movable, map);
    }
    case "if": {
      map.set(s, liveAfter);
      const cIn = liveInOfSeq(s.conseq, liveAfter, ctx, movable, map);
      const aIn = s.alt
        ? liveInOfSeq(s.alt, liveAfter, ctx, movable, map)
        : liveAfter;
      return union(exprUses(s.cond, movable), cIn, aIn);
    }
    case "ifLet": {
      map.set(s, liveAfter);
      // The `binding` shadows the inner `T` inside `someBody` — a fresh name, so
      // drop it before its liveness escapes the arm.
      const someIn = new Set(
        liveInOfSeq(s.someBody, liveAfter, ctx, movable, map),
      );
      someIn.delete(s.binding);
      const noneIn = s.noneBody
        ? liveInOfSeq(s.noneBody, liveAfter, ctx, movable, map)
        : liveAfter;
      return union(exprUses(s.scrutinee, movable), someIn, noneIn);
    }
    case "while":
      return loopTransfer(
        exprUses(s.cond, movable),
        s.body,
        liveAfter,
        ctx,
        movable,
        map,
        s,
      );
    case "forRange":
      return loopTransfer(
        union(exprUses(s.start, movable), exprUses(s.end, movable)),
        s.body,
        liveAfter,
        ctx,
        movable,
        map,
        s,
      );
    case "forIn":
      return loopTransfer(
        exprUses(s.iter, movable),
        s.body,
        liveAfter,
        ctx,
        movable,
        map,
        s,
      );
    case "match": {
      map.set(s, liveAfter);
      const armIns: Live[] = s.arms.map((arm) => {
        let al = liveInOfSeq(arm.body, liveAfter, ctx, movable, map);
        if (arm.guard) al = union(al, exprUses(arm.guard, movable));
        return al;
      });
      return union(exprUses(s.disc, movable), ...armIns);
    }
    case "tryCatch": {
      map.set(s, liveAfter);
      const finLive = s.finallyBody
        ? liveInOfSeq(s.finallyBody, liveAfter, ctx, movable, map)
        : liveAfter;
      const catchIn = liveInOfSeq(s.catchBody, finLive, ctx, movable, map);
      // The try body can reach either the catch (on error) or the finally/after
      // (on success) — both are possible successors.
      return liveInOfSeq(s.tryBody, union(finLive, catchIn), ctx, movable, map);
    }
    case "tryBlock": {
      // A labeled-block try (063): same conservative liveness shape as `tryCatch`
      // — the try body can reach the catch/finally or fall through.
      map.set(s, liveAfter);
      const finLive = s.finallyBody
        ? liveInOfSeq(s.finallyBody, liveAfter, ctx, movable, map)
        : liveAfter;
      const catchIn = s.catchBody
        ? liveInOfSeq(s.catchBody, finLive, ctx, movable, map)
        : finLive;
      return liveInOfSeq(s.tryBody, union(finLive, catchIn), ctx, movable, map);
    }
    case "breakTry": {
      map.set(s, liveAfter);
      return union(exprUses(s.value, movable), liveAfter);
    }
    case "carrierTry": {
      // A 073 carrier try (finally+escape): same conservative shape as `tryBlock`
      // — the try body can reach the catch, the finally, or an escaping jump.
      map.set(s, liveAfter);
      const finLive = liveInOfSeq(s.finallyBody, liveAfter, ctx, movable, map);
      const catchIn = s.catchBody
        ? liveInOfSeq(s.catchBody, finLive, ctx, movable, map)
        : finLive;
      return liveInOfSeq(s.tryBody, union(finLive, catchIn), ctx, movable, map);
    }
    case "carrierBreak": {
      // A recorded carrier escape jumps to the wrapper block — nothing after it
      // in the arm lives; the return payload's uses flow in.
      map.set(s, new Set());
      return s.value ? exprUses(s.value, movable) : new Set();
    }
    case "carrierErr": {
      map.set(s, new Set());
      return exprUses(s.value, movable);
    }
    // Generator state-machine stmts (052) never reach this pass — a `HirGenerator`
    // is its own item and the item loop above skips it (no `else` branch), and its
    // arm bodies are built post-lowering. These arms exist only for exhaustiveness.
    case "yieldReturn": {
      map.set(s, liveAfter);
      return union(exprUses(s.value, movable), liveAfter);
    }
    case "gotoState": {
      map.set(s, liveAfter);
      return liveAfter;
    }
    case "genDone": {
      map.set(s, new Set());
      return new Set();
    }
    case "yieldStarStep": {
      map.set(s, liveAfter);
      return union(exprUses(s.iter, movable), liveAfter);
    }
    case "genResumeBind": {
      // Binds `self.<target> = self.__sent.take()` (076) — struct-field writes/reads
      // only, no movable local involved; liveness passes through unchanged.
      map.set(s, liveAfter);
      return liveAfter;
    }
  }
}

/**
 * A plain `x = v` kills `x`'s prior liveness (the old value is dead); a compound
 * `x += v` reads `x` first, so it stays live. A non-ident target (`arr[i] = v`,
 * `o.f = v`) reads its sub-expressions and kills nothing.
 */
function assignTransfer(
  a: Extract<HirExpr, { kind: "assign" }>,
  liveAfter: Live,
  movable: Live,
): Live {
  const rhs = exprUses(a.value, movable);
  if (a.target.kind === "ident" && a.op === "=") {
    const out = new Set(liveAfter);
    if (movable.has(a.target.name)) out.delete(a.target.name);
    return union(rhs, out);
  }
  return union(rhs, exprUses(a.target, movable), liveAfter);
}

/**
 * Liveness through a loop, to a fixpoint. `headerUses` are the movable reads in
 * the loop's own header (condition / range bounds / iterable), evaluated once per
 * iteration. The body's `continue` target is the header's `liveIn` (the back-edge);
 * its `break` target is `liveAfter` (past the loop). Iterating until the header set
 * stops growing makes a value used at the top of the body live at the bottom — the
 * whole point of the CFG.
 */
function loopTransfer(
  headerUses: Live,
  body: HirStmt[],
  liveAfter: Live,
  _ctx: JumpCtx,
  movable: Live,
  map: Map<HirStmt, Live>,
  self: HirStmt,
): Live {
  map.set(self, liveAfter);
  let headerIn = union(headerUses, liveAfter);
  // Bounded by |movable| growth; the +2 guards against an off-by-one on the
  // convergence check. Sets only grow, so this always converges.
  for (let guard = 0; guard <= movable.size + 2; guard++) {
    const bodyCtx: JumpCtx = { brk: liveAfter, cont: headerIn };
    const bodyIn = liveInOfSeq(body, headerIn, bodyCtx, movable, map);
    const next = union(headerUses, liveAfter, bodyIn);
    if (setEq(next, headerIn)) break; // converged; the last pass wrote `map` with the fixpoint
    headerIn = next;
  }
  return headerIn;
}

// ── Uses collection ──────────────────────────────────────────────────────────

/** The set of movable names *read* anywhere in an expression. */
function exprUses(e: HirExpr, movable: Live): Live {
  const out: Live = new Set();
  collectUses(e, movable, out);
  return out;
}

function collectUses(e: HirExpr, movable: Live, out: Live): void {
  switch (e.kind) {
    case "ident":
      if (movable.has(e.name)) out.add(e.name);
      return;
    case "binary":
      collectUses(e.left, movable, out);
      collectUses(e.right, movable, out);
      return;
    case "unary":
      collectUses(e.operand, movable, out);
      return;
    case "assign":
      collectUses(e.target, movable, out);
      collectUses(e.value, movable, out);
      return;
    case "call":
      for (const a of e.args) collectUses(a.expr, movable, out);
      return;
    case "println":
      for (const a of e.args) collectUses(a, movable, out);
      return;
    case "method":
      collectUses(e.receiver, movable, out);
      for (const a of e.args) collectUses(a, movable, out);
      return;
    case "index":
      collectUses(e.object, movable, out);
      collectUses(e.index, movable, out);
      return;
    case "field":
    case "len":
      collectUses(e.object, movable, out);
      return;
    case "array":
      for (const el of e.elements) collectUses(el, movable, out);
      return;
    case "hashmap":
      for (const en of e.entries) {
        collectUses(en.key, movable, out);
        collectUses(en.value, movable, out);
      }
      return;
    case "structLit":
      for (const f of e.fields) collectUses(f.value, movable, out);
      return;
    case "ok":
      if (e.value) collectUses(e.value, movable, out);
      return;
    case "try":
    case "await":
    case "rcNew":
      collectUses(e.kind === "rcNew" ? e.inner : e.expr, movable, out);
      return;
    // A `spawn`/`joinHandleAwait` reads its sub-expression's uses (series 051c);
    // an `asyncMove` block is a `'static` task body whose captures move in — its
    // statements are not re-traversed for parent-scope liveness here (increment 1
    // admits only Copy/owned-move-in captures; the task-escape pass is inc. 2).
    case "spawn":
    case "joinHandleAwait":
      collectUses(e.expr, movable, out);
      return;
    case "rcClone":
      collectUses(e.expr, movable, out);
      return;
    case "ref":
      collectUses(e.expr, movable, out);
      return;
    case "collectVec":
      collectUses(e.iter, movable, out);
      return;
    case "tryBreak":
      collectUses(e.expr, movable, out);
      return;
    // Task-escape nodes (series 051c increment 2): a `lockAccess` reads its
    // wrapped sub-expression's uses; an `arcClone` names an `Arc`-wrapped binding
    // (not a movable non-Copy value — cloning the handle is the whole point), so
    // it is a leaf here.
    case "lockAccess":
      collectUses(e.expr, movable, out);
      return;
    case "arcClone":
      return;
    case "iterMap":
    case "iterFilter":
      collectUses(e.receiver, movable, out);
      for (const f of e.forwarded) collectUses(f, movable, out);
      return;
    case "bumpVec":
      for (const el of e.elements) collectUses(el, movable, out);
      return;
    // Leaves: number, string, bool, path, bumpNew.
  }
}

// ── Clone placement ──────────────────────────────────────────────────────────

/**
 * Walk each statement and clone the move sites the liveness result proves are
 * followed by a use. A statement's `liveOut` (from `map`) covers uses *after* it;
 * uses *within* the same expression are handled by an ordered intra-expression
 * scan. Header positions (a loop/if condition, a `match` discriminant, range
 * bounds, an iterable) get the whole `movable` set as their live-after — a
 * maximally-conservative over-approximation for the exotic case of an owned-arg
 * move inside a condition (never under-clones; at worst a needless clone).
 */
function placeSeq(stmts: HirStmt[], ctx: PlaceCtx): void {
  for (const s of stmts) placeStmt(s, ctx);
}

/** The base identifier of a projection chain (`a.b[c].d` → `a`), or `null`. */
function rootIdent(e: HirExpr): string | null {
  let cur = e;
  while (cur.kind === "field" || cur.kind === "index") cur = cur.object;
  return cur.kind === "ident" ? cur.name : null;
}

/** Strip a leading borrow to reach the value type. */
function unwrapRef(t: RustType): RustType {
  return t.kind === "ref" ? t.inner : t;
}

/** The value type of a projection (`ident` / `field` / `index`), or null if unknown. */
function projType(e: HirExpr, ctx: PlaceCtx): RustType | null {
  switch (e.kind) {
    case "ident": {
      const t = ctx.env.get(e.name);
      return t ? unwrapRef(t) : null;
    }
    case "field": {
      const bt = projType(e.object, ctx);
      if (!bt || bt.kind !== "struct") return null;
      const f = ctx.structs.get(bt.name)?.find((fld) => fld.name === e.name);
      return f ? f.ty : null;
    }
    case "index": {
      const bt = projType(e.object, ctx);
      if (bt?.kind === "vec") return bt.elem;
      if (bt?.kind === "hashmap") return bt.value;
      return null;
    }
    default:
      return null;
  }
}

/** Does a projection chain pass through an index (never movable → `E0507`)? */
function pathHasIndex(e: HirExpr): boolean {
  let cur = e;
  while (cur.kind === "field" || cur.kind === "index") {
    if (cur.kind === "index") return true;
    cur = cur.object;
  }
  return false;
}

/**
 * Reading a non-Copy projection (`obj.field` / `arr[i]`) *by value* moves out of
 * its base. That is illegal — and so must be cloned — when the base can't be moved
 * from: through an index (never movable), out of a borrowed param (behind a
 * shared/`mut` reference), or out of an owned base that is used again (a partial
 * move that would break the later use, `liveOut`). An owned local whose base is not
 * reused is a legal partial move → left bare. A Copy or unknown-typed projection is
 * never cloned.
 */
function projectionMovesOut(e: HirExpr, liveOut: Live, ctx: PlaceCtx): boolean {
  if (e.kind !== "field" && e.kind !== "index") return false;
  const t = projType(e, ctx);
  if (!t || !isCloneableMovable(t, ctx.structs)) return false;
  if (pathHasIndex(e)) return true;
  const root = rootIdent(e);
  if (root === null) return true;
  if (ctx.refParams.has(root)) return true;
  return liveOut.has(root);
}

function placeStmt(s: HirStmt, ctx: PlaceCtx): void {
  const lo = ctx.map.get(s) ?? new Set<string>();
  const all = ctx.movable; // header positions: treat everything as live (conservative)
  switch (s.kind) {
    case "let": {
      // A `let b = a` where `a` is a bare movable ident is a move of `a`.
      if (s.init.kind === "ident" && ctx.movable.has(s.init.name)) {
        if (lo.has(s.init.name)) s.init = cloneOf(s.init);
      } else if (projectionMovesOut(s.init, lo, ctx)) {
        s.init = cloneOf(s.init);
      } else {
        placeInExpr(s.init, lo, ctx);
      }
      return;
    }
    case "expr":
      placeInExpr(s.expr, lo, ctx);
      return;
    case "return":
      if (s.value) {
        if (projectionMovesOut(s.value, lo, ctx)) s.value = cloneOf(s.value);
        else placeInExpr(s.value, lo, ctx);
      }
      return;
    case "throw":
      placeInExpr(s.value, lo, ctx);
      return;
    case "if":
      placeInExpr(s.cond, all, ctx);
      placeSeq(s.conseq, ctx);
      if (s.alt) placeSeq(s.alt, ctx);
      return;
    case "while":
      placeInExpr(s.cond, all, ctx);
      placeSeq(s.body, ctx);
      return;
    case "block":
      placeSeq(s.body, ctx);
      return;
    case "forIn":
      placeInExpr(s.iter, all, ctx);
      placeSeq(s.body, ctx);
      return;
    case "forRange":
      placeInExpr(s.start, all, ctx);
      placeInExpr(s.end, all, ctx);
      placeSeq(s.body, ctx);
      return;
    case "match":
      placeInExpr(s.disc, all, ctx);
      for (const arm of s.arms) {
        if (arm.guard) placeInExpr(arm.guard, all, ctx);
        placeSeq(arm.body, ctx);
      }
      return;
    case "tryCatch":
      placeSeq(s.tryBody, ctx);
      placeSeq(s.catchBody, ctx);
      if (s.finallyBody) placeSeq(s.finallyBody, ctx);
      return;
    case "tryBlock":
    case "carrierTry":
      placeSeq(s.tryBody, ctx);
      if (s.catchBody) placeSeq(s.catchBody, ctx);
      if (s.finallyBody) placeSeq(s.finallyBody, ctx);
      return;
    // break / continue: no operands.
  }
}

interface MoveSite {
  name: string;
  seq: number;
  apply: () => void;
}

/**
 * Clone the move sites in a single expression whose moved-from binding is used
 * later — either later within this same expression (an ordered intra-expression
 * scan) or after the enclosing statement (`liveOut`). A move site is a bare movable
 * ident in an **owning position**: an owned call argument, a by-value method
 * argument, an element of a struct/array/hashmap literal, or the value of an
 * assignment — anything that consumes the value by move (move-through-store, 038).
 */
function placeInExpr(e: HirExpr, liveOut: Live, ctx: PlaceCtx): void {
  const movable = ctx.movable;
  let seq = 0;
  const lastUse = new Map<string, number>();
  const moves: MoveSite[] = [];

  // Handle `sub` in an owning position. A bare movable ident is a deferred move
  // site (cloned iff used later). A non-Copy projection that moves out of a place
  // it can't be moved from is cloned immediately (move-out-of-place, 038).
  // Otherwise recurse. `set` rewrites the operand to a `.clone()`.
  function owning(sub: HirExpr, set: (c: HirExpr) => void): void {
    if (sub.kind === "ident" && movable.has(sub.name)) {
      const name = sub.name;
      seq += 1;
      lastUse.set(name, seq);
      moves.push({ name, seq, apply: () => set(cloneOf(sub)) });
    } else if (projectionMovesOut(sub, liveOut, ctx)) {
      set(cloneOf(sub));
    } else {
      visit(sub);
    }
  }

  function visit(x: HirExpr): void {
    switch (x.kind) {
      case "ident":
        if (movable.has(x.name)) {
          seq += 1;
          lastUse.set(x.name, seq);
        }
        return;
      case "binary":
        visit(x.left);
        visit(x.right);
        return;
      case "unary":
        visit(x.operand);
        return;
      case "assign":
        visit(x.target);
        // `place = <movable>` moves the value into the target place.
        owning(x.value, (c) => {
          x.value = c;
        });
        return;
      case "call":
        for (const a of x.args) {
          // Only an owned argument moves; a `ref`/`refMut` arg borrows.
          if (a.borrow === "owned") {
            owning(a.expr, (c) => {
              a.expr = c;
            });
          } else {
            visit(a.expr);
          }
        }
        return;
      case "println":
        // `println!` borrows its args (`{}`), so they are never moved.
        for (const a of x.args) visit(a);
        return;
      case "method":
        // Method args emit by-value (`recv.m(a)`), so each is an owning position.
        visit(x.receiver);
        x.args.forEach((_, i) => {
          owning(x.args[i] as HirExpr, (c) => {
            x.args[i] = c;
          });
        });
        return;
      case "index":
        visit(x.object);
        visit(x.index);
        return;
      case "field":
      case "len":
        visit(x.object);
        return;
      case "array":
        x.elements.forEach((_, i) => {
          owning(x.elements[i] as HirExpr, (c) => {
            x.elements[i] = c;
          });
        });
        return;
      case "hashmap":
        for (const en of x.entries) {
          owning(en.key, (c) => {
            en.key = c;
          });
          owning(en.value, (c) => {
            en.value = c;
          });
        }
        return;
      case "structLit":
        for (const f of x.fields) {
          owning(f.value, (c) => {
            f.value = c;
          });
        }
        return;
      case "ok":
        if (x.value) {
          const ok = x;
          owning(x.value, (c) => {
            ok.value = c;
          });
        }
        return;
      case "try":
      case "await":
      case "spawn":
      case "joinHandleAwait":
        visit(x.expr);
        return;
      case "rcNew":
        visit(x.inner);
        return;
      case "rcClone":
        visit(x.expr);
        return;
      // Task-escape nodes (series 051c increment 2): recurse a `lockAccess`'s
      // wrapped expr (a shared-binding read); an `arcClone` is a leaf (an
      // `Arc`-handle clone, never a movable non-Copy value).
      case "lockAccess":
        visit(x.expr);
        return;
      case "arcClone":
        return;
      case "iterMap":
      case "iterFilter":
        visit(x.receiver);
        x.forwarded.forEach((_, i) => {
          owning(x.forwarded[i] as HirExpr, (c) => {
            x.forwarded[i] = c;
          });
        });
        return;
      case "bumpVec":
        x.elements.forEach((_, i) => {
          owning(x.elements[i] as HirExpr, (c) => {
            x.elements[i] = c;
          });
        });
        return;
      // Leaves: number, string, bool, path, bumpNew.
    }
  }

  visit(e);

  for (const mv of moves) {
    const laterInExpr = (lastUse.get(mv.name) ?? mv.seq) > mv.seq;
    if (laterInExpr || liveOut.has(mv.name)) mv.apply();
  }
}

/** Add every `let`-bound name with a cloneable-movable type to `movable`. */
function collectLetBindings(
  body: HirStmt[],
  movable: Live,
  structs: StructTable,
): void {
  for (const s of body) {
    switch (s.kind) {
      case "let":
        // A task-escape share-wrapped binding (series 051c increment 2) is an
        // `Arc<…>` handle, not a movable non-Copy value — its downstream uses are
        // `Arc::clone`/`.lock()`, never a bare move. Never add it to `movable`.
        if (!s.share && isCloneableMovable(s.ty, structs)) movable.add(s.name);
        break;
      case "if":
        collectLetBindings(s.conseq, movable, structs);
        if (s.alt) collectLetBindings(s.alt, movable, structs);
        break;
      case "while":
      case "block":
      case "forIn":
      case "forRange":
        collectLetBindings(s.body, movable, structs);
        break;
      case "match":
        for (const arm of s.arms)
          collectLetBindings(arm.body, movable, structs);
        break;
      case "tryCatch":
        collectLetBindings(s.tryBody, movable, structs);
        collectLetBindings(s.catchBody, movable, structs);
        if (s.finallyBody) collectLetBindings(s.finallyBody, movable, structs);
        break;
      case "tryBlock":
      case "carrierTry":
        collectLetBindings(s.tryBody, movable, structs);
        if (s.catchBody) collectLetBindings(s.catchBody, movable, structs);
        if (s.finallyBody) collectLetBindings(s.finallyBody, movable, structs);
        break;
    }
  }
}

/** Re-exported for callers that pass an `HirFn` directly (tests). */
export type { HirFn };
