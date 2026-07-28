/**
 * Pure, leaf helpers shared across the `lower/` modules (series 109).
 *
 * Everything here is dependency-free within lowering: small functions over `ast`
 * nodes, `hir` nodes, `RustType`s, strings, and sets, calling nothing that lives
 * in a sibling `lower/` module. This is the bottom of the folder-module's internal
 * import graph — siblings import from here, it imports from none of them.
 */

import type {
  BlockStatement,
  Expression,
  Identifier,
  Literal,
  Statement,
} from "../ast";
import type { HirExpr, RustType } from "../hir";

// ── strings ──────────────────────────────────────────────────────────────────

/** A short deterministic FNV-1a hash (base-36). */
export function shortHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Uppercase the first ASCII letter (`range` → `Range`) for a struct name. */
export function capitalizeAscii(s: string): string {
  return s.length === 0 ? s : (s[0] as string).toUpperCase() + s.slice(1);
}

/** Render a JS string as a Rust double-quoted string literal (escaped). */
export function rustStrLit(s: string): string {
  return (
    `"${s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")}"`
  );
}

// ── sets ─────────────────────────────────────────────────────────────────────

/** Structural equality of two string sets. */
export function setEq(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** A fresh set with a size-tagged marker added (recursion-cycle guard). */
export function addSeen(seen: Set<string>, tag: string): Set<string> {
  return new Set(seen).add(`${tag}#${seen.size}`);
}

// ── ast nodes ────────────────────────────────────────────────────────────────

/** Wrap an expression in an `ExpressionStatement`. */
export function exprStmt(e: Expression): Statement {
  return { type: "ExpressionStatement", expression: e } as unknown as Statement;
}

/** A statement's contained statement list (`{ … }` body, or a single statement). */
export function blockBody(s: Statement): Statement[] {
  return s.type === "BlockStatement" ? (s as BlockStatement).body : [s];
}

/** A runtime AST-node guard (`{ type: string, … }`). */
export function isAstNode(
  x: unknown,
): x is { type: string; [k: string]: unknown } {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as { type?: unknown }).type === "string"
  );
}

/** Peel a trailing `!` (`TSNonNullExpression`) off an expression. */
export function peelNonNull(e: Expression): Expression {
  return e.type === "TSNonNullExpression"
    ? (e as unknown as { expression: Expression }).expression
    : e;
}

/** Whether `expr` is the literal `undefined` or `null`. */
export function isNullishExpr(expr: Expression): boolean {
  if (expr.type === "Identifier")
    return (expr as Identifier).name === "undefined";
  if (expr.type === "Literal") return (expr as Literal).value === null;
  return false;
}

// ── RustType / HIR ───────────────────────────────────────────────────────────

/** Wrap an ok-type in `Result<ok, err>`. */
export function resultType(ok: RustType, err: RustType): RustType {
  return { kind: "result", ok, err };
}

/** A Copy scalar payload (#70) needs no `Rc` wrapper around a value default. */
export function isScalarType(t: RustType): boolean {
  return (
    t.kind === "f64" ||
    t.kind === "i64" ||
    t.kind === "i128" ||
    t.kind === "usize" ||
    t.kind === "bool"
  );
}

/** Shallow-structural `RustType` equality (recurses into `vec` elements). */
export function sameRustType(a: RustType, b: RustType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "vec" && b.kind === "vec") return sameRustType(a.elem, b.elem);
  return true;
}

/** Is a `RustType` a `Copy` scalar (forwardable by value into a lifted fn)? */
export function isCopyRustType(ty: RustType): boolean {
  return (
    ty.kind === "f64" ||
    ty.kind === "usize" ||
    ty.kind === "i64" ||
    ty.kind === "bool" ||
    ty.kind === "fnPtr"
  );
}

/** `&expr` — an explicit shared borrow at a call site (series 061). */
export function refExpr(expr: HirExpr): HirExpr {
  return { kind: "ref", mut: false, expr };
}

// ── structural AST/HIR walks (shared: generators, try-carrier, closures) ─────

/** All local names declared (via `let`/`const`/`var`) anywhere in `stmts`, in
 * source order, deduped. Descends through control flow (not nested functions). */
export function collectDeclaredLocals(stmts: Statement[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const set = new Set<string>();
  for (const s of stmts) collectDeclaredLocalsInto(s, set, order, seen);
  return order;
}

export function collectDeclaredLocalsInto(
  node: unknown,
  out: Set<string>,
  order?: string[],
  seen?: Set<string>,
): void {
  if (!node || typeof node !== "object") return;
  const n = node as { type?: string };
  if (
    n.type === "FunctionDeclaration" ||
    n.type === "FunctionExpression" ||
    n.type === "ArrowFunctionExpression"
  ) {
    return;
  }
  if (n.type === "VariableDeclaration") {
    for (const d of (n as unknown as { declarations: { id: unknown }[] })
      .declarations) {
      const id = d.id as { type?: string; name?: string };
      if (id.type === "Identifier" && id.name) {
        out.add(id.name);
        if (order && seen && !seen.has(id.name)) {
          seen.add(id.name);
          order.push(id.name);
        }
      }
    }
  }
  for (const key in node) {
    if (key === "type") continue;
    const v = (node as Record<string, unknown>)[key];
    if (Array.isArray(v)) {
      for (const el of v) collectDeclaredLocalsInto(el, out, order, seen);
    } else {
      collectDeclaredLocalsInto(v, out, order, seen);
    }
  }
}

/** Collect identifier *reads* in `node` whose name is in `universe`. Skips
 * member property names (`o.f` — `f` is not a variable), a `VariableDeclarator`'s
 * binding `id` (a declaration is a write, not a read — only its `init` is read),
 * and nested functions. */
export function collectRefs(
  node: unknown,
  universe: Set<string>,
  out: Set<string>,
): void {
  if (!node || typeof node !== "object") return;
  const n = node as { type?: string };
  if (n.type === "Identifier") {
    const nm = (n as { name?: string }).name;
    if (nm && universe.has(nm)) out.add(nm);
    return;
  }
  if (
    n.type === "FunctionDeclaration" ||
    n.type === "FunctionExpression" ||
    n.type === "ArrowFunctionExpression"
  ) {
    return;
  }
  if (n.type === "VariableDeclarator") {
    collectRefs((n as unknown as { init: unknown }).init, universe, out);
    return; // the binding `id` is a write, not a read
  }
  if (n.type === "MemberExpression") {
    const m = n as unknown as {
      object: unknown;
      property: unknown;
      computed: boolean;
    };
    collectRefs(m.object, universe, out);
    if (m.computed) collectRefs(m.property, universe, out); // `o[e]` reads `e`
    return; // a non-computed `.prop` name is not a variable read
  }
  for (const key in node) {
    if (key === "type") continue;
    const v = (node as Record<string, unknown>)[key];
    if (Array.isArray(v)) {
      for (const el of v) collectRefs(el, universe, out);
    } else {
      collectRefs(v, universe, out);
    }
  }
}

/** Rewrite every `{kind:"ident", name}` whose name is a field to `self.<name>`
 * (a struct-field access). A generic structural walk over the lowered HIR — it
 * never touches string field names, so struct-literal keys / method names are
 * safe; the introduced `self` ident is not a field, so no double-rewrite. */
export function rewriteFieldRefs<T>(node: T, fields: Set<string>): T {
  if (Array.isArray(node)) {
    return node.map((n) => rewriteFieldRefs(n, fields)) as unknown as T;
  }
  if (node && typeof node === "object") {
    const obj = node as { kind?: string; name?: string };
    if (obj.kind === "ident" && obj.name && fields.has(obj.name)) {
      return {
        kind: "field",
        object: { kind: "ident", name: "self" },
        name: obj.name,
      } as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const key in node) {
      out[key] = rewriteFieldRefs(
        (node as Record<string, unknown>)[key],
        fields,
      );
    }
    return out as unknown as T;
  }
  return node;
}
