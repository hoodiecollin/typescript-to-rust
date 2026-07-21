/**
 * In-place string append (series 106, epic #88 sub-task 2a): rewrite the
 * self-append rebind `s = s + …` — which series 080 lowered to an O(n²)
 * `s = format!("{}{}…", s, …)` (a fresh buffer + full copy of the accumulator each
 * iteration) — into a single amortized-O(n) `write!(s, "{}…", …).unwrap()` that
 * appends through the accumulator's `std::fmt::Write` impl (capacity doubling, no
 * whole-buffer realloc). This is the driver of `strbuild`'s benchmark loss.
 *
 * A standalone, pure, idempotent HIR → HIR pass in the refine chain, after
 * `refineStrings` (binding types are final by then). It shares no node shapes with
 * the other refinements, so its ordering relative to them is free.
 *
 * Pattern. A statement `expr(assign(op:"=", target:ident(S), value:strConcat(parts)))`
 * where:
 *  - **G1** — `target` is a plain identifier `S` (not a member/index expression).
 *  - **G2** — `parts[0]` is exactly `ident(S)`: the accumulator is the *head* of the
 *    `+` chain (true append), and there is ≥1 tail part.
 *  - **G3** — `S` is an owned, mutable `String` **local** declared by a
 *    `let mut S: String` in the same body.
 *
 * Soundness. Under TTR's move-by-default model, any alias of `S`'s old value is an
 * independent `.clone()` buffer (a plain `let t = s` that *moved* `s` would make `s`
 * dead, so the existing `format!` form — which also reads `s` — could not have
 * compiled). So whenever the `format!` code compiles, `S` is a live owned `String`
 * and mutating it in place is observationally identical to rebinding a new buffer.
 * G3 keeps the rewrite off `&str`/`&mut String` params, fields and captures; and
 * Rust's borrow checker is the backstop (a live borrow of `S` would reject the
 * emitted `&mut s`, not silently misbehave). Output is byte-identical — `write!`
 * uses the same `Display` formatting for every part.
 *
 * Only the head-appended form is rewritten. `s = "x" + s` (prepend) and
 * `s = a + s + b` (`S` not the head) keep their `format!` — order of parts is
 * observable and an in-place splice is not a plain append.
 */

import type { HirExpr, HirModule, HirStmt } from "./hir";

export function refineStrAppend(module: HirModule): HirModule {
  for (const body of moduleBodies(module)) {
    const ownedStrings = collectOwnedStringLocals(body);
    rewriteList(body, ownedStrings);
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
 * Names declared in `body` (at any nesting depth) by a `let … : String` — i.e. owned
 * `String` locals. A `&str`/`&mut String` param is not a `let`, so it never appears
 * here; nor does a field or a captured variable. G3.
 */
function collectOwnedStringLocals(body: HirStmt[]): Set<string> {
  const names = new Set<string>();
  const visit = (stmts: HirStmt[]): void => {
    for (const s of stmts) {
      if (s.kind === "let" && !s.pat && !s.names && s.ty?.kind === "String") {
        names.add(s.name);
      }
      for (const nested of nestedStmtLists(s)) visit(nested);
    }
  };
  visit(body);
  return names;
}

/** Walk every statement list nested inside a statement (bodies of loops/ifs/blocks). */
function nestedStmtLists(s: HirStmt): HirStmt[][] {
  switch (s.kind) {
    case "if":
      return s.alt ? [s.conseq, s.alt] : [s.conseq];
    case "ifLet":
      return s.noneBody ? [s.someBody, s.noneBody] : [s.someBody];
    case "while":
    case "block":
    case "forIn":
    case "forInReborrow":
    case "forRange":
      return [s.body];
    case "match":
      return s.arms.map((a) => a.body);
    default:
      return [];
  }
}

/** Rewrite self-append assigns in `list`, recursing into nested statement lists. */
function rewriteList(list: HirStmt[], ownedStrings: Set<string>): void {
  for (const s of list) {
    if (s.kind === "expr") {
      const rewritten = tryRewriteAssign(s.expr, ownedStrings);
      if (rewritten) s.expr = rewritten;
    }
    for (const nested of nestedStmtLists(s)) rewriteList(nested, ownedStrings);
  }
}

/**
 * If `e` is a self-append assign over an owned `String` local, return the
 * `strAppend` replacement; else `null`.
 */
function tryRewriteAssign(
  e: HirExpr,
  ownedStrings: Set<string>,
): HirExpr | null {
  if (e.kind !== "assign" || e.op !== "=") return null;
  // G1: plain identifier target.
  if (e.target.kind !== "ident") return null;
  const name = e.target.name;
  // G3: owned `String` local.
  if (!ownedStrings.has(name)) return null;
  // Value must be a string-concat chain with the accumulator as its head (G2).
  if (e.value.kind !== "strConcat") return null;
  const parts = e.value.parts;
  const head = parts[0];
  if (!head || head.kind !== "ident" || head.name !== name) return null;
  const tail = parts.slice(1);
  if (tail.length === 0) return null; // `s = s` (no tail) — nothing to append.
  return { kind: "strAppend", target: e.target, parts: tail };
}
