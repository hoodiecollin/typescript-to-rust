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
   * `Option<inner>` — the dialect's nullability (series 042): `T | undefined`,
   * `T | null`, and optional properties/params all map here. `undefined` and
   * `null` both become `None`; a plain `T` flowing into an `Option` slot is
   * `Some`-wrapped.
   */
  | { kind: "option"; inner: RustType }
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
   * `AppError` — the whole-program synthesized error enum (series 049), the
   * program error type when any custom error class is declared, so `?` composes
   * across every fallible fn. Replaces series 022's `boxError`.
   */
  | { kind: "appError" }
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
  /**
   * A bare function pointer `fn(P1, P2, …) -> R` (series 048). The Rust value form
   * of a non-capturing function *value* — a top-level fn / normalized arrow passed
   * as an argument, stored, or returned. A `(a: A, b: B) => R` type annotation
   * lowers here; the pointer is `Copy`, so it is always passed by value.
   */
  | { kind: "fnPtr"; params: RustType[]; ret: RustType }
  /**
   * A trait object `dyn IA` (series 053c). Only ever valid behind a pointer —
   * `&dyn IA` (a `ref`) or `Box<dyn IA>` (a `box`); it is the polymorphic /
   * heterogeneous axis of class inheritance (the one place a vtable appears).
   */
  | { kind: "dyn"; trait: string }
  /**
   * `impl IA` (series 053b) — a monomorphic base-typed param, static dispatch,
   * zero-cost. Preferred over `dyn` whenever a base-typed position is used with a
   * single concrete subtype.
   */
  | { kind: "implTrait"; trait: string }
  /** `Box<inner>` (series 053c) — an owned heap box; carries a `dyn IA` for a
   * heterogeneous collection element (`Vec<Box<dyn IA>>`). */
  | { kind: "box"; inner: RustType }
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
  /**
   * `AppError::Foo { f: v, … }` — a struct-variant construction (series 049).
   * The construction site of a `throw new Foo(…)` (custom class → its variant) or
   * a plain/built-in throw (→ the `Other` variant). `enumName` is always
   * `AppError` today; kept explicit so the emitter stays a pure path join.
   */
  | {
      kind: "enumVariant";
      enumName: string;
      variant: string;
      fields: { name: string; value: HirExpr }[];
    }
  /**
   * `a?.b` → `a.map(|v| v.b)` → `Option<…>` (series 042d, single-level optional
   * member access). Deeper chains stay fail-loud.
   */
  | { kind: "optMember"; receiver: HirExpr; field: string }
  /** `JSON.stringify(v)` → `tslib::json::stringify(&v)` → `String` (series 045). */
  | { kind: "jsonStringify"; value: HirExpr }
  /**
   * `JSON.parse(s)` → `serde_json::from_str::<target>(&s).expect(...)` (series
   * 045). `target` is the annotated type (`Vec<f64>`, a struct, …), or `null` for
   * the untyped `serde_json::Value` fallback.
   */
  | { kind: "jsonParse"; source: HirExpr; target: RustType | null }
  /** `Some(value)` — a present optional (series 042). */
  | { kind: "some"; value: HirExpr }
  /** `None` — an absent optional, from `undefined`/`null` (series 042). */
  | { kind: "none" }
  /** `Ok(value)` — the success arm of a `Result`. `null` value ⇒ `Ok(())`. */
  | { kind: "ok"; value: HirExpr | null }
  /** `expr?` — propagate a fallible call's error to the enclosing `Result`. */
  | { kind: "try"; expr: HirExpr }
  /** `Box::new(value)` — a heterogeneous collection element upcast to `Box<dyn IA>`
   * (series 053c). */
  | { kind: "boxNew"; value: HirExpr }
  /** `expr.await` — suspend on a future (a call to an `async fn`) for its value. */
  | { kind: "await"; expr: HirExpr }
  /**
   * `tokio::join!(f0, f1, …)` — drives all `futures` concurrently, yielding a
   * tuple `(T0, T1, …)` of their resolved values (series 051a, fixed-arity
   * `Promise.all` of infallible async calls). Each future is a *bare* async call
   * (not individually awaited — the macro polls them).
   */
  | { kind: "join"; futures: HirExpr[] }
  /**
   * `tokio::try_join!(f0, f1, …)` — like `join!` but for fallible element
   * futures; yields `Result<(T0, T1, …), E>`, short-circuiting on the first
   * `Err`. Wrapped in a `{kind:"try"}` so the `?` propagates the tuple (series
   * 051a, `Promise.all` where any element is fallible).
   */
  | { kind: "tryJoin"; futures: HirExpr[] }
  /**
   * `tokio::select! { res = f0 => res, … }` — polls all `futures` concurrently
   * and yields the value of the *first* to complete (the losers are dropped).
   * All arms must unify to one output type `T` (series 051a, fixed-arity
   * `Promise.race`).
   */
  | { kind: "select"; futures: HirExpr[] }
  /**
   * `xs.map(p => body)` → `xs.iter().map(|p| cbName(*p, forwarded…)).collect::<Vec<_>>()`
   * (series 048). The callback body is lifted to a top-level `fn cbName` (whose
   * params are `p` plus the read-only free vars); the shim forwards `*p` (the Copy
   * element out of the `.iter()` borrow) and each free var by value.
   */
  | {
      kind: "iterMap";
      receiver: HirExpr;
      cbName: string;
      elemParam: string;
      forwarded: HirExpr[];
    }
  /**
   * `xs.filter(p => body)` →
   * `xs.iter().filter(|p| cbName(**p, forwarded…)).copied().collect::<Vec<_>>()`
   * (series 048). The predicate is lifted to a top-level `fn cbName -> bool`; the
   * shim forwards `**p` (the `&&T` a filter predicate receives).
   */
  | {
      kind: "iterFilter";
      receiver: HirExpr;
      cbName: string;
      elemParam: string;
      forwarded: HirExpr[];
    }
  /** `Object.keys(m)` → `m.keys().cloned().collect::<Vec<_>>()` → `Vec<String>` (041). */
  | { kind: "objectKeys"; map: HirExpr }
  /** `Object.values(m)` → `m.values().cloned().collect::<Vec<_>>()` → `Vec<V>` (041). */
  | { kind: "objectValues"; map: HirExpr }
  /**
   * `Object.entries(m)` → `m.iter().map(|(k, v)| (k.clone(), v.clone()))
   * .collect::<Vec<_>>()` → `Vec<(K, V)>`, in insertion order (series 043).
   */
  | { kind: "objectEntries"; map: HirExpr }
  /** `pair[0]` / `pair[1]` on an `entries` tuple → `<tuple>.0` / `.1` (series 043). */
  | { kind: "tupleField"; tuple: HirExpr; index: 0 | 1 }
  /**
   * A merged-map builder (series 044) — the shared lowering of `Object.assign`
   * and object spread `{ ...a, k: v }`. Emits a block expression that seeds a
   * `mut` `IndexMap` from `base` (or `IndexMap::new()` when null), applies each
   * part in order (a spread `extend`s a cloned source; an entry `insert`s), and
   * evaluates to the map. Later parts override earlier keys, matching JS.
   */
  | { kind: "mapBuild"; base: HirExpr | null; parts: MapBuildPart[] }
  /**
   * `xs.find(p => c)` → `xs.iter().find(|p| cbName(**p, forwarded…)).copied()` →
   * `Option<T>` (series 048; predicate lifted to `fn cbName -> bool`).
   */
  | {
      kind: "iterFind";
      receiver: HirExpr;
      cbName: string;
      elemParam: string;
      forwarded: HirExpr[];
    }
  /** `xs.some(p => c)` → `xs.iter().any(|p| cbName(*p, forwarded…))` → `bool` (048). */
  | {
      kind: "iterAny";
      receiver: HirExpr;
      cbName: string;
      elemParam: string;
      forwarded: HirExpr[];
    }
  /** `xs.every(p => c)` → `xs.iter().all(|p| cbName(*p, forwarded…))` → `bool` (048). */
  | {
      kind: "iterAll";
      receiver: HirExpr;
      cbName: string;
      elemParam: string;
      forwarded: HirExpr[];
    }
  /**
   * `xs.reduce((acc, x) => e, init)` →
   * `xs.iter().fold(init, |acc, x| cbName(acc, *x, forwarded…))` (series 048). The
   * callback is lifted to `fn cbName(acc, elem, free…)`; `acc` is the owned fold
   * accumulator (typed by `init`), `elem` copied out of the `.iter()` borrow.
   */
  | {
      kind: "iterReduce";
      receiver: HirExpr;
      cbName: string;
      acc: string;
      elem: string;
      forwarded: HirExpr[];
      init: HirExpr;
    }
  /**
   * `xs.sort()` → `tslib::array::sort_default(&mut xs)` (040). Default JS sort is
   * a lexicographic *string* compare, in place; the fidelity lives in `tslib`.
   */
  | { kind: "iterSortDefault"; receiver: HirExpr }
  /**
   * `xs.sort((a, b) => e)` →
   * `tslib::array::sort_by(&mut xs, |a, b| cbName(a, b, forwarded…))` (series 048).
   * The comparator is lifted to `fn cbName(a, b, free…) -> f64`; `tslib` maps its
   * numeric sign to an `Ordering`. `a`/`b` are owned Copy elements (no deref).
   */
  | {
      kind: "iterSortBy";
      receiver: HirExpr;
      cbName: string;
      a: string;
      b: string;
      forwarded: HirExpr[];
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

/** One step of a `mapBuild`: spread a whole source, or insert a single entry. */
export type MapBuildPart =
  | { kind: "spread"; expr: HirExpr }
  | { kind: "entry"; key: HirExpr; value: HirExpr };

// ── Statements ───────────────────────────────────────────────────────────────

export type HirStmt =
  | {
      kind: "let";
      name: string;
      mut: boolean;
      ty: RustType | null;
      init: HirExpr;
      /**
       * Tuple-destructuring binding names (series 051a): when present, the `let`
       * renders `let (a, b, …) = init` (no type annotation — Rust infers the
       * tuple), and `name`/`ty` are ignored. Set only for a `const [a, b] =
       * await Promise.all([…])` whose initializer is a `join!`/`try_join!` tuple.
       */
      names?: string[];
    }
  | { kind: "return"; value: HirExpr | null }
  | { kind: "expr"; expr: HirExpr }
  /**
   * `if cond { conseq } [else …]`. `alt` is `null` for a bare `if`, a
   * one-element `[{kind:"if"…}]` for an `else if` chain, or the else block's
   * statements. (`conseq`, not `then`, to avoid thenable confusion.)
   */
  | { kind: "if"; cond: HirExpr; conseq: HirStmt[]; alt: HirStmt[] | null }
  /**
   * `if let Some(binding) = scrutinee { someBody } [else { noneBody }]` — the
   * narrowing of an `Option` (series 042c). Lowered from `if (x !== undefined) {…}`
   * (and the `=== undefined` else-branch form), so `binding` shadows `scrutinee`
   * as the inner `T` inside `someBody`.
   */
  | {
      kind: "ifLet";
      binding: string;
      scrutinee: HirExpr;
      someBody: HirStmt[];
      noneBody: HirStmt[] | null;
    }
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
      /**
       * A recognized `instanceof` ladder (series 049c), pre-lowered to `match`
       * arms over the owned bound error. When present the emitter renders `if let
       * Err(e) = <closure> { match e { …arms } }` (no `downcast_ref`); when absent
       * the opaque `catchBody` path is unchanged.
       */
      discriminant?: HirCatchArm[];
    };

/**
 * One arm of a discriminating `catch` → `match` (series 049c). A `variant` arm
 * matches `AppError::<variant> { <binds>, .. }` (each read field bound owned); a
 * `wildcard` arm (from the trailing `else`, or the appended exhaustiveness `_`)
 * binds the whole error to `binder` (`other`) or ignores it (`_`).
 */
export type HirCatchArm =
  | { kind: "variant"; variant: string; binds: string[]; body: HirStmt[] }
  | { kind: "wildcard"; binder: string | null; body: HirStmt[] };

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
  /**
   * Class inheritance (series 053). When this class participates in an `extends`
   * relationship (as a subclass or a base), it carries a synthetic `base: A`
   * embed field (subclass only) plus the trait it implements (`implTrait`) and
   * which of that trait's methods it provides itself vs. inherits as a default
   * (`overrides`). `base` is prepended to `fields` so a struct literal reads
   * cleanly; `implTrait`/`overrides` drive the emitted `impl IA for Name` block.
   */
  base?: { field: "base"; ty: RustType };
  implTrait?: string;
  overrides?: Set<string>;
  /**
   * The trait accessors this class must provide for shared/base fields read
   * through a `dyn IA` (series 053c). Each maps a field name to the `&self`
   * projection that reaches it (`self.name` on the base class, `self.base.name`
   * on a subclass). Emitted as `fn <field>(&self) -> &Ty { <proj> }` in the
   * `impl IA for Name` block. Empty/absent when no field is read polymorphically.
   */
  accessors?: { field: string; ty: RustType; proj: HirExpr }[];
}

/**
 * A synthesized shared trait `IA` (series 053b) for a base class `A` that is
 * extended. Carries `A`'s public methods as **default bodies** (`methods`),
 * plus, on demand (series 053c), read-only accessor signatures for base fields
 * read through a `dyn IA` (`accessors`). Each per-class `impl IA for Name`
 * lives on the `HirClass`; the trait item holds only the shared surface.
 */
export interface HirTrait {
  kind: "trait";
  name: string;
  methods: HirFn[];
  accessors: { field: string; ty: RustType }[];
}

/**
 * The one synthesized whole-program error enum (series 049), replacing series
 * 022's per-class error structs. Each variant carries ordered typed fields
 * (`message: String` first) and a thiserror `#[error(display)]` string; the enum
 * derives `#[derive(thiserror::Error, Debug)]`. Synthesized once in `lower()`
 * from the declared custom error classes plus a fixed `Other { message }`
 * catch-all; absent entirely when no custom error class is declared.
 */
export interface HirErrorEnum {
  kind: "errorEnum";
  variants: {
    name: string;
    fields: { name: string; ty: RustType }[];
    display: string;
  }[];
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

/** A top-level Rust item: a function, a struct, a class, an enum, or the error enum. */
export type HirItem =
  | HirFn
  | HirStruct
  | HirClass
  | HirErrorEnum
  | HirEnum
  | HirTrait;

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
