/**
 * HIR — the typed intermediate representation between the ESTree AST and Rust.
 *
 * The AST is TypeScript's shape (ESTree, untyped as to ownership). The HIR is
 * *Rust's* shape: every node already carries the decisions the emitter would
 * otherwise have to re-derive from side tables —
 *
 *   - types are resolved to `RustType` (no `TSType`, no annotation lookups),
 *   - parameters carry their borrow form folded into the type (`&T` / `&mut T`),
 *   - `let` bindings carry their `mut`-ness,
 *   - call arguments carry the borrow to apply at the call site.
 *
 * As a result the emitter (`emitter/`) is a pure, total HIR → string function
 * with no analysis and no dialect rejection. All lowering decisions — and every
 * `UnsupportedError` — live in `lower.ts`, the single gate. Ownership/mutability
 * inference still lives in `analysis.ts`; `lower.ts` consumes it once and bakes
 * the results into the HIR (the side tables are no longer threaded downstream).
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** How a value is borrowed at a use site (call argument). */
export type Borrow = "owned" | "ref" | "refMut";

/**
 * A Rust type. `ref` models a borrow (`&T` / `&mut T`); a parameter's borrow
 * form is folded in here so the emitter renders it by simple recursion. A future
 * numeric-inference pass will refine `f64` into `i64` / `usize` where indices and
 * counters demand it.
 */
export type RustType =
  | { kind: "f64" }
  | { kind: "String" }
  | { kind: "bool" }
  | { kind: "unit" }
  | { kind: "vec"; elem: RustType }
  | { kind: "ref"; mut: boolean; inner: RustType };

// ── Expressions ──────────────────────────────────────────────────────────────

/** A call argument plus the borrow to apply to it (`x` / `&x` / `&mut x`). */
export interface HirArg {
  borrow: Borrow;
  expr: HirExpr;
}

export type HirExpr =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "ident"; name: string }
  | { kind: "binary"; op: string; left: HirExpr; right: HirExpr }
  | { kind: "assign"; op: string; target: HirExpr; value: HirExpr }
  /** Direct call to a known function; args carry their borrow. */
  | { kind: "call"; callee: string; args: HirArg[] }
  /** `console.log(...)` → `println!` with a JS-style format string. */
  | { kind: "println"; args: HirExpr[] }
  /** `obj.method(args)` — receiver borrow is Rust's method-resolution problem. */
  | { kind: "method"; receiver: HirExpr; name: string; args: HirExpr[] }
  /** `obj[index]` — Rust index, always `usize`. */
  | { kind: "index"; object: HirExpr; index: HirExpr }
  /** `obj.field` (non-method member access). */
  | { kind: "field"; object: HirExpr; name: string }
  /** `arr.length` → `arr.len()`. */
  | { kind: "len"; object: HirExpr }
  /** array literal → `vec![...]`. */
  | { kind: "array"; elements: HirExpr[] };

// ── Statements ───────────────────────────────────────────────────────────────

export type HirStmt =
  | {
      kind: "let";
      name: string;
      mut: boolean;
      ty: RustType | null;
      init: HirExpr;
    }
  | { kind: "return"; value: HirExpr | null }
  | { kind: "expr"; expr: HirExpr };

// ── Items & module ───────────────────────────────────────────────────────────

/** A function parameter; `ty` already includes any `&`/`&mut` borrow form. */
export interface HirParam {
  name: string;
  ty: RustType;
}

export interface HirFn {
  kind: "fn";
  name: string;
  isAsync: boolean;
  params: HirParam[];
  /** `unit` for a `void`/unannotated function. */
  ret: RustType;
  body: HirStmt[];
}

/**
 * A lowered module. Top-level *declarations* become `items`; top-level
 * *statements* become the body of a generated `fn main()` (`main`, empty when
 * there is no script). Mixing script with a user-defined `main` is rejected in
 * lowering, so those two never conflict here.
 */
export interface HirModule {
  items: HirFn[];
  main: HirStmt[];
}
