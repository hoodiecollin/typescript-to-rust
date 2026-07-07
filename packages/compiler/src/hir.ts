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
 * form is folded in here so the emitter renders it by simple recursion. The
 * numeric-inference pass (`numeric.ts`) refines `f64` into `usize` where indexing
 * demands it; `i64` for integer counters is a documented future addition here.
 */
export type RustType =
  | { kind: "f64" }
  | { kind: "usize" }
  /** A signed 64-bit integer — an integer counter/discriminant (`numeric.ts`). */
  | { kind: "i64" }
  | { kind: "String" }
  /** The unsized string slice `str` — only ever valid behind a `ref` (`&str`). */
  | { kind: "str" }
  | { kind: "bool" }
  | { kind: "unit" }
  | { kind: "vec"; elem: RustType }
  /**
   * `Record<string, V>` → `IndexMap<String, V>` (series 041; insertion-order
   * preserving, matching JS). `key` is always `String` today. The HIR tag stays
   * `hashmap` (the map node); only the emitted backing type is `IndexMap`.
   */
  | { kind: "hashmap"; key: RustType; value: RustType }
  /** A named `struct` (from an `interface`); rendered as the bare name. */
  | { kind: "struct"; name: string }
  /** A fallible function's return type: `Result<ok, err>` (`err` is `String` today). */
  | { kind: "result"; ok: RustType; err: RustType }
  /**
   * `Box<dyn std::error::Error>` — the program error type when any custom error
   * class is declared (series 022), so `?` composes across every fallible fn.
   */
  | { kind: "boxError" }
  /**
   * `Rc<RefCell<inner>>` — shared, interior-mutable ownership (series 028b, the
   * `"use rc"` directive). The sanctioned Option-B fallback for shared mutable
   * aliasing the idiomatic borrow model can't express; produced only by the
   * `refineRc` pass over a `"use rc"` scope.
   */
  | { kind: "rc"; inner: RustType }
  /**
   * `impl Iterator<Item = item>` — the return type of a sync generator
   * (`function*`, series 025d). Only valid in return position (an opaque type).
   */
  | { kind: "implIterator"; item: RustType }
  | { kind: "ref"; mut: boolean; inner: RustType };

/**
 * The refined type of a numeric literal node. Absent ⇒ `f64` (the default). The
 * numeric-inference pass tags integer literals that reach a `usize` context, and
 * `i64` literals that drive an integer counter / `match` discriminant. Both
 * integer tags emit bare (no `.0` suffix); only `f64` integers need `.0`.
 */
export type NumericType = "f64" | "usize" | "i64";

// ── Expressions ──────────────────────────────────────────────────────────────

/** A call argument plus the borrow to apply to it (`x` / `&x` / `&mut x`). */
export interface HirArg {
  borrow: Borrow;
  expr: HirExpr;
}

export type HirExpr =
  | { kind: "number"; value: number; ty?: NumericType }
  | { kind: "string"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "ident"; name: string }
  /** A Rust path like `Color::Red` (an enum variant). Segments are `::`-joined. */
  | { kind: "path"; segments: string[] }
  | { kind: "binary"; op: string; left: HirExpr; right: HirExpr }
  /** A prefix unary: `-x` (negation) or `!x` (logical not). */
  | { kind: "unary"; op: string; operand: HirExpr }
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
  | { kind: "array"; elements: HirExpr[] }
  /** record object literal → `IndexMap::from([(k, v), …])` (or `IndexMap::new()`). */
  | { kind: "hashmap"; entries: { key: HirExpr; value: HirExpr }[] }
  /** struct object literal → `Name { field: value, … }`. */
  | {
      kind: "structLit";
      name: string;
      fields: { name: string; value: HirExpr }[];
    }
  /** `Ok(value)` — the success arm of a `Result`. `null` value ⇒ `Ok(())`. */
  | { kind: "ok"; value: HirExpr | null }
  /** `expr?` — propagate a fallible call's error to the enclosing `Result`. */
  | { kind: "try"; expr: HirExpr }
  /** `expr.await` — suspend on a future (a call to an `async fn`) for its value. */
  | { kind: "await"; expr: HirExpr }
  /**
   * `xs.map(p => body)` → `xs.iter().map(|&p| body).collect::<Vec<_>>()` (027-cl).
   * The `&p` pattern copies the element out of the `.iter()` borrow (Copy elems).
   */
  | { kind: "iterMap"; receiver: HirExpr; param: string; body: HirExpr }
  /**
   * `xs.filter(p => body)` →
   * `xs.iter().filter(|&&p| body).copied().collect::<Vec<_>>()` (027-cl).
   */
  | { kind: "iterFilter"; receiver: HirExpr; param: string; body: HirExpr }
  /** `Object.keys(m)` → `m.keys().cloned().collect::<Vec<_>>()` → `Vec<String>` (041). */
  | { kind: "objectKeys"; map: HirExpr }
  /** `Object.values(m)` → `m.values().cloned().collect::<Vec<_>>()` → `Vec<V>` (041). */
  | { kind: "objectValues"; map: HirExpr }
  /** `xs.some(p => c)` → `xs.iter().any(|&p| c)` → `bool` (039). */
  | { kind: "iterAny"; receiver: HirExpr; param: string; body: HirExpr }
  /** `xs.every(p => c)` → `xs.iter().all(|&p| c)` → `bool` (039). */
  | { kind: "iterAll"; receiver: HirExpr; param: string; body: HirExpr }
  /**
   * `xs.reduce((acc, x) => e, init)` → `xs.iter().fold(init, |acc, &x| e)` (039).
   * `acc` is the owned fold accumulator (seeded by `init`); `elem` binds `&elem`
   * to copy each Copy element out of the `.iter()` borrow.
   */
  | {
      kind: "iterReduce";
      receiver: HirExpr;
      acc: string;
      elem: string;
      body: HirExpr;
      init: HirExpr;
    }
  /**
   * `xs.sort()` → `tslib::array::sort_default(&mut xs)` (040). Default JS sort is
   * a lexicographic *string* compare, in place; the fidelity lives in `tslib`.
   */
  | { kind: "iterSortDefault"; receiver: HirExpr }
  /**
   * `xs.sort((a, b) => e)` → `tslib::array::sort_by(&mut xs, |a, b| e)` (040). The
   * comparator's numeric sign is mapped to an `Ordering` inside `tslib`; `a`/`b`
   * are plain (owned Copy) closure params.
   */
  | {
      kind: "iterSortBy";
      receiver: HirExpr;
      a: string;
      b: string;
      body: HirExpr;
    }
  /**
   * `Rc::new(RefCell::new(inner))` — construct a shared, interior-mutable value
   * (series 028b). Wraps a class constructor call in a `"use rc"` scope.
   */
  | { kind: "rcNew"; inner: HirExpr }
  /**
   * `Rc::clone(&expr)` — a new shared handle to the same value (series 028b).
   * Replaces a bare-move alias (`const b = a`) of an `rc` binding, so both
   * handles stay live and observe each other's interior mutations.
   */
  | { kind: "rcClone"; expr: HirExpr }
  /** `bumpalo::Bump::new()` — a bump arena for a `"use arena"` scope (series 028c). */
  | { kind: "bumpNew" }
  /**
   * `bumpalo::vec![in &<arena>; <elements>]` — a `Vec` built from a bump arena
   * (series 028c). Replaces a heap `array` literal in a `"use arena"` scope; the
   * arena binding name is `arena`.
   */
  | { kind: "bumpVec"; arena: string; elements: HirExpr[] };

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
  | { kind: "expr"; expr: HirExpr }
  /**
   * `if cond { conseq } [else …]`. `alt` is `null` for a bare `if`, a
   * one-element `[{kind:"if"…}]` for an `else if` chain, or the else block's
   * statements. (`conseq`, not `then`, to avoid thenable confusion.)
   */
  | { kind: "if"; cond: HirExpr; conseq: HirStmt[]; alt: HirStmt[] | null }
  | { kind: "while"; cond: HirExpr; body: HirStmt[] }
  /**
   * A bare, scope-containing `{ … }`. Emitted with no trailing `;`. The C-style
   * `for` desugar wraps its `init` + `while` in one so the loop variable's scope
   * is contained (see lower.ts).
   */
  | { kind: "block"; body: HirStmt[] }
  /**
   * `for <pat> in <iter> { body }`. `iter` is the already-borrowing iterator
   * (lowering bakes in `.iter()`), so the emitter renders it verbatim.
   */
  | { kind: "forIn"; pat: string; iter: HirExpr; body: HirStmt[] }
  /**
   * `for <counter> in <start>..<end> { body }` (`..=` when `inclusive`). An
   * idiomatic integer range, recovered from a canonical `usize` counting `for`
   * by `promoteRanges` (numeric.ts) — the counter's `let` and `+ 1` update are
   * folded into the range. `break`/`continue` render natively.
   */
  | {
      kind: "forRange";
      counter: string;
      start: HirExpr;
      end: HirExpr;
      inclusive: boolean;
      body: HirStmt[];
    }
  /**
   * `match <disc> { arms }`. A `switch` lowers here with **guarded wildcard**
   * arms (`_ if disc == case`) — Rust forbids `f64` literal patterns, so the
   * discriminant is compared in a guard rather than matched as a literal.
   */
  | { kind: "match"; disc: HirExpr; arms: HirMatchArm[] }
  | { kind: "break" }
  | { kind: "continue" }
  /**
   * `throw new Error(msg)` → `return Err(value);` (`value` is the message). Under
   * a `"use panic"` scope (series 028a) `panic` is set and it emits
   * `panic!("{}", value);` instead — no `Result`, no propagation.
   */
  | { kind: "throw"; value: HirExpr; panic?: boolean }
  /**
   * `try`/`catch`/`finally` — the recovery side of errors. Emitted as a
   * `Result`-returning IIFE closure (the `tryBody`, whose fallible calls/`throw`s
   * short-circuit *to the closure*), matched by `if let Err(<catchParam>) = … {
   * catchBody }`, with `finallyBody` (when present) emitted as sibling statements
   * after. `errTy` is the program error type the closure's `Result` carries
   * (`String`, or `Box<dyn Error>` under series 022).
   */
  | {
      kind: "tryCatch";
      tryBody: HirStmt[];
      catchParam: string | null;
      catchBody: HirStmt[];
      finallyBody: HirStmt[] | null;
      errTy: RustType;
    };

/**
 * One `match` arm. `guard` is `disc == case` (`null` is the wildcard `_`). When
 * `pat` is set — an integer-typed discriminant promoted by `promoteMatches` — the
 * arm is a **literal pattern** (`<pat> => …`) and the guard is cleared.
 */
export interface HirMatchArm {
  guard: HirExpr | null;
  pat?: HirExpr;
  body: HirStmt[];
}

// ── Items & module ───────────────────────────────────────────────────────────

/** A function parameter; `ty` already includes any `&`/`&mut` borrow form. */
export interface HirParam {
  name: string;
  ty: RustType;
}

/** A method's `self` receiver: `&self` (`ref`) or `&mut self` (`refMut`). */
export type SelfRecv = "ref" | "refMut";

export interface HirFn {
  kind: "fn";
  name: string;
  isAsync: boolean;
  params: HirParam[];
  /** `unit` for a `void`/unannotated function. */
  ret: RustType;
  body: HirStmt[];
  /** A `self` receiver when this is a class method; unset for free/associated fns. */
  recv?: SelfRecv;
}

/** A `struct` item lowered from an `interface` — a closed, named data shape. */
export interface HirStruct {
  kind: "struct";
  name: string;
  fields: { name: string; ty: RustType }[];
}

/**
 * A `class` — emitted as a `struct` (its `fields`) plus an `impl` holding the
 * associated constructor (`ctor`, a `new` with no receiver) and `methods` (each
 * carrying a `self` receiver).
 */
export interface HirClass {
  kind: "class";
  name: string;
  fields: { name: string; ty: RustType }[];
  ctor: HirFn | null;
  methods: HirFn[];
  /**
   * The lowered body of a `[Symbol.dispose]()` method (series 025), emitted as
   * `impl Drop for Name { fn drop(&mut self) { … } }` — RAII for a `using` binding.
   * `null` when the class is not disposable.
   */
  dispose?: HirStmt[] | null;
}

/**
 * A custom error class (`class X extends Error { constructor(message) {…} }`) —
 * emitted as a `struct X { message: String }` with an associated `new` and
 * `Display`/`Debug`/`std::error::Error` impls (series 022). The shape is fixed,
 * so the item carries only the name.
 */
export interface HirErrorClass {
  kind: "errorClass";
  name: string;
}

/**
 * A C-like `enum` (series 025). Variants are unit-only; `disc` carries an
 * explicit discriminant (`A = 1`) when the source gave one, else `null`. Emitted
 * with `#[derive(Clone, Copy, PartialEq)]` so a `switch`/guard can compare it.
 */
export interface HirEnum {
  kind: "enum";
  name: string;
  variants: { name: string; disc: number | null }[];
}

/** A top-level Rust item: a function, a struct, a class, an enum, or an error type. */
export type HirItem = HirFn | HirStruct | HirClass | HirErrorClass | HirEnum;

/**
 * A lowered module. Top-level *declarations* become `items`; top-level
 * *statements* become the body of a generated `fn main()` (`main`, empty when
 * there is no script). Mixing script with a user-defined `main` is rejected in
 * lowering, so those two never conflict here.
 */
export interface HirModule {
  items: HirItem[];
  main: HirStmt[];
  /**
   * The generated `fn main`'s return type. Absent ⇒ `()` (the common case). Set
   * to `Result<(), String>` when the top-level script propagates a throwing call
   * (or throws), so `main` can use `?` and end in `Ok(())`.
   */
  mainRet?: RustType;
  /**
   * Whether the generated `fn main` needs an async runtime. Absent/false ⇒ a
   * plain `fn main()`. `true` when the top-level script `await`s, so the entry is
   * emitted as `#[tokio::main] async fn main()` (composes with `mainRet`).
   */
  mainAsync?: boolean;
}
