/**
 * Iterator chain fusion (series 104, epic #89): fuse a single-use
 * `map`/`filter`/`reduce` chain into one lazy `xs.iter().map(…).filter(…).fold(…)`
 * so LLVM collapses it into a single allocation-free pass, instead of materializing
 * a throwaway `Vec` between each stage.
 *
 * A standalone, pure, idempotent HIR → HIR pass, last in the refine chain
 * (`refineBitwise → refineNumerics → refineStrings → refineIterFusion`). It rewrites
 * a `let NAME = <producer>` + a later consuming adapter over `NAME` into one nested
 * chain and deletes the producer statement.
 *
 * Soundness. Fusion reorders *when* each stage's callback runs (eager runs every map,
 * then every filter, then the fold; lazy interleaves per element), so it is only sound
 * when:
 *  - **G1** — the intermediate binding is referenced exactly once (the consumer's
 *    receiver), by a complete reference count. `ownership.ts`'s `computeLiveOut` is
 *    *move*-liveness (it skips borrow-only uses such as a `reduce` receiver) and would
 *    under-count reads, so it is deliberately not used here.
 *  - **G3** — no statement between producer and consumer writes the chain source or a
 *    forwarded free variable (lazy reads them at fold time, not producer time).
 *  - **G2** — callback purity — is *free*: the series-048 lift surface (`typeCbBody`)
 *    accepts only a bounded numeric expression, so a liftable `__cb_*` can't have a
 *    side effect. No check needed.
 *
 * 3c: when a *fused* chain's head reads a body-local that is dead after the chain, the
 * head lowers to `into_iter()` (owned element, no borrow/copy).
 */

import type { HirExpr, HirModule, HirStmt } from "./hir";

/** Intermediate adapters that can be a fused *producer* (they collect a `Vec`). */
const PRODUCER_KINDS = new Set(["iterMap", "iterFilter", "iterFlatMap"]);
/** Adapters that can *consume* a fused iterator as their receiver. */
const CONSUMER_KINDS = new Set([
  "iterMap",
  "iterFilter",
  "iterFlatMap",
  "iterReduce",
  "iterFind",
  "iterAny",
  "iterAll",
]);

export function refineIterFusion(module: HirModule): HirModule {
  for (const body of moduleBodies(module)) {
    // Fixpoint: each pass performs at most one fusion, then restarts (a fusion
    // mutates the list and can expose the next stage as a fresh producer).
    while (fuseOnce(body, body)) {
      /* keep fusing */
    }
    applyIntoIter(body);
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

/**
 * Scan `list` (and its nested lists) for one fusable producer→consumer pair; perform
 * it and return `true`, or `false` when none remains. `root` is the whole body, used
 * for the G1 reference count.
 */
function fuseOnce(list: HirStmt[], root: HirStmt[]): boolean {
  for (let i = 0; i < list.length; i++) {
    const prod = list[i];
    if (!prod || prod.kind !== "let") continue;
    const producer = prod.init;
    if (!isProducer(producer)) continue;
    const name = prod.name;
    // G1: the intermediate must be referenced exactly once across the whole body.
    if (refCount(root, name) !== 1) continue;

    // Find the consuming statement (later, same list) and the consumer node in it.
    let consumerIdx = -1;
    let consumer: FusableNode | null = null;
    for (let j = i + 1; j < list.length; j++) {
      const s = list[j];
      if (!s) continue;
      const c = findConsumer(s, name);
      if (c) {
        consumerIdx = j;
        consumer = c;
        break;
      }
    }
    if (!consumer || consumerIdx < 0) continue;

    // G3: no write to the source root or a forwarded free var in the gap.
    const guarded = new Set<string>();
    const srcRoot = rootName(producer.receiver);
    if (srcRoot) guarded.add(srcRoot);
    for (const f of forwardedNames(producer)) guarded.add(f);
    for (const f of forwardedNames(consumer)) guarded.add(f);
    let gapMutates = false;
    for (let g = i + 1; g < consumerIdx; g++) {
      const s = list[g];
      if (s && mutatesAny(s, guarded)) {
        gapMutates = true;
        break;
      }
    }
    if (gapMutates) continue;

    // Rewrite: producer stays lazy (no collect), consumer reads it as an iterator.
    producer.lazy = true;
    consumer.recvIter = "iter";
    consumer.receiver = producer;
    list.splice(i, 1);
    return true;
  }
  // No producer in this list — descend into nested lists.
  for (const s of list) {
    for (const child of childLists(s)) {
      if (fuseOnce(child, root)) return true;
    }
  }
  return false;
}

/**
 * 3c: for each *fused* chain head (a producer node made `lazy` by fusion whose receiver
 * is a body-local `let`), move the source via `into_iter()` when it is not referenced
 * after the chain statement in the top-level body list.
 */
function applyIntoIter(body: HirStmt[]): void {
  const locals = letNames(body);
  for (let i = 0; i < body.length; i++) {
    const stmt = body[i];
    if (!stmt) continue;
    for (const head of fusedHeads(stmt)) {
      if (head.recvIter) continue;
      const src = rootName(head.receiver);
      if (!src || !locals.has(src)) continue;
      // The source must be read exactly once in the chain statement (the head) — a
      // second same-statement use (`chain(xs) + xs.length`) can't survive the move.
      if (refCount(stmt, src) !== 1) continue;
      let usedAfter = false;
      for (let j = i + 1; j < body.length; j++) {
        const s = body[j];
        if (s && refCount(s, src) > 0) {
          usedAfter = true;
          break;
        }
      }
      if (!usedAfter) head.recvIter = "own";
    }
  }
}

// ── Node predicates ──────────────────────────────────────────────────────────

/** A fused adapter node — carries `receiver` and the fusion flags we set. */
type FusableNode = HirExpr & {
  kind: string;
  receiver: HirExpr;
  recvIter?: "own" | "iter";
  lazy?: boolean;
};

function isProducer(e: HirExpr): e is FusableNode {
  // A producer must be a lazy-adapter with no index param (its index would be
  // miscounted once fused) and not already fused (idempotency).
  if (!PRODUCER_KINDS.has(e.kind)) return false;
  const n = e as Record<string, unknown>;
  if (n.indexParam) return false;
  // `recvIter` does *not* disqualify: a middle stage that already consumes an upstream
  // iterator (recvIter) can still produce for a downstream one. Only `lazy` (already
  // feeding a consumer) means it's spoken for.
  if (n.lazy) return false;
  return true;
}

/**
 * The consumer adapter whose receiver is `{ident name}`, found among a statement's
 * **own** expressions (not a nested block — a consumer inside an `if`/loop body has its
 * own preceding statements the gap-scan wouldn't cover, so it stays out of scope).
 */
function findConsumer(stmt: HirStmt, name: string): FusableNode | null {
  let found: FusableNode | null = null;
  eachOwnNode(stmt, (o) => {
    if (found) return;
    if (!CONSUMER_KINDS.has(o.kind as string)) return;
    if (o.indexParam) return; // an indexed map can't be a fused consumer
    if (o.recvIter) return; // already fused
    const recv = o.receiver as HirExpr | undefined;
    if (recv && recv.kind === "ident" && recv.name === name) {
      found = o as unknown as FusableNode;
    }
  });
  return found;
}

/** The fused chain heads among a statement's own exprs (producer nodes marked `lazy`). */
function fusedHeads(stmt: HirStmt): FusableNode[] {
  const out: FusableNode[] = [];
  eachOwnNode(stmt, (o) => {
    if (PRODUCER_KINDS.has(o.kind as string) && o.lazy) {
      out.push(o as unknown as FusableNode);
    }
  });
  return out;
}

function forwardedNames(node: unknown): string[] {
  const fwd = (node as { forwarded?: HirExpr[] }).forwarded;
  if (!fwd) return [];
  const out: string[] = [];
  for (const f of fwd) {
    const r = rootName(f);
    if (r) out.push(r);
  }
  return out;
}

// ── Generic HIR traversal (sound, structure-agnostic) ────────────────────────

/** The base identifier of a projection chain (`a.b[c]` → `a`), or `null`. */
function rootName(e: HirExpr | undefined): string | null {
  let cur: HirExpr | undefined = e;
  while (cur && (cur.kind === "field" || cur.kind === "index")) {
    cur = (cur as { object: HirExpr }).object;
  }
  return cur && cur.kind === "ident" ? cur.name : null;
}

/**
 * Count every `{kind:"ident", name}` occurrence anywhere under `node` (statements,
 * expressions, nested lists). Complete by construction — it walks all object/array
 * properties — so it never under-counts a use. A `let`'s binding name is a plain
 * string field (not an `ident` node), so definitions are not counted, only uses.
 * Name-shadowing across scopes only inflates the count, keeping the gate conservative.
 */
function refCount(node: unknown, name: string): number {
  let count = 0;
  eachIdent(node, (nm) => {
    if (nm === name) count++;
  });
  return count;
}

function eachIdent(node: unknown, fn: (name: string) => void): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) eachIdent(x, fn);
    return;
  }
  const o = node as Record<string, unknown>;
  if (o.kind === "ident" && typeof o.name === "string") fn(o.name);
  for (const k in o) {
    const v = o[k];
    if (v && typeof v === "object") eachIdent(v, fn);
  }
}

/** Visit every node (object with a string `kind`) under a statement/expression. */
function eachNode(node: unknown, fn: (o: Record<string, unknown>) => void): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) eachNode(x, fn);
    return;
  }
  const o = node as Record<string, unknown>;
  if (typeof o.kind === "string") fn(o);
  for (const k in o) {
    const v = o[k];
    if (v && typeof v === "object") eachNode(v, fn);
  }
}

/** Statement-list-bearing keys — a nested scope, skipped by `eachOwnNode`. */
const STMT_LIST_KEYS = new Set([
  "body",
  "conseq",
  "alt",
  "tryBody",
  "catchBody",
  "finallyBody",
  "someBody",
  "noneBody",
  "arms",
  "stmts",
]);

/**
 * Like `eachNode`, but does **not** descend into nested statement lists (`if`/loop/
 * `try` bodies, match arms) — it visits only the statement's own expression tree. Used
 * to find a consumer/head in the *same scope* as its producer, so the gap-mutation
 * scan (which walks that scope's statements) covers everything between them.
 */
function eachOwnNode(
  node: unknown,
  fn: (o: Record<string, unknown>) => void,
): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) eachOwnNode(x, fn);
    return;
  }
  const o = node as Record<string, unknown>;
  if (typeof o.kind === "string") fn(o);
  for (const k in o) {
    if (STMT_LIST_KEYS.has(k)) continue;
    const v = o[k];
    if (v && typeof v === "object") eachOwnNode(v, fn);
  }
}

/** Does a statement write (assign/update, or a — conservatively mutating — method
 * call, or a `&mut` arg) any of `names` at its projection root? */
function mutatesAny(stmt: HirStmt, names: ReadonlySet<string>): boolean {
  if (names.size === 0) return false;
  let hit = false;
  eachNode(stmt, (o) => {
    if (hit) return;
    const kind = o.kind as string;
    if (kind === "assign" || kind === "update") {
      const r = rootName(o.target as HirExpr);
      if (r && names.has(r)) hit = true;
    } else if (kind === "method") {
      // A method may mutate its receiver (`.push`, `.sort`, …) — conservatively bail.
      const r = rootName(o.receiver as HirExpr);
      if (r && names.has(r)) hit = true;
    }
  });
  return hit;
}

/** All `let`-bound names in a body (recursively through nested lists). */
function letNames(body: HirStmt[]): Set<string> {
  const out = new Set<string>();
  eachNode(body, (o) => {
    if (o.kind === "let" && typeof o.name === "string") out.add(o.name);
  });
  return out;
}

/** The nested statement lists directly held by a statement. */
function childLists(stmt: HirStmt): HirStmt[][] {
  const out: HirStmt[][] = [];
  const s = stmt as Record<string, unknown>;
  const push = (v: unknown): void => {
    if (Array.isArray(v) && (v.length === 0 || isStmtLike(v[0]))) {
      out.push(v as HirStmt[]);
    }
  };
  push(s.body);
  push(s.conseq);
  push(s.alt);
  push(s.tryBody);
  push(s.catchBody);
  push(s.finallyBody);
  push(s.someBody);
  push(s.noneBody);
  if (Array.isArray(s.arms)) {
    for (const arm of s.arms as Record<string, unknown>[]) push(arm.body);
  }
  return out;
}

function isStmtLike(v: unknown): boolean {
  return !!v && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string";
}
