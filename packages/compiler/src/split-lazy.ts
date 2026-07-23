/**
 * Lazy `split` (series 107, epic #88 sub-task 2c): a non-empty-separator
 * `String.prototype.split` whose result is consumed **without keeping the pieces**
 * streams Rust's native `str::split` (borrowed `&str`, zero allocation) instead of
 * materializing a `Vec<String>` of owned pieces.
 *
 * Framed by principle, not the benchmark: `strbuild` is one witness. Byte-identical
 * output, **no dialect-surface change** — `string[]` still means `Vec<String>`; the
 * compiler is only choosing a representation it can *prove* observationally identical,
 * exactly as iterator fusion (#89) does.
 *
 * A standalone, pure, idempotent HIR → HIR pass, mirroring `refineIterFusion`. It runs
 * on final binding types (after `refineStrings`).
 *
 * **Separator eligibility (Dial 1) is free**: only the 1-arg non-empty form lowers to a
 * `tslib::string::split(recv, sep)` call. `split("")` (`split_chars`), `split(sep, n)`
 * (`split_limit`), and regex `re.split(s)` (a `method` node) have different shapes, so
 * they never match and stay materialized.
 *
 * **Consumer taxonomy (Dial 2).** This increment handles iteration (staging 1):
 *   - inline `for (const p of s.split(sep))` — the `forIn.iter` is `<split>.iter()`.
 *   - temp `const parts = s.split(sep); for (const p of parts)` — a single-use `let`.
 * Count (`.length`) and single-index (`[i]`) land in staging 2.
 *
 * **Soundness.** The streamed element is a borrowed `&str` where the materialized form
 * yielded `&String`; for read-only uses this is a transparent `Deref` substitution. An
 * element that **escapes as an owned `String`** (pushed into a `Vec<String>`, returned,
 * bound to a `let`) would break, so `bindersEscape` is **default-deny**: fusion fires
 * only when every use of the element binder is in a provably `&str`-safe slot. (An
 * escaping piece does not even compile today, so a false-negative only misses an
 * optimization — never a regression.) Additional guards mirror iter-fusion:
 *   - **G1** — the temp binding is referenced exactly once (a second use ⇒ materialize).
 *   - **G3** — no statement between producer and consumer writes the split source, and
 *     the loop body does not mutate it (the stream borrows the source across the loop).
 */

import type { HirExpr, HirModule, HirStmt } from "./hir";

/** The tslib callee for the eligible 1-arg non-empty-separator split. */
const SPLIT_CALLEE = "tslib::string::split";

export function refineSplitLazy(module: HirModule): HirModule {
  for (const body of moduleBodies(module)) rewriteList(body, body);
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

/** The extracted receiver + separator of an eligible split call. */
interface Split {
  recv: HirExpr;
  sep: HirExpr;
}

/** An eligible split call → its `{recv, sep}`, or `null`. */
function asSplit(e: HirExpr | undefined): Split | null {
  if (!e || e.kind !== "call" || e.callee !== SPLIT_CALLEE) return null;
  if (e.args.length !== 2) return null;
  const recv = e.args[0]?.expr;
  const sep = e.args[1]?.expr;
  if (!recv || !sep) return null;
  return { recv, sep };
}

/** A `forIn` whose `iter` is `<eligible split>.iter()` (the inline form). */
function iterOverSplit(iter: HirExpr): Split | null {
  if (iter.kind !== "method" || iter.name !== "iter") return null;
  return asSplit(iter.receiver);
}

function rewriteList(list: HirStmt[], root: HirStmt[]): void {
  // Temp-binding form: `let parts = split(...)` consumed by a later `for…of parts`.
  for (let i = 0; i < list.length; i++) {
    const prod = list[i];
    if (!prod || prod.kind !== "let") continue;
    const split = asSplit(prod.init);
    if (!split) continue;
    const name = prod.name;
    // G1: referenced exactly once across the whole body (the loop's iterable).
    if (refCount(root, name) !== 1) continue;

    // The consumer must be a `for p in parts.iter()` later in the SAME list, so the
    // gap-mutation scan below covers everything between producer and consumer.
    let consumerIdx = -1;
    for (let j = i + 1; j < list.length; j++) {
      const s = list[j];
      if (s && s.kind === "forIn" && isIterOverIdent(s.iter, name)) {
        consumerIdx = j;
        break;
      }
    }
    if (consumerIdx < 0) continue;
    const forIn = list[consumerIdx] as Extract<HirStmt, { kind: "forIn" }>;

    const srcRoot = rootName(split.recv);
    // G3a: no write to the source between producer and consumer.
    if (srcRoot && gapMutates(list, i + 1, consumerIdx, srcRoot)) continue;
    // G3b: the loop body must not mutate the borrowed source.
    if (srcRoot && mutatesRoot(forIn.body, srcRoot)) continue;
    // G-elem: the element must not escape as an owned `String`.
    const binder = binderName(forIn.pat);
    if (binder === null || bindersEscape(forIn.body, binder)) continue;

    forIn.iter = { kind: "strSplitIter", recv: split.recv, sep: split.sep };
    list.splice(i, 1);
    i--; // the list shrank; re-examine this index
  }

  // Inline form + recurse into nested lists.
  for (const s of list) {
    if (!s) continue;
    if (s.kind === "forIn") {
      const split = iterOverSplit(s.iter);
      if (split) {
        const srcRoot = rootName(split.recv);
        const binder = binderName(s.pat);
        if (
          binder !== null &&
          !(srcRoot && mutatesRoot(s.body, srcRoot)) &&
          !bindersEscape(s.body, binder)
        ) {
          s.iter = { kind: "strSplitIter", recv: split.recv, sep: split.sep };
        }
      }
    }
    for (const child of childLists(s)) rewriteList(child, root);
  }
}

/** Is `iter` an `ident(name).iter()` method call? */
function isIterOverIdent(iter: HirExpr, name: string): boolean {
  return (
    iter.kind === "method" &&
    iter.name === "iter" &&
    iter.receiver.kind === "ident" &&
    iter.receiver.name === name
  );
}

/** The bound element name of a for-of pattern, or `null` when it is not a plain
 * identifier (a `&x` ref pattern is unwrapped; a newtype `Foo(x)`/tuple pattern is
 * treated as unknown → `null` → caller materializes). */
function binderName(pat: string): string | null {
  const p = pat.startsWith("&") ? pat.slice(1) : pat;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(p) ? p : null;
}

// ── Escape analysis (default-deny) ───────────────────────────────────────────

/**
 * True when the element binder is used anywhere that is **not** a provably
 * `&str`-safe, read-only slot — i.e. it might need to be an owned `String`. Any slot
 * not on the allowlist is treated as an escape (sound: worst case we materialize a
 * fusable loop). An unused binder trivially does not escape.
 */
function bindersEscape(node: unknown, binder: string): boolean {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((x) => bindersEscape(x, binder));
  const o = node as Record<string, unknown>;
  const kind = typeof o.kind === "string" ? o.kind : undefined;
  for (const k in o) {
    const v = o[k];
    if (isBinderIdent(v, binder) && !safeScalarSlot(o, kind, k)) return true;
    if (Array.isArray(v)) {
      for (const el of v) {
        if (isBinderIdent(el, binder) && !safeArraySlot(kind, k)) return true;
      }
    }
  }
  for (const k in o) {
    if (bindersEscape(o[k], binder)) return true;
  }
  return false;
}

function isBinderIdent(v: unknown, binder: string): boolean {
  return (
    !!v &&
    typeof v === "object" &&
    (v as { kind?: unknown }).kind === "ident" &&
    (v as { name?: unknown }).name === binder
  );
}

/** Scalar (non-array) child slots where a borrowed `&str` element is safe. */
function safeScalarSlot(
  o: Record<string, unknown>,
  kind: string | undefined,
  key: string,
): boolean {
  // Read-only projections and comparisons.
  if (kind === "method" && key === "receiver") return true; // p.len(), p.contains(…)
  if (kind === "field" && key === "object") return true; // p.foo
  if (kind === "len" && key === "object") return true; // p.length → p.chars().count()
  if (kind === "index" && (key === "object" || key === "index")) return true;
  if (kind === "binary" && (key === "left" || key === "right")) return true;
  if (kind === "unary" && key === "operand") return true;
  // A `&`-borrowed argument (HirArg `{ borrow, expr }`) — read-only.
  if (kind === undefined && key === "expr" && o.borrow === "ref") return true;
  return false;
}

/** Array child slots where a borrowed `&str` element is safe (Display contexts). */
function safeArraySlot(kind: string | undefined, key: string): boolean {
  if ((kind === "strConcat" || kind === "strAppend") && key === "parts") return true;
  if (kind === "println" && key === "args") return true;
  return false;
}

// ── Generic HIR traversal (shared shapes with iter-fusion) ───────────────────

/** The base identifier of a projection chain (`a.b[c]` → `a`), or `null`. */
function rootName(e: HirExpr | undefined): string | null {
  let cur: HirExpr | undefined = e;
  while (cur && (cur.kind === "field" || cur.kind === "index")) {
    cur = (cur as { object: HirExpr }).object;
  }
  return cur && cur.kind === "ident" ? cur.name : null;
}

/** Count every `{kind:"ident", name}` occurrence anywhere under `node`. A `let`'s
 * binding name is a plain string field (not an `ident` node), so definitions are not
 * counted, only uses. */
function refCount(node: unknown, name: string): number {
  let count = 0;
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    const o = n as Record<string, unknown>;
    if (o.kind === "ident" && o.name === name) count++;
    for (const k in o) walk(o[k]);
  };
  walk(node);
  return count;
}

/** Does any statement in `list[from..to)` write `name` at a projection root? */
function gapMutates(
  list: HirStmt[],
  from: number,
  to: number,
  name: string,
): boolean {
  for (let g = from; g < to; g++) {
    const s = list[g];
    if (s && mutatesRoot(s, name)) return true;
  }
  return false;
}

/** Does `node` write `name` — an assign/update target, or a (conservatively
 * mutating) method receiver — at its projection root? */
function mutatesRoot(node: unknown, name: string): boolean {
  let hit = false;
  const walk = (n: unknown): void => {
    if (hit || n === null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    const o = n as Record<string, unknown>;
    const kind = o.kind as string;
    if (kind === "assign" || kind === "update" || kind === "strAppend") {
      // `assign`/`update` write `target`; `strAppend` (series 106) mutates its
      // `target` in place (`s = s + …` after refineStrAppend, which runs before us).
      if (rootName(o.target as HirExpr) === name) hit = true;
    } else if (kind === "method") {
      // A method may mutate its receiver (`.push`, `.sort`, …) — conservatively bail.
      if (rootName(o.receiver as HirExpr) === name) hit = true;
    }
    for (const k in o) walk(o[k]);
  };
  walk(node);
  return hit;
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
  return (
    !!v && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string"
  );
}
