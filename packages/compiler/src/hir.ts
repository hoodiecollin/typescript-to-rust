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
  /**
   * A signed 128-bit integer — the dialect's bitwise-operation type (series 056).
   * JS bitwise operators run on 32-bit ints; we deliberately widen to `i128`
   * (documented divergence, not JS-exact) so `<<` has headroom and `>>>`'s
   * unsigned-32 result fits. Only produced by `refineBitwise`.
   */
  | { kind: "i128" }
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
  /**
   * `IndexSet<elem>` — the `Set<T>` class (series 061), insertion-order preserving
   * like `IndexMap`. `elem` is `Hash + Eq` eligible (`String`, integer, gated
   * struct, or `OrderedFloat<f64>` for a scalar `f64`).
   */
  | { kind: "set"; elem: RustType }
  /**
   * `ordered_float::OrderedFloat<f64>` — a hashable/`Eq` `f64` for `Map`/`Set`
   * scalar-number keys/elements (series 061). Faithful to JS SameValueZero
   * (`NaN == NaN`, `-0.0`/`+0.0` collapse). Only ever a map key / set element.
   */
  | { kind: "orderedFloat" }
  /**
   * A named `struct` (from an `interface`/`class`); rendered as the bare name, or
   * `Name<A, …>` when `args` is present — a **generic instantiation** (series 081),
   * e.g. a generic class's constructor return type `Boxed<T>`. `args` is unset for
   * an ordinary non-generic struct.
   */
  | { kind: "struct"; name: string; args?: RustType[] }
  /**
   * The synthesized SameValueZero **key newtype** `<name>Key(<name>)` for a struct
   * used as a `Map` key / `Set` element that carries a (direct) `f64` field
   * (series 074). It wraps the user struct and carries custom `Hash`/`PartialEq`/
   * `Eq` impls that wrap each `f64` leaf in `OrderedFloat` at hash/eq time, so the
   * user struct keeps its raw `f64` fields and its `===`-faithful (NaN≠NaN) derived
   * `PartialEq`. Rendered as `<name>Key`; only ever a map key / set element type.
   */
  | { kind: "structKey"; name: string }
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
  /**
   * `std::sync::Arc<inner>` (a shared read handle) or, when `mutex`,
   * `std::sync::Arc<std::sync::Mutex<inner>>` (shared interior-mutable handle) —
   * series 051c increment 2's task-escape wrap. Produced only by
   * `refineTaskEscape` for a binding/param captured by a spawned task; emitted
   * fully qualified (no `use`).
   */
  | { kind: "arc"; inner: RustType; mutex: boolean }
  /**
   * A **type parameter** — a bare `T` in scope of a generic class/method/fn
   * declaration (series 081, the first user type variable). Rendered as the bare
   * name (`T`), and unchanged inside a wrapper (`Vec<T>`, `Option<T>`). Only ever
   * produced by `lowerType` when the name is in the enclosing generic scope
   * (`analysis.typeParams`); a name that is *not* in scope stays fail-loud (an
   * undeclared type). Opaque to the ownership/`Rc` passes (a `param` field is
   * move/clone by the derive bound).
   */
  | { kind: "param"; name: string }
  | { kind: "ref"; mut: boolean; inner: RustType }
  /**
   * `tslib::json::JsonValue` — the opt-in dynamic JSON value (series 090, epic
   * #59). A singleton (no inner type); the `serde(transparent)` newtype over
   * `serde_json::Value` carries an accessor surface
   * (`get`/`at`/`asNumber`/…/`length`). Reached only via the `@ttr/std`
   * `parseJsonValue`/`fromJsonValue`/`toJsonValue` boundary — it does not reopen
   * `any`. Not `Copy`, not a modeled map/set key (not hashable).
   */
  | { kind: "jsonValue" };

/**
 * The refined type of a numeric literal node. Absent ⇒ `f64` (the default). The
 * numeric-inference pass tags integer literals that reach a `usize` context, and
 * `i64` literals that drive an integer counter / `match` discriminant. Both
 * integer tags emit bare (no `.0` suffix); only `f64` integers need `.0`.
 */
export type NumericType = "f64" | "usize" | "i64" | "i128";

/**
 * How a lifted array-callback element crosses the shim boundary (series 057).
 * `"copy"` — a Copy element forwarded by value (`*p`, series 048). `"borrow"` — a
 * read-only non-Copy element forwarded by reference (`p`/`*p`, no clone). `"clone"`
 * — a consumed non-Copy element the lifted fn owns (`p.clone()`/`(*p).clone()`).
 */
export type ElemMode = "copy" | "borrow" | "clone";

/**
 * How a fused iter-adapter (series 104, #89) treats its receiver. Absent ⇒ the
 * shipped default: the receiver is a collection borrowed via `.iter()` (element is
 * `&T`). `"own"` ⇒ the receiver is a collection whose binding is dead after the
 * chain, moved via `.into_iter()` (element is owned `T`, 3c). `"iter"` ⇒ the
 * receiver is *already* an iterator (a fused upstream stage) — no `.iter()`, element
 * owned `T`. Both non-default modes drop the `filter`/`find` `.copied()`/`.cloned()`
 * terminal. Set by `refineIterFusion`.
 */
export type IterRecv = "own" | "iter";

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
  /**
   * A verbatim Rust snippet with no TS-source counterpart (series 076): the
   * `TNext` default `Default::default()` passed to `gen.resume(...)` when a bare
   * `gen.next()` drives a bidirectional generator forward. Emitted as-is.
   */
  | { kind: "raw"; text: string }
  | {
      kind: "binary";
      op: string;
      left: HirExpr;
      right: HirExpr;
      /**
       * A bitwise-origin binary (`& | ^ << >>`, series 056). Drives the emitter's
       * shift-count masking + inline `// bitwise: wide-int (i128)` divergence note
       * and marks the node as `i128`-typed. Absent for ordinary arithmetic/logical.
       */
      bitwise?: boolean;
      /**
       * Local integer-domain modulo (series 103a). Set by `refineNumerics` on an
       * `f64` `%` whose operands are provably integer-valued: the emitter renders it
       * `((<left> as i64) % (<right> as i64)) as f64` so the hot op is a hardware
       * integer modulo (const divisors become a multiply-shift) instead of a libm
       * `fmod` call. The binding stays `f64` — purely a local re-expression, no
       * signature ripple. Values beyond `i64` range take accepted `i64` semantics
       * (design 103, ruling 1).
       */
      intDomain?: boolean;
    }
  /**
   * A string concatenation (series 080): a JS `+` with a provably-string operand,
   * flattened into ordered `parts` and emitted as `format!("{}{}…", …)`. Sidesteps
   * `String`'s `Add<&str>` borrow/ownership rules and coerces non-string parts
   * (e.g. a number) via `Display`, matching JS's string coercion.
   */
  | { kind: "strConcat"; parts: HirExpr[] }
  /**
   * A plain-data-struct value interpolated into a template literal (series 095) —
   * `` `${point}` `` → the JS `String(object)` result `"[object Object]"`. Plain
   * structs derive only `Clone`+`Debug` (never `Display`), so this is the JS-faithful
   * render. Emitted as `{ let _ = &(<value>); String::from("[object Object]") }` so an
   * effectful `${…}` still evaluates while the value is borrowed, never moved.
   */
  | { kind: "jsObjectStr"; value: HirExpr }
  /**
   * A `++`/`--` (`UpdateExpression`) used in a **value** position (series 096) —
   * `const y = x++`, `arr[i++]`, `while (n-- > 0)`. `step` is the `+= 1`/`-= 1`
   * `assign` node (embedded so the numeric pass types its `1` as usize/f64 like any
   * `i += 1`). Emitted as a block-temp: postfix → `{ let __upd = <target>; <step>; __upd }`
   * (old value), prefix → `{ <step>; <target> }` (new value). Statement-position
   * `x++;` lowers directly to the `step` `assign` instead (no block-temp).
   */
  | { kind: "update"; prefix: boolean; target: HirExpr; step: HirExpr }
  /**
   * Variadic `Math.min(...)` / `Math.max(...)` (series 083) → a `min!`/`max!`
   * **macro** (the sanctioned Tm variadic route). Binary min/max lowers to native
   * `a.min(b)` instead; this node only carries the 1-or-3+-arg variadic form.
   * NaN-propagating like JS.
   */
  | { kind: "jsMinMax"; op: "min" | "max"; args: HirExpr[] }
  /** A prefix unary: `-x` (negation), `!x` (logical not), or bitwise-NOT `!x`
   * (series 056, `~` in TS → `!` in Rust; `bitwise` set). */
  | { kind: "unary"; op: string; operand: HirExpr; bitwise?: boolean }
  /**
   * A Rust deref `(*expr)` (series 050, #70). A cross-module `import def from "./m"`
   * of a **value** default binds a `LazyLock<T>` (Rc-wrapped for a non-scalar `T`);
   * a use of `def` derefs the lazy cell to the underlying value. Auto-deref then
   * carries method/field access through, and the ownership pass clones on an owned
   * use (a cheap `Rc::clone` for a non-scalar). Emitted parenthesized: `(*def)`.
   */
  | { kind: "deref"; expr: HirExpr }
  /**
   * `((value as u128) >> shift) as i128` — JS's logical (zero-fill) right shift
   * `>>>` (series 056). Its own node because, unlike the other bitwise operators,
   * it needs the `u128` round-trip cast a bare `binary` node cannot carry.
   */
  | { kind: "ushr"; value: HirExpr; shift: HirExpr }
  /** `(expr as ty)` — an explicit numeric cast at a type boundary (series 056):
   * an operand into `i128`, or an `i128` bitwise result back out to `f64`/`usize`. */
  | { kind: "cast"; expr: HirExpr; ty: RustType }
  | { kind: "assign"; op: string; target: HirExpr; value: HirExpr }
  /**
   * A ternary `cond ? a : b` (series 094) → Rust's `if`/`else` **expression**
   * (emitted parenthesized, `(if <test> { <conseq> } else { <alt> })`, since a
   * bare `if`-expr can't be a binary-operator operand). `test` is truthiness-lowered
   * exactly like an `if` statement (native `bool`, else `is_truthy`). The first
   * expression-position conditional — HIR already had a *statement* `if`.
   */
  | { kind: "cond"; test: HirExpr; conseq: HirExpr; alt: HirExpr }
  /** Direct call to a known function; args carry their borrow. */
  | { kind: "call"; callee: string; args: HirArg[] }
  /** `console.log(...)` → `println!` with a JS-style format string. */
  | { kind: "println"; args: HirExpr[] }
  /** `obj.method(args)` — receiver borrow is Rust's method-resolution problem. */
  | { kind: "method"; receiver: HirExpr; name: string; args: HirExpr[] }
  /**
   * A JS-operator trait-method call over a generic `T` (series 088):
   * `left.js_add(&right)` etc. The `right` operand is passed **by reference**
   * (`&`) — the tslib `ops` traits take `&Self` so dispatch composes with the
   * ownership passes (never moves out of a field). Emitted only when both operands
   * of an operator are the same `{kind:"param"}` T; concrete code uses native `binary`.
   */
  | { kind: "jsOp"; receiver: HirExpr; method: string; arg: HirExpr }
  /** `obj[index]` — Rust index, always `usize`. */
  | { kind: "index"; object: HirExpr; index: HirExpr }
  /** `obj.field` (non-method member access). */
  | { kind: "field"; object: HirExpr; name: string }
  /**
   * `arr.length` → `arr.len()`; a **string** receiver (series 098) sets
   * `chars: true` → `s.chars().count()` (JS counts UTF-16 code units; the dialect
   * counts Rust `char`s, consistent with the char-indexed `slice`/`charAt` model,
   * and diverges from a byte `.len()`).
   */
  | { kind: "len"; object: HirExpr; chars?: boolean }
  /** array literal → `vec![...]`. */
  | { kind: "array"; elements: HirExpr[] }
  /** record object literal → `IndexMap::from([(k, v), …])` (or `IndexMap::new()`). */
  | { kind: "hashmap"; entries: { key: HirExpr; value: HirExpr }[] }
  /** `new Map<K, V>()` → `IndexMap::<K, V>::new()` (series 061, turbofish so an
   * un-annotated `let` still infers). A non-empty `new Map([...])` / `new Map(entries)`
   * carries a `MapInit` (series 072): `literal` → `IndexMap::<K, V>::from([(k, v), …])`
   * (keys pre-wrapped), `iter` → `src.into_iter()[.map(…)].collect::<IndexMap<K, V>>()`. */
  | { kind: "mapNew"; key: RustType; value: RustType; init?: MapInit }
  /** `new Set<T>()` → `IndexSet::<T>::new()` (series 061). A non-empty `new Set([...])`
   * / `new Set(items)` carries a `SetInit` (series 072), mirroring `MapInit`. */
  | { kind: "setNew"; elem: RustType; init?: SetInit }
  /** `&expr` / `&mut expr` — an explicit borrow at a call site (`m.get(&k)`,
   * series 061). */
  | { kind: "ref"; mut: boolean; expr: HirExpr }
  /**
   * `(<iter>).collect::<Vec<_>>()` — materialize an iterator into a `Vec` (series
   * 065). The collecting consumers `[...g()]` (array spread) and `Array.from(g())`
   * over a generator's `impl Iterator`. The `Vec<_>` turbofish lets it stand
   * without a target-type annotation.
   */
  | { kind: "collectVec"; iter: HirExpr }
  /**
   * A manual generator step `it.next()` / `it.next(v)` read as `{ value, done }`
   * (series 075/076): `match <recv>.step() { GenStep::Yield(v) => (v, false),
   * GenStep::Return(v) => (v, true) }` — a `(value, done)` tuple, bound by a
   * tuple-destructure `let`. Requires the generator's `Y` and `R` to be the same Rust
   * type (so `value` is one type); otherwise lowering is fail-loud. For a
   * bidirectional generator (076) the driver is `<recv>.resume(<sent>)` — `sent` the
   * `.next(v)` send value, or `Default::default()` for a bare `.next()`.
   */
  | { kind: "genStepTuple"; recv: HirExpr; sent?: HirExpr | null }
  /**
   * A fixed-arity generator destructure `const [a, b] = g()` (series 075, rides
   * 067): a prefix pull off the generator's `impl Iterator` —
   * `{ let mut __it = <source>; (__it.next().unwrap(), …<arity>) }` — bound by a
   * tuple-destructure `let`. Each `.next().unwrap()` assumes the generator yields at
   * least `arity` values (an early exhaustion panics, matching a fail-loud contract;
   * JS would bind `undefined`, which the dialect has no model for).
   */
  | { kind: "genPrefixPull"; source: HirExpr; arity: number }
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
      /**
       * A **newtype** variant construction (series 093, stage 1d): `Shape::Circle(<expr>)`
       * — the single positional payload (an inner struct value for D, a primitive for
       * F/G). When set, `fields` is empty and the emitter renders `Path(<newtype>)`.
       */
      newtype?: HirExpr;
    }
  /**
   * A union-enum struct-variant **binding pattern** (series 093) used as a `match`
   * arm pattern: `Shape::Circle { r, .. }` (binds the read fields, `..` for the
   * rest) or a bare `Shape::Reset` for a unit variant. Distinct from `enumVariant`
   * (a *construction*); this is only ever a pattern.
   */
  | {
      kind: "varPat";
      enumName: string;
      variant: string;
      binds: string[];
      /** True for a struct variant (emit `{ … }`); false for a unit variant. */
      struct: boolean;
      /**
       * A **newtype** variant pattern (series 093, stage 1d): binds the single inner
       * payload under this name (`Shape::Circle(sh)`), or `"_"` to ignore it. When
       * set, `binds`/`struct` are unused.
       */
      newtypeBind?: string;
    }
  /**
   * `a?.b` → `a.map(|v| v.b)` → `Option<…>` (series 042d, single-level optional
   * member access). Deeper chains stay fail-loud.
   */
  | { kind: "optMember"; receiver: HirExpr; field: string }
  /**
   * `stringifyJson(v)` (the `@ttr/std` shim, series 084) → `tslib::json::stringify(&v)`
   * → `String`. Reuses the shipped 045 writer (JS number fidelity). The bare
   * `JSON.stringify` recognition was retired — this HIR now comes only from the shim.
   */
  | { kind: "jsonStringify"; value: HirExpr }
  /**
   * `parseJson<T>(s)` (the `@ttr/std` shim, series 084) →
   * `tslib::json::ParseResult::<T>::parse(&s)` → a `ParseResult<T>` carrying
   * `.ok`/`.value()`/`.error()`. `target` is the required modeled `T`. Replaces
   * the retired 045 `jsonParse` (bare `JSON.parse` is now fail-loud + redirected).
   */
  | { kind: "parseJson"; source: HirExpr; target: RustType }
  /**
   * `rng(seed)` (the `@ttr/std` shim, series 089) → `tslib::rng::Rng::new(<seed>)`
   * → a stateful `Rng` handle. The binding is emitted `let mut` (methods take
   * `&mut self`); `.next()`/`.int()`/`.pick()`/`.shuffle()` route through the
   * generic `method` HIR. Hand-rolled SplitMix64, mirrored in the TS shim so the
   * two streams match bit-for-bit.
   */
  | { kind: "rngNew"; seed: HirExpr }
  /**
   * `fromJsonValue<T>(v)` (the `@ttr/std` shim, series 090) →
   * `tslib::json::ParseResult::<T>::from_value(<v>.0)` → a `ParseResult<T>` (the
   * 084 surface), the dynamic→static crossing. `value` is the `JsonValue` expr
   * (`.0` unwraps the transparent newtype into a `serde_json::Value`); `target` is
   * the required modeled `T`, validated by `assertModeledParseTarget`.
   */
  | { kind: "fromJsonValue"; value: HirExpr; target: RustType }
  /**
   * `toJsonValue<T>(x)` (the `@ttr/std` shim, series 090) →
   * `tslib::json::JsonValue(serde_json::to_value(&<x>).expect("toJsonValue"))` →
   * the static→dynamic crossing. `value` is the modeled source expr (lowered with
   * its `<T>` type so an object literal becomes a struct literal).
   */
  | { kind: "toJsonValue"; value: HirExpr }
  /**
   * The retired 045 `JSON.parse` node — no longer produced (bare `JSON.parse`
   * redirects to `parseJson<T>`). Kept as a variant only so the `usesJson` scan
   * and the exhaustive HIR switches stay total until a cleanup series removes it.
   */
  | { kind: "jsonParse"; source: HirExpr; target: RustType | null }
  /** `Some(value)` — a present optional (series 042). */
  | { kind: "some"; value: HirExpr }
  /** `None` — an absent optional, from `undefined`/`null` (series 042). */
  | { kind: "none" }
  /**
   * `tslib::fmt_opt(&expr)` (series 066) — `console.log` render of an `Option<T>`:
   * `Some(v)` → the `v` render, `None` → the literal `undefined`. Returns a
   * `String`, so it drops into a `println!("{}", …)` slot.
   */
  | { kind: "optDisplay"; value: HirExpr }
  /**
   * `expr.unwrap()` (series 066) — the non-null assertion `x!` (design D). Explicit
   * opt-in; panics on `None`, one step earlier than JS's `TypeError` at the access.
   */
  | { kind: "unwrapOpt"; value: HirExpr }
  /**
   * `tslib::is_truthy(&expr)` (series 066) — the shared JS-truthiness predicate
   * (design E), used where a non-`bool` operand sits in a `bool` position: an
   * `if (x)` / `while (x)` condition, or a `!x` operand. A `bool` operand is left
   * native and never wrapped.
   */
  | { kind: "isTruthy"; value: HirExpr }
  /**
   * JS `a || b` / `a && b` returning the *operand value* (not a `bool`) under JS
   * falsy semantics (series 066, design E): `{ let __t = a; if is_truthy(&__t)
   * <keep> { __t } else { b } }`. `||` keeps the truthy operand; `&&` keeps the
   * falsy operand / evaluates `b` when `a` is truthy. Only emitted when an operand
   * is non-`bool` (bare-boolean `||`/`&&` stay native short-circuit `binary`).
   */
  | { kind: "truthyLogical"; op: "||" | "&&"; left: HirExpr; right: HirExpr }
  /** `Ok(value)` — the success arm of a `Result`. `null` value ⇒ `Ok(())`. */
  | { kind: "ok"; value: HirExpr | null }
  /** `expr?` — propagate a fallible call's error to the enclosing `Result`. */
  | { kind: "try"; expr: HirExpr }
  /**
   * `match <expr> { Ok(__v) => __v, Err(__e) => break '<label> Err(__e) }` (series
   * 063) — the `?` equivalent inside a `tryBlock`'s labeled block, which cannot use
   * `?` (not a function boundary). Unwraps `Ok`, or breaks the block with the error.
   */
  | { kind: "tryBreak"; label: string; expr: HirExpr; carrier?: boolean }
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
   * A Rust tuple expression `(e0, e1, …)` (series 067). Emitted for a fixed-arity
   * array-literal source of an array-destructuring binding (`const [a, b] = [x, y]`
   * → `let (a, b) = (x, y)`), where the element count is statically known.
   */
  | { kind: "tuple"; elems: HirExpr[] }
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
   * `|a, b| body` — an inline closure (series 051b). The dynamic fan-out
   * inline form `ids.map(id => fetchRow(id))` emits `|id| fetch_row(id)`, whose
   * future type Rust infers (no lift, no typer).
   */
  | { kind: "closure"; params: string[]; body: HirExpr }
  /**
   * `futures::future::join_all(iter).await` — drives a `Vec` of same-typed
   * futures to a `Vec<T>` (series 051b, dynamic `Promise.all(arr.map(f))` over
   * infallible element futures, and `Promise.allSettled` over fallible ones,
   * where each future's output is already `Result<T, String>`).
   */
  | { kind: "joinAll"; iter: HirExpr }
  /**
   * `futures::future::try_join_all(iter).await` — like `join_all` but for
   * fallible element futures; yields `Result<Vec<T>, E>`, short-circuiting on
   * the first `Err`. Wrapped in a `{kind:"try"}` so the `?` propagates the
   * `Vec` (series 051b, dynamic `Promise.all` over fallible fan-out).
   */
  | { kind: "tryJoinAll"; iter: HirExpr }
  /**
   * `tokio::time::sleep(std::time::Duration::from_millis(ms as u64))` — the
   * dialect's one modeled delay primitive (series 051b, `await sleep(ms)`).
   * Wrapped in a `{kind:"await"}` to suspend on it.
   */
  | { kind: "sleep"; ms: HirExpr }
  /**
   * `tokio::spawn(<expr>)` → schedules `<expr>` (a bare async call, or an
   * `asyncMove` block) as an eagerly-polled task, yielding a `JoinHandle<T>`
   * (series 051c increment 1). Maps an un-awaited async call (previously
   * fail-loud) and the `setTimeout` delayed task. The spawned future is
   * `Send + 'static`, so its captures are moved in — increment 1 admits only
   * Copy args / a single owned move-in; shared capture stays fail-loud
   * (increment 2 adds the `Arc`/`Arc<Mutex>` task-escape pass).
   */
  | { kind: "spawn"; expr: HirExpr }
  /**
   * `<expr>.await.unwrap()` — await a `JoinHandle` for its task's value (series
   * 051c increment 1). Distinct from the plain `await` node so the emitter picks
   * `.await.unwrap()` (a `JoinHandle`'s `.await` yields `Result<T, JoinError>`;
   * `.unwrap()` surfaces a task panic — a documented divergence).
   */
  | { kind: "joinHandleAwait"; expr: HirExpr }
  /**
   * `async move { <stmts> }` — an owned-capture async block (series 051c
   * increment 1), the body of a `setTimeout`'s spawned delayed task
   * (`sleep(ms).await;` then the lifted `fn` body).
   */
  | { kind: "asyncMove"; stmts: HirStmt[] }
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
      /**
       * How the element crosses the shim boundary (series 057). `"copy"` forwards
       * `*p` (a Copy element, series 048); `"borrow"` forwards `p` (a read-only
       * non-Copy `&T`, no clone); `"clone"` forwards `p.clone()` (a consumed
       * non-Copy element, owned by the lifted fn).
       */
      elemMode: ElemMode;
      /**
       * The name of the callback's index parameter `(el, i)` when present (series
       * 057) — the shim becomes `.iter().enumerate().map(|(i, p)| …)` and `i:
       * usize` is threaded before the forwarded free vars. Absent → single-param.
       */
      indexParam?: string;
      /** Fused (series 104): drop the terminal `.collect::<Vec<_>>()` — this stage
       * feeds another adapter, so it stays a lazy iterator. */
      lazy?: boolean;
      /** Fused (series 104): how the receiver is consumed — see `IterRecv`. */
      recvIter?: IterRecv;
    }
  /**
   * `Array.from(src, fn)` — the mapping overload (series 075), reusing 057's
   * callback lift. `<src>.map(cb).collect::<Vec<_>>()` when `fromIterator` (a
   * generator's `impl Iterator` is already an iterator), else
   * `<src>.iter().map(cb).collect::<Vec<_>>()` (an array source). The `(x, i)` index
   * overload adds `.enumerate()` (forwarding `i as f64`), exactly like `iterMap`.
   */
  | {
      kind: "arrayFromMap";
      source: HirExpr;
      fromIterator: boolean;
      cbName: string;
      elemParam: string;
      indexParam?: string;
      forwarded: HirExpr[];
      elemMode: ElemMode;
    }
  /**
   * `xs.filter(p => body)` →
   * `xs.iter().filter(|p| cbName(**p, forwarded…)).copied().collect::<Vec<_>>()`
   * (series 048). The predicate is lifted to a top-level `fn cbName -> bool`; the
   * shim forwards `**p` (the `&&T` a filter predicate receives). For a non-Copy
   * element the terminal is `.cloned()` and the deref follows `elemMode` (057).
   */
  | {
      kind: "iterFilter";
      receiver: HirExpr;
      cbName: string;
      elemParam: string;
      forwarded: HirExpr[];
      elemMode: ElemMode;
      /** Fused (series 104): drop the terminal `.copied()/.collect::<Vec<_>>()`. */
      lazy?: boolean;
      /** Fused (series 104): how the receiver is consumed — see `IterRecv`. */
      recvIter?: IterRecv;
    }
  /**
   * `xs.flatMap(p => [..])` →
   * `xs.iter().flat_map(|p| cbName(<elem>, forwarded…)).collect::<Vec<_>>()`
   * (series 085). The callback returns a `Vec<U>` (its lifted `fn cbName -> Vec<U>`);
   * `flat_map` flattens one level so the result is `Vec<U>`, matching JS's `U[]`
   * result. Same shim/element shape as `iterMap` minus the index param — `flatMap`
   * is single-param only.
   */
  | {
      kind: "iterFlatMap";
      receiver: HirExpr;
      cbName: string;
      elemParam: string;
      forwarded: HirExpr[];
      elemMode: ElemMode;
      /** Fused (series 104): drop the terminal `.collect::<Vec<_>>()`. */
      lazy?: boolean;
      /** Fused (series 104): how the receiver is consumed — see `IterRecv`. */
      recvIter?: IterRecv;
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
      elemMode: ElemMode;
      /** Fused (series 104): how the receiver is consumed — see `IterRecv`. */
      recvIter?: IterRecv;
    }
  /** `xs.some(p => c)` → `xs.iter().any(|p| cbName(*p, forwarded…))` → `bool` (048). */
  | {
      kind: "iterAny";
      receiver: HirExpr;
      cbName: string;
      elemParam: string;
      forwarded: HirExpr[];
      elemMode: ElemMode;
      /** Fused (series 104): how the receiver is consumed — see `IterRecv`. */
      recvIter?: IterRecv;
    }
  /** `xs.every(p => c)` → `xs.iter().all(|p| cbName(*p, forwarded…))` → `bool` (048). */
  | {
      kind: "iterAll";
      receiver: HirExpr;
      cbName: string;
      elemParam: string;
      forwarded: HirExpr[];
      elemMode: ElemMode;
      /** Fused (series 104): how the receiver is consumed — see `IterRecv`. */
      recvIter?: IterRecv;
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
      /** Fused (series 104): how the receiver is consumed — see `IterRecv`. */
      recvIter?: IterRecv;
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
  | { kind: "bumpVec"; arena: string; elements: HirExpr[] }
  /**
   * `bumpalo::collections::String::from_str_in(<value>, &<arena>)` — a `String`
   * built from a bump arena (series 087). Replaces a heap `string` literal in a
   * `"use arena"` scope; `.len()`/`.push_str` work unchanged on it, so only
   * construction differs. `value` is the raw string literal (rendered quoted).
   */
  | { kind: "bumpString"; arena: string; value: string }
  /**
   * `std::sync::Arc::clone(&name)` — a fresh shared handle to a task-escaping
   * capture, moved into a spawned task (series 051c increment 2, the
   * inter-procedural task-escape pass). Replaces a bare-move spawn arg once the
   * pass proves the binding must be wrapped (`Arc`/`Arc<Mutex>`).
   */
  | { kind: "arcClone"; name: string }
  /**
   * `<expr>.lock().unwrap()` — acquire the `Mutex` guard of an `Arc<Mutex<T>>`
   * (series 051c increment 2). Composes under `field`/`assign`/deref: a field
   * read `counter.n` becomes `counter.lock().unwrap().n` (`field` over a
   * `lockAccess`), and a whole-value scalar read `counter` becomes
   * `*counter.lock().unwrap()` (`unary "*"` over a `lockAccess`). Only ever
   * produced by the task-escape pass over a `Arc<Mutex<T>>`-wrapped binding.
   */
  | { kind: "lockAccess"; expr: HirExpr };

/** One step of a `mapBuild`: spread a whole source, or insert a single entry. */
export type MapBuildPart =
  | { kind: "spread"; expr: HirExpr }
  | { kind: "entry"; key: HirExpr; value: HirExpr };

/**
 * A non-empty `new Map([...])` / `new Map(entries)` initializer (series 072).
 * `literal` — an array literal of `[k, v]` pairs → `IndexMap::from([(k, v), …])`
 * (keys already `wrapKey`-wrapped at lower time). `iter` — an array-typed variable
 * / expression → `src.into_iter()[.map(|(k, v)| (wrap(k), v))].collect::<IndexMap<…>>()`
 * (`wrap` present only when the key needs `OrderedFloat`/newtype wrapping).
 */
export type MapInit =
  | { kind: "literal"; entries: { key: HirExpr; value: HirExpr }[] }
  | { kind: "iter"; source: HirExpr; wrapKey: boolean };

/** A non-empty `new Set([...])` / `new Set(items)` initializer (series 072), mirroring
 * `MapInit`: `literal` → `IndexSet::from([…])`, `iter` → `.into_iter()[.map(wrap)].collect()`. */
export type SetInit =
  | { kind: "literal"; elems: HirExpr[] }
  | { kind: "iter"; source: HirExpr; wrapElem: boolean };

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
      /**
       * A struct-pattern destructuring binding (series 067): when present, the
       * `let` renders `let <pat> = init` — a Rust struct pattern like
       * `Point { x, y }` from `const { x, y } = point`. `name` is still set (to the
       * first field, so liveness re-defines it) but `pat` takes over emission and
       * `ty` is null (the field types come from the source struct). Set only for an
       * object-pattern over a named-struct source.
       */
      pat?: string;
      /**
       * A task-escape share wrap (series 051c increment 2): the binding is shared
       * into ≥2 spawned tasks (or one task and reused by the parent), so its
       * declaration is wrapped. `"arc"` → `std::sync::Arc::new(<init>)` (shared
       * read); `"arcMutex"` → `std::sync::Arc::new(std::sync::Mutex::new(<init>))`
       * (shared mutation). Populated by `refineTaskEscape`; drives `emitStmt`.
       */
      share?: "arc" | "arcMutex";
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
  | { kind: "while"; cond: HirExpr; body: HirStmt[]; label?: string }
  /**
   * A bare, scope-containing `{ … }`. Emitted with no trailing `;`. The C-style
   * `for` desugar wraps its `init` + `while` in one so the loop variable's scope
   * is contained (see lower.ts).
   */
  /**
   * `fromForContinue` (series 064) tags a block that the C-`for` desugar wraps
   * around a `continue` to inline the loop update (`{ i = i + 1; continue; }`), so
   * the counter still advances in the `while` fallback. When the loop is promoted
   * to a `forRange` (which advances natively), `promoteRanges` strips the inlined
   * update back to a bare `continue`. The tag makes that strip unambiguous — it
   * never touches a user-written `{ …; continue; }` block.
   */
  | { kind: "block"; body: HirStmt[]; fromForContinue?: boolean }
  /**
   * `for <pat> in <iter> { body }`. `iter` is the already-borrowing iterator
   * (lowering bakes in `.iter()`), so the emitter renders it verbatim. `mode`
   * (series 064) selects the for-of element ownership: `"ref"` iterates `&xs`
   * (default), `"refMut"` iterates `&mut xs`, `"owned"` consumes `xs` (valid when
   * `xs` is dead after the loop), and `"cloned"` iterates `xs.iter().cloned()`
   * (owned elements, `xs` still live) — the same borrow/clone/consume call 057
   * makes for callback elements. `label` (series 064) is the loop's lifetime label.
   */
  | {
      kind: "forIn";
      pat: string;
      iter: HirExpr;
      body: HirStmt[];
      mode?: "ref" | "refMut" | "owned" | "cloned";
      label?: string;
    }
  /**
   * **Mutate-during-iteration over an aliased container** (series 077 / issue #41).
   * The 062 panic pattern — iterating a field held in an `Rc<RefCell<T>>` alias
   * closure while the body mutates the *same* cell — lowered to an **index-based
   * re-borrow** loop that holds **no** borrow across the body, so `RefCell` never
   * panics and JS's live-cursor semantics are reproduced.
   *
   * `owner` is the borrow expression for the iterated cell (an `Rc<RefCell<T>>`
   * ident); `field` the container field on its borrowed inner struct. `shape` routes
   * the template:
   *   - `"array"` — a live positional walk (`items[i]`, `len()` re-read each step).
   *   - `"map"` / `"set"` — a stable key-snapshot `Vec` + a growing `__added`
   *     append-buffer + a `__seen` once-guard, draining in two phases with a
   *     per-step `contains`/`get` recheck (deletes skipped, value read live). Visible
   *     inserts in `body` were instrumented (an `__added.push`) by `refineRc`;
   *     `addedKeys` names the pushed-key exprs so the emitter wires the buffer.
   *
   * `body` is the already-`rc`-rewritten loop body. `binder`/`keyBinder`/`valBinder`
   * carry the loop pattern (a single element name for array/set, the `(k, v)` pair
   * for a map). `keyPat` optionally wraps a struct-key newtype (series 074).
   */
  | {
      kind: "forInReborrow";
      shape: "array" | "map" | "set";
      owner: HirExpr;
      field: string;
      body: HirStmt[];
      /** Array/Set element (or Map value) binder name. */
      binder: string;
      /** Map key binder name (absent for array/set). */
      keyBinder?: string;
      /** Struct-key newtype wrapper for the key (series 074), e.g. `PointKey`. */
      keyNewtype?: string;
      /** Struct-key newtype wrapper for a set element (series 074). */
      elemNewtype?: string;
      /**
       * The key/element type (Map key / Set element), for the `__keys`/`__added`
       * snapshot-`Vec` annotations so a delete-only loop (no push) still type-checks.
       * Absent for the array shape (element type inferred by the positional read).
       */
      keyType?: RustType;
      label?: string;
    }
  /**
   * `for <counter> in <start>..<end> { body }` (`..=` when `inclusive`). An
   * idiomatic integer range, recovered from a canonical counting `for` by
   * `promoteRanges` (numeric.ts) — the counter's `let` and update are folded into
   * the range. `break`/`continue` render natively. Series 064 extends it beyond
   * the ascending unit step: `descending` renders `(start..=end).rev()`; a `step`
   * ≠ 1 renders `.step_by(step)`; `label` is the loop's lifetime label.
   *
   * `counterTy` is the counter's numeric type: `usize` (the index-driven default,
   * series 020) or `i64` (a pure-integer counter, series 103b-2). An `i64` counter
   * pins its range element type with a literal suffix (`0i64..N`) so Rust does not
   * default the range to `i32`.
   */
  | {
      kind: "forRange";
      counter: string;
      start: HirExpr;
      end: HirExpr;
      inclusive: boolean;
      body: HirStmt[];
      descending?: boolean;
      step?: number;
      label?: string;
      counterTy?: "usize" | "i64";
    }
  /**
   * `match <disc> { arms }`. A `switch` lowers here with **guarded wildcard**
   * arms (`_ if disc == case`) — Rust forbids `f64` literal patterns, so the
   * discriminant is compared in a guard rather than matched as a literal.
   */
  | { kind: "match"; disc: HirExpr; arms: HirMatchArm[] }
  | { kind: "break"; label?: string }
  | { kind: "continue"; label?: string }
  /**
   * A generator state-machine suspend point (series 052). Inside a
   * `HirGenerator`'s `next()` arms only: `self.state = <resumeState>; return
   * Some(<value>);`. The suspend primitive is deliberately template-parameterized
   * (a nameable node, CFG/liveness agnostic to `next` vs a future `poll_next`) so
   * an async-generator (`Stream`) series can reuse the CFG/liveness/field-carry.
   */
  | { kind: "yieldReturn"; value: HirExpr; resumeState: number }
  /**
   * A generator state-machine transition (series 052): `self.state = <state>;`.
   * The enclosing `loop { match self.state { … } }` re-enters the target arm in
   * the same `next()` call (a straight-through, non-suspending step).
   */
  | { kind: "gotoState"; state: number }
  /**
   * A generator state-machine terminal (series 052): `self.state = <terminal>;
   * return None;`. Parks the machine in its exhausted state so every subsequent
   * `next()` also returns `None`. When `retValue` is present (a `return <value>`,
   * series 075) it stashes `self.__ret = Some(<value>);` before parking so `step()`
   * can `take()` it as the `GenStep::Return` payload. `hasRet` records that the
   * generator has a non-`()` `R` (a `__ret` field exists), so a value-less terminal
   * still returns `GenStep::Return(self.__ret.take()…)` rather than `Return(())`.
   */
  | { kind: "genDone"; terminal: number; retValue?: HirExpr; hasRet?: boolean }
  /**
   * The head of a **resumed** arm of a bidirectional generator (series 076): binds
   * the sent value to the `const x = yield e` target — `self.<target> =
   * self.__sent.take().unwrap();`. `resume(&mut self, sent)` stashes `self.__sent =
   * Some(sent)` before the loop; the resumed arm `take()`s it. State 0 has no
   * pending yield, so the first-resume value is discarded (matching JS).
   */
  | { kind: "genResumeBind"; target: string }
  /**
   * `yield* <iter>` delegation (series 065). A delegating state in the 052 machine:
   * lazily seeds a boxed delegate iterator field (`self.<field> =
   * Some(Box::new(<iter>))` on first entry), then pumps `self.<field>.next()` —
   * `Some(v)` re-yields `v` (stays in this state), `None` clears the field and
   * transitions to `resumeState`. `<iter>` is `<expr>.into_iter()` boxed.
   */
  | {
      kind: "yieldStarStep";
      field: string;
      iter: HirExpr;
      resumeState: number;
      /**
       * A read `yield*` completion value (series 075 — `const r = yield* inner()`):
       * the delegate is boxed as `dyn Steppable` and pumped via `.step()`; on
       * `GenStep::Return(rv)` the payload binds to `resultTarget` before advancing.
       * When unset the 065 `dyn Iterator` + `.next()` box is kept byte-for-byte.
       */
      readResult?: boolean;
      resultTarget?: string;
    }
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
    }
  /**
   * `try`/`catch`/`finally` lowered to a **labeled block** (series 063) rather than
   * an IIFE closure — used when a `try`/`catch` arm natively `return`s / `break`s /
   * `continue`s (value-yielding / escaping), or for `try`/`finally` with no
   * handler. The `tryBody`'s `?`/`throw` are rewritten to `break '<label> Err(…)`
   * (a labeled block is *not* a function boundary, so `return`/`break`/`continue`
   * escape the enclosing fn/loop natively). Emitted as `let __<label>:
   * Result<(), E> = '<label>: { tryBody; Ok(()) };` then a `match` (`catchBody`) or
   * finally-then-propagate (`catchBody` null). `finally` + an escaping jump is
   * fail-loud (its own follow-on), so `finallyBody` is only ever present without an
   * escape.
   */
  | {
      kind: "tryBlock";
      label: string;
      tryBody: HirStmt[];
      catchParam: string | null;
      catchBody: HirStmt[] | null;
      finallyBody: HirStmt[] | null;
      errTy: RustType;
      discriminant?: HirCatchArm[];
      /**
       * The `try` body always diverges (every path `return`s / `break`s /
       * `continue`s), so the normal-completion `Ok(_)` match arm is unreachable —
       * emitted as `unreachable!()` so the `match` unifies to `!` (and the value-
       * yielding fn's tail type-checks). When false, `Ok(_) => {}` falls through.
       */
      okUnreachable?: boolean;
    }
  /**
   * `break '<label> Err(<value>);` (series 063) — a `throw` inside a `tryBlock`'s
   * `try` body exits the labeled block with the error instead of returning.
   */
  | { kind: "breakTry"; label: string; value: HirExpr }
  /**
   * `try`/`catch`/`finally` where an escaping jump (`return`/`break`/`continue`)
   * co-occurs with a `finally` (series 073, the committed carrier follow-on to
   * 063). A native escape would skip the trailing `finally`, but JS runs it — so
   * this one construct lowers to a per-construct **control carrier**. Each escape
   * in the arms records its intent and breaks to the wrapper label (`'<label>`);
   * the `finally` body runs natively, once, after the wrapper block; then a
   * dispatch `match` replays the recorded escape. A self-escaping `finally`
   * pre-empts the pending action (it runs before the dispatch), matching JS.
   * Emitted with a local `enum Ctrl` item (and a `BreakTarget` enum when
   * break/continue escapes exist). Reserved strictly to finally+escape — every
   * other try/catch shape stays on 063's `tryBlock`.
   */
  | {
      kind: "carrierTry";
      label: string;
      /**
       * With a `catch` handler, the `try` arm's `?`/`throw` break this inner
       * `'try_N` block (bare `Err`) so the `catch` sees them; `null` for the
       * no-handler shape (they break the carrier `'<label>` directly with `Err`).
       */
      innerTryLabel: string | null;
      tryBody: HirStmt[];
      catchParam: string | null;
      /** `null` for `try`/`finally` with no handler. */
      catchBody: HirStmt[] | null;
      /** Always present (finally+escape is the whole point of this node). */
      finallyBody: HirStmt[];
      errTy: RustType;
      /** The enclosing fn's return **inner** type — the `Return(V)` payload. */
      retTy: RustType;
      /** The `Return`/`Normal` dispatch arms `Ok`-wrap when the scope is fallible. */
      fallible: boolean;
      /** A `return` escape needs the `Return` variant / dispatch arm. */
      hasReturn: boolean;
      /**
       * An error can escape the whole construct (a carrier-level `throw`/`?` in a
       * *fallible* scope) → the `Ctrl::Err` variant / `return Err(..)` dispatch arm.
       * A `catch` that fully handles the error leaves the scope non-fallible, so no
       * `Err` propagates and this is false.
       */
      hasErr: boolean;
      /** Distinct `break` targets (a label, or `null` for the nearest loop). */
      breakTargets: (string | null)[];
      /** Distinct `continue` targets (a label, or `null` for the nearest loop). */
      continueTargets: (string | null)[];
      /**
       * The `try` body can complete normally (fall through to `Ctrl::Normal`); when
       * every path escapes, the fall-through is unreachable and `Normal` is elided.
       */
      tryFallsThrough: boolean;
      /**
       * The `finally` body unconditionally escapes (a self-escaping `finally`), so
       * the dispatch is dead code and is suppressed — the native `finally` already
       * pre-empted the carrier.
       */
      dispatchDead: boolean;
      /** A recognized `instanceof` ladder catch (049c), pre-lowered to match arms. */
      discriminant?: HirCatchArm[];
      /**
       * Nesting (series 073): when this carrier sits inside an *outer* carrier arm,
       * its dispatch replays each escape into the outer carrier's wrapper (`break
       * '<outerLabel> Ctrl::…`) rather than natively — so the outer `finally` still
       * runs. `null` for the outermost carrier (native dispatch).
       */
      outerLabel?: string | null;
    }
  /**
   * An escape recorded into the 073 carrier — `break '<label> Ctrl::<Kind>(…);`.
   * `return v` → `Ctrl::Return(v)`; `break L`/`continue L` → `Ctrl::Break(…)` /
   * `Ctrl::Continue(…)` carrying the `BreakTarget` variant; a `throw`/`?` reuses
   * `breakTry`'s `Ctrl::Err` shape via `carrierErr`.
   */
  | {
      kind: "carrierBreak";
      label: string;
      ctrl: "Return" | "Break" | "Continue";
      /** The `Return` payload (the returned value / `null` for `return;`). */
      value?: HirExpr | null;
      /** The `Break`/`Continue` target label (or `null` for the nearest loop). */
      target?: string | null;
    }
  /**
   * `break '<label> Ctrl::Err(<value>);` (series 073) — a `throw`/`?` inside a
   * carrier `try`/`catch` records the error into the carrier instead of a bare
   * `Err` (063's `breakTry`). Separate kind so `rewriteTryBreaks` targets it.
   */
  | { kind: "carrierErr"; label: string; value: HirExpr };

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
 *
 * Series 064 adds two literal-pattern shapes for folded `switch` cases (guard also
 * cleared): `pats` is an **or-pattern** (`a | b | c => …`, consecutive cases that
 * share a body); `rangePat` is a **range pattern** (`lo..=hi => …`, a contiguous
 * integer run). Exactly one of `pat` / `pats` / `rangePat` is set on a
 * literal-pattern arm.
 */
export interface HirMatchArm {
  guard: HirExpr | null;
  pat?: HirExpr;
  pats?: HirExpr[];
  rangePat?: { lo: HirExpr; hi: HirExpr };
  body: HirStmt[];
}

// ── Items & module ───────────────────────────────────────────────────────────

/** A function parameter; `ty` already includes any `&`/`&mut` borrow form. */
export interface HirParam {
  name: string;
  ty: RustType;
  /**
   * A destructuring binding pattern (series 058) — e.g. `Point { x, y }` for a
   * `({x, y}: Point)` param. When present the emitter renders `<pat>: <ty>` instead
   * of `<name>: <ty>`; `name` is a synthetic placeholder unused by the emitter.
   */
  pat?: string;
}

/**
 * A method's `self` receiver: `&self` (`ref`), `&mut self` (`refMut`), or an owned
 * `self` (`owned`) — a **consuming** method that moves a non-`Copy` field out of
 * `this` with no subsequent `self` use (series 068). An owned receiver drops the
 * 038 field clone; the emitter renders it as a bare `self`.
 */
export type SelfRecv = "ref" | "refMut" | "owned";

export interface HirFn {
  kind: "fn";
  name: string;
  /** Rust visibility (series 050); absent ⇒ private. Also carried on a class
   * method for cross-module dispatch. */
  vis?: Vis;
  isAsync: boolean;
  params: HirParam[];
  /** `unit` for a `void`/unannotated function. */
  ret: RustType;
  body: HirStmt[];
  /** A `self` receiver when this is a class method; unset for free/associated fns. */
  recv?: SelfRecv;
  /**
   * The method's/function's own declared type parameters (series 081), e.g. the
   * `U` of `first<U>(xs: U[]): U`. Rendered as `<U, …>` right after the fn name in
   * the signature. Unset (or empty) for a non-generic fn. A generic class's own
   * `<T>` is *not* repeated here — it lives on the enclosing `impl<T>` block.
   */
  generics?: string[];
}

/**
 * A generic type parameter of a class/struct (series 081): its `name` (`T`) plus,
 * for `<T extends I>`, the behavioral-interface trait `bound` (`IShape`, via
 * 071 `traitNameOf`). A single behavioral-interface bound is in scope; a class
 * bound / multi-bound is fail-loud in lowering. Rendered `<T>` / `<T: IShape>` on
 * both the `struct` and the `impl` block.
 */
export interface GenericParam {
  name: string;
  bound?: string;
  /**
   * JS-operator trait bounds unioned onto this param (series 088), each a
   * fully-qualified tslib trait path (`tslib::ops::JsAdd`). Demand-driven: a body
   * adds a bound only for the operators it actually uses over a same-`T` pair (`+`
   * → `JsAdd`, `<` → `JsOrd`, `===` → `JsEq`). Deduplicated + order-stable.
   * Rendered after the interface `bound` (and, on the inherent impl, before
   * `Clone`). Absent for a param no operator touches.
   */
  opBounds?: string[];
}

/** A `struct` item lowered from an `interface` — a closed, named data shape. */
export interface HirStruct {
  kind: "struct";
  name: string;
  /** Rust visibility (series 050); absent ⇒ private. */
  vis?: Vis;
  /**
   * Each field's `omitIfNone` (series 091): its declared nullishness is
   * `undefined`-only (`x?: T` / `x: T | undefined`, no `null` arm), so a `None`
   * value must be omitted from JSON — the emitter adds
   * `#[serde(skip_serializing_if = "Option::is_none")]`. A `null`-bearing field
   * keeps the key (serializes `null`); "null wins" for `T | null | undefined`.
   * `vis` (series 050): a `pub(crate)` field for a cross-module struct literal.
   */
  fields: { name: string; ty: RustType; omitIfNone?: boolean; vis?: Vis }[];
  /**
   * Generic type parameters (series 081) — present for a `class Box<T>`'s emitted
   * struct (`struct Box<T>` / `struct Box<T: IShape>`). Interface-lowered structs
   * are non-generic (no `generics`). Rendered on the `struct` header.
   */
  generics?: GenericParam[];
  /**
   * Interface inheritance (series 059): when this struct's interface participates
   * in an `extends` relationship, it implements a getter trait `IA` for the
   * extended base `A`. `getters` are the base's fields, each emitted as a by-value
   * getter `fn x(&self) -> Tx { self.x.clone() }` in the `impl IA for Name` block
   * (the base's fields are flattened into this struct, so `self.x` always exists).
   */
  implTraits?: { trait: string; getters: { field: string; ty: RustType }[] }[];
  /**
   * This struct is used as a `Map` key / `Set` element (series 061), so it derives
   * `Hash, PartialEq, Eq` (its field eligibility was enforced at collection time).
   */
  hashEq?: boolean;
  /**
   * Object-literal interface synthesis (series 071 increment 2): a per-literal
   * nominal struct standing in for `const s: Shape = { area: () => 5 }`. Its data
   * fields are ordinary; each method literal is stored as an **`fn`-pointer field**
   * (non-capturing). `litImpl` records the behavioral trait it satisfies and, for
   * every trait method, the fn-ptr field to invoke — emitted as
   * `impl ITrait for Name { fn m(&self, …) -> R { (self.m)(…) } }`. Absent for an
   * ordinary struct/interface.
   */
  litImpl?: {
    trait: string;
    methods: { sig: HirFn; field: string }[];
    getters: { field: string; ty: RustType }[];
  };
}

/**
 * A synthesized SameValueZero **key newtype** `<name>Key(<struct>)` (series 074) —
 * the actual `Map`/`Set` key type for a struct with a (direct) `f64` field. It
 * wraps the user struct (`struct PointKey(Point);`) and carries custom
 * `Hash`/`PartialEq`/`Eq` impls that wrap each `f64` leaf in `OrderedFloat` at
 * hash/eq time, so the wrapped struct keeps its raw `f64` fields (arithmetic
 * untouched) and its `===`-faithful derived `PartialEq` (NaN≠NaN). Non-`f64`
 * fields compare/hash with plain `==`/`.hash()`. `Clone`/`Debug` derive via the
 * wrapped struct. One per distinct f64-bearing key struct.
 */
export interface HirStructKey {
  kind: "structKey";
  /** The newtype name (`<struct>Key`). */
  name: string;
  /** The wrapped user struct's name (`self.0: <struct>`). */
  struct: string;
  /** The wrapped struct's fields, in order, each flagged whether it is an `f64` leaf. */
  fields: { name: string; f64: boolean }[];
}

/**
 * A `class` — emitted as a `struct` (its `fields`) plus an `impl` holding the
 * associated constructor (`ctor`, a `new` with no receiver) and `methods` (each
 * carrying a `self` receiver).
 */
export interface HirClass {
  kind: "class";
  name: string;
  /** Rust visibility (series 050); absent ⇒ private. */
  vis?: Vis;
  fields: { name: string; ty: RustType; vis?: Vis }[];
  ctor: HirFn | null;
  methods: HirFn[];
  /**
   * Generic type parameters (series 081): `class Box<T>` → `[{name:"T"}]`,
   * `class Boxed<T extends Shape>` → `[{name:"T", bound:"IShape"}]`,
   * `class Pair<A, B>` → `[{name:"A"},{name:"B"}]`. Drives `<T, …>` /
   * `<T: IShape, …>` on the emitted `struct` and the inherent `impl` block.
   * Unset/empty for a non-generic class (byte-for-byte unchanged emission).
   */
  generics?: GenericParam[];
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
  /**
   * Behavioral-interface conformance (series 071): `class C implements I` for a
   * behavioral/mixed interface `I`. Each entry is emitted as a distinct
   * `impl I<I> for C { <getters> <method forwarders> }` block — getters clone a
   * data field (mixed interface), method forwarders call the class's inherent
   * method (`fn m(&self) -> R { self.m(args) }`; inherent resolution wins, so no
   * recursion). Distinct from the single 053 inheritance `implTrait`.
   */
  interfaceImpls?: {
    trait: string;
    methods: HirFn[];
    getters: { field: string; ty: RustType }[];
  }[];
  /**
   * `static` methods (series 060) → associated `fn`s with no `self` receiver,
   * emitted in the inherent `impl`. A call site `Type.m(args)` → `Type::m(args)`.
   */
  statics?: HirFn[];
  /**
   * `static` fields (series 060) → associated `const`s (`const NAME: Ty = value;`)
   * in the inherent `impl`. A read site `Type.NAME` → `Type::NAME`.
   */
  staticConsts?: { name: string; ty: RustType; value: HirExpr }[];
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
  /** Rust visibility (series 050); absent ⇒ private. */
  vis?: Vis;
  methods: HirFn[];
  accessors: { field: string; ty: RustType }[];
  /**
   * By-value getter signatures for an interface-inheritance trait (series 059):
   * `fn x(&self) -> Tx;`. Distinct from `accessors` (class field accessors, which
   * return `&Tx`) — an interface getter returns an owned clone so a base-typed
   * `&impl IA` param can read `a.x` as a value with no deref dance.
   */
  byValueAccessors?: { field: string; ty: RustType }[];
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
  /** Rust visibility (series 050); absent ⇒ private. */
  vis?: Vis;
  variants: { name: string; disc: number | null }[];
}

/**
 * A union-type enum (series 093) — a TS union `A | B | …` lowered to a Rust
 * `enum`. Distinct from the C-like {@link HirEnum} (source `enum` decls): variants
 * may carry **struct fields** (a discriminated object union `{kind:"c",r} | …` →
 * `Circle { r: f64 }`) and a **literal** union (`"n" | "s"`, `1 | 2`) emits a
 * `Display` impl round-tripping each fieldless variant to its original source
 * literal (`Dir::North => write!(f, "north")`). `name` is the `type` alias name,
 * or `__anonymous_union_<hash>` for an inline/anonymous union (structurally deduped).
 */
export interface HirUnionVariant {
  /** Sanitized Rust-ident variant name (e.g. `"has-dash"` → `HasDash`). */
  name: string;
  /** Struct-variant fields; empty for a fieldless (literal / discriminant-only) variant. */
  fields: { name: string; ty: RustType }[];
  /**
   * A **newtype** variant's single inner type (series 093, stage 1d) — a
   * named-interface member `Circle(Circle)` (D) or a primitive/mixed member
   * `Str(String)` (F/G). When set, `fields` is empty and the variant emits
   * `Name(<inner>)` instead of a struct/unit variant.
   */
  newtype?: RustType;
  /** The original source literal for `Display` round-trip; null for a non-literal variant. */
  display: string | null;
  /**
   * The discriminant value this variant matches on (a discriminated object union,
   * stage 1b) — the string form of `{kind:"circle"}`'s `"circle"`. Drives
   * construction (an object literal → its variant) and `switch(x.kind)` matching.
   * Absent for a literal union (its `display` already is the match key).
   */
  discValue?: string;
}

export interface HirUnionEnum {
  kind: "unionEnum";
  name: string;
  /** Rust visibility (series 050); absent ⇒ private. */
  vis?: Vis;
  variants: HirUnionVariant[];
  /** Emit an `impl Display` round-tripping each variant to its `display` (literal unions). */
  displayImpl: boolean;
  /** The derive list (`["Clone", "Copy", "PartialEq"]` for a fieldless literal union). */
  derives: string[];
  /**
   * The discriminant field name for a discriminated object union (stage 1b) —
   * `"kind"` for `{kind:"circle",…} | …`. Absent for a literal union.
   */
  discField?: string;
  /**
   * How a value of this union is narrowed at consumption (series 093, stage 1d/1e):
   * `"typeof"` for a primitive/mixed union F (`typeof x === "string"`), `"in"` for a
   * non-discriminated object union E (`"a" in x`). Absent for literal (match on the
   * value) and discriminated (`discField`) unions.
   */
  narrow?: "typeof" | "in";
}

/**
 * A generator state machine (series 052) — the resumable lowering for a
 * `function*` whose body has loops / branches / non-`yield` statements (the
 * straight-line finite-yield shape stays the 035 `vec![…].into_iter()` `HirFn`).
 * Emitted as a `struct` (`state: u32` + carried params + across-yield locals) +
 * `impl New` + `impl Iterator for … { fn next(&mut self) { loop { match
 * self.state { … } } } }` + the public `fn <name>(…) -> impl Iterator<Item = T>`
 * wrapper. See docs/work/_archive/052-generator-state-machines/.
 */
export interface HirGenerator {
  kind: "generator";
  /** The public wrapper fn name (the source `function*` name, e.g. `range`). */
  name: string;
  /** Rust visibility of the public wrapper fn (series 050); absent ⇒ private. */
  vis?: Vis;
  /** The generated state-machine struct name (e.g. `RangeGen`). */
  structName: string;
  /** `Item = T` — from the `Generator<T>` / `IterableIterator<T>` annotation. */
  item: RustType;
  /**
   * The completion type `R` (series 075) — the 2nd `Generator<Y, R>` type arg, else
   * inferred from a `return <value>`; bare `return` / fall-off is `()` (unit). Backs
   * the `GenStep::Return(R)` payload and the `Steppable<Y, R>` / `step()` surface.
   */
  retTy: RustType;
  /**
   * Whether this generator is consumed by a manual `step()` surface (series 075 —
   * `it.next()` / destructure / read `yield*`). When true the public wrapper fn
   * returns the **concrete struct** (which impls both `Iterator` and `Steppable`)
   * rather than an opaque `impl Iterator` (which would hide `step()`); `for-of` /
   * `.collect()` still compose (the struct is `IntoIterator` via its `Iterator`).
   */
  exposesStep: boolean;
  /**
   * Whether any state carries a `return <value>` payload (series 075). When true a
   * `__ret: Option<R>` field is emitted and `step()` `take()`s it at the terminal;
   * when false every terminal is `Return(())` and no field is needed.
   */
  hasReturnValue: boolean;
  /** The wrapper fn / `new` params; each is also a struct field (captured owned). */
  params: HirParam[];
  /**
   * Locals that are **live across a yield** and so must survive suspend/resume as
   * struct fields (a loop counter, an accumulator). Initialized to
   * `Default::default()` in `new` and overwritten by their defining state arm.
   */
  localFields: { name: string; ty: RustType }[];
  /** The `match self.state` arms, in order (each a state number + its body). */
  states: { id: number; body: HirStmt[] }[];
  /** The reserved terminal state number (the `_ => return None` arm). */
  terminal: number;
  /**
   * `yield*` delegate fields (series 065/075) — one per delegating state. An unread
   * completion (`steppable: false`) is `Option<Box<dyn Iterator<Item = Y>>>`, seeded
   * lazily and pumped to exhaustion (065, byte-for-byte). A read completion
   * (`steppable: true`, `const r = yield* inner()`) is `Option<Box<dyn Steppable<Y,
   * Rd>>>` pumped via `.step()`, its `Return` payload bound (series 075).
   */
  delegateFields: { name: string; steppable: boolean; delegateRet: RustType }[];
  /**
   * Whether this generator **reads** a `yield` result (`const x = yield e`) and is
   * therefore bidirectional (series 076). When true the struct gains an inherent
   * `resume(&mut self, sent: TNext) -> GenStep<Y, R>` (the value-**in** driver) and a
   * `__sent: Option<TNext>` field, and `step()` / `impl Iterator` route through
   * `resume(<default>)` (when `nextDefaultable`). When false the generator stays on
   * 075's pull-only `step()` driver, byte-for-byte.
   */
  bidirectional: boolean;
  /** The resume-in type `TNext` (series 076) — the `resume` param / `__sent` field. */
  nextTy: RustType;
  /**
   * Whether `TNext` is **defaultable** — lowers to `Option<T>` (the 066 undefined
   * model, default `None`). When true the bidirectional generator keeps `impl
   * Iterator` / `step()` (routed through `resume(<default>)`), so `for-of` / spread /
   * `.collect()` still compose; when false the struct is `resume`-only.
   */
  nextDefaultable: boolean;
}

/**
 * An item's Rust visibility (series 050). `undefined`/`"priv"` render nothing (a
 * module-private item); `"pub(crate)"` and `"pub"` prefix the keyword. Inferred by
 * `lowerCrate` from each module's exported set + signature-reachability closure;
 * absent (private) for every single-file fast-path item, so emission is unchanged.
 */
export type Vis = "pub" | "pub(crate)" | "priv";

/**
 * A module-level lazy value item (series 050, #70) — a `export default <value>`
 * whose default has no fn/class analog (`export default 42 / [1,2,3] / {…} / fn()`).
 * Emitted as `pub(crate) static <name>: LazyLock<<ty>> = LazyLock::new(|| <init>);`,
 * evaluated once on first access (TS module-eval-once). A non-scalar payload is
 * `Rc`-wrapped (`LazyLock<Rc<T>>`, init `Rc::new(<value>)`) so a cross-module
 * consumer's owned use is a cheap `Rc::clone`, not a deep copy.
 */
export interface HirLazyStatic {
  kind: "lazyStatic";
  /** The item name (the reserved `__default_export`, aliased from a hashed name). */
  name: string;
  /** Rust visibility (series 050); a crate default export is widened to `pub(crate)`. */
  vis?: Vis;
  /** The payload type `T` (the value's inferred type; NOT the `Rc`/`LazyLock` wrapper). */
  ty: RustType;
  /** True when `T` is non-scalar → stored as `Rc<T>` for cheap clone-on-use. */
  rc: boolean;
  /** The initializer expression, evaluated once inside the `LazyLock::new(|| …)`. */
  init: HirExpr;
}

/** A top-level Rust item: a function, a struct, a class, an enum, or the error enum. */
export type HirItem =
  | HirFn
  | HirStruct
  | HirStructKey
  | HirClass
  | HirErrorEnum
  | HirEnum
  | HirUnionEnum
  | HirTrait
  | HirGenerator
  | HirLazyStatic;

/**
 * A non-entry crate module (series 050) — one TS file → one Rust source file at
 * `modPath` (`src/foo.rs`, `src/util/math.rs`). Emitted as its own file: a `use`
 * prelude (its `./`-relative imports → `use crate::…;`) + its `items`. The crate
 * root declares it (`mod foo;`) to wire the file in. A `namespace Foo { … }`
 * (Axis 4) also lowers to a `HirMod` with `inline: true` — an inline `mod foo {
 * … }` rendered *within* its parent file rather than as a separate source file.
 */
export interface HirMod {
  kind: "mod";
  /** The module's Rust name — the file stem / namespace name, sanitized (`rid`). */
  name: string;
  /** The nested module path from the crate root (`["util","math"]`). */
  modPath: string[];
  /** `use crate::…;` lines emitted at the top of the module file/block. */
  uses: string[];
  items: HirItem[];
  /**
   * An **inline** `mod name { … }` (a `namespace`, Axis 4) rendered inside its
   * parent file, not a separate source file. Absent/false ⇒ a real module file.
   */
  inline?: boolean;
  /** A generated `pub use` **facade** module (Axis 3): `items` is empty and `uses`
   * carries the `pub use crate::…;` re-export lines. */
  facade?: boolean;
}

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
   * The crate's non-entry modules (series 050). Present only for a multi-file
   * crate lowered by `lowerCrate`; absent for every single-file `lower()` result
   * (so the fast-path emission is byte-for-byte unchanged). The emitter writes one
   * `.rs` file per real (non-`inline`) mod and declares each with `mod name;` at
   * the crate root.
   */
  mods?: HirMod[];
  /**
   * `use crate::…;` lines for the crate ROOT (the entry file's `./`-relative
   * imports). Present only for a multi-file crate; absent single-file.
   */
  uses?: string[];
  /**
   * Non-fatal compiler diagnostics (series 056) accumulated during lowering —
   * the first channel between "emit" and fail-loud `UnsupportedError`. The CLI
   * prints these to stderr. Currently only the bitwise wide-int divergence note.
   */
  warnings?: string[];
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
