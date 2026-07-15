# 088 — Operators on a generic `T` via a uniform tslib JS-operator trait layer

> **Status: SHIPPED (2026-07-15).** Issue **#62**. All three slices landed together
> (specs `GOP1–GOP9`, `packages/compiler/tests/generic-operators.test.ts`).
> Graduates the operators-on-`T` fail-loud from series 081. This was a **from-scratch
> redesign** — an earlier patchwork attempt (native `+` / one-off `JsPlus` / a
> `<T extends number>` constraint) was rejected as inconsistent ("three mechanisms
> for one concept"). Dialect calls made with Collin 2026-07-14.
>
> **Shipped:**
> - **tslib `ops` module** (`crates/tslib/src/ops.rs`): the seven `Js*` traits +
>   `impl_js_ops!` macro; impls for `f64` (all), `String` (`JsAdd`=concat, `JsOrd`,
>   `JsEq`), `bool` (`JsOrd`, `JsEq`). Emitted path is `tslib::ops::…` (matching the
>   existing emitted-Rust tslib convention — the design's `t2r::` was shorthand).
> - **Arithmetic + `+` concat**, **ordering**, **equality** over a **same-`{kind:
>   "param"}` T** → a `jsOp` HIR node (`receiver.js_add(&arg)`, by-reference), with
>   the operator's bound (`T: tslib::ops::JsAdd`) unioned onto the class's
>   `GenericParam.opBounds` (demand-driven) and rendered by the shared `paramBoundStr`
>   emitter alongside the interface bound + `Clone`.
> - **Per-struct `JsEq`** — every `PartialEq`-deriving struct/class emits
>   `impl tslib::ops::JsEq for S { … self == o … }` unconditionally (cheap, guarded by
>   the derive set so it always compiles), enabling structural `===` over a struct-`T`.
>
> **Implementation notes / where the design under-specified:**
> - `paramTypeOfOperand` was extended to recognize a `this.<field>` member operand
>   (the emission case `this.v + o`), not just a bare identifier — the 081 guard only
>   handled identifiers, so it silently miscompiled `this.v + 1` and `this.v && o`.
> - `collectStructFields` now resolves a class's own `<T>` so a `param`-typed field
>   (`v: T`) is recorded (else `this.v` was unresolvable and every operator fell
>   through to native `binary`).
> - `bindingTypes` is a flat name-keyed map, so two methods with same-named params of
>   different type-params (`addA(o: A)` / `ltB(o: B)`) collided. Fixed by seeding
>   *this method's* param types into `bindingTypes` for the body's duration
>   (`seedMethodParamTypes` / `withSeededBindings`).
> - The logical (`&&`/`||`) path had **no** param guard; added one (truthiness of an
>   opaque `T` is unknowable → fail-loud, a later slice).
>
> **Residuals still fail-loud (guards `GOP7`/`GOP8`):** mixed operands (`this.v + 1`,
> `t < 5`); logical / bitwise / compound over a bare `T`; a same-`T` operator on a
> **method's own `<U>`** (no operator-bound slot on a bare-`<U: Clone>` fn clause).
> Type-illegal uses (`String`-minus, struct arithmetic, struct-`===` without
> `PartialEq`) surface as loud rustc bound errors (documented, never a miscompile).
>
> **Documented divergence (`GOP5`):** `===` over a struct-`T` is structural (Rust)
> vs identity (JS) — the same edge the dialect accepts for concrete struct `===`.
>
> **Retargeted 081 CG8** in place: it now asserts the still-loud mixed-operand case
> (`this.v + 1`) instead of the wholesale operator-on-`T` fail-loud.
>
> Spec-first: this `design.md` → RED `specs.md` → impl → archive (done).

## Problem

Series 081 shipped monomorphized class generics but fails loud on **any operator
applied to a bare type parameter `T`** (`a + b`, `a < b`, `a === b` where
`a,b: T`). A single monomorphized Rust body can't dispatch on the operands'
runtime type, and — more fundamentally — **Rust has no native operator bound that
spans the types JS `+`/`<`/`===` accept** (`String: Add<&str>`, not `Add<String>`;
no single `Add` covers both `f64` and `String`). So native operators can't express
generic JS-operator semantics at all.

## Guiding principle — a JS-value runtime layer, isolated in tslib

**Inside a generic body, a bare `T` is a JS value; every operator on it lowers to a
single tslib "JS-operator" trait layer.** We deliberately do **not** chase idiomatic
Rust here — generic bodies emit trait-method calls, not native operators. Concrete
(non-generic) code is **completely untouched** and stays idiomatic (native `+`,
existing string-concat path, struct-eq, etc.).

This is the **Rust-side mirror of the std-shim isolation boundary**: every
JS-operator quirk lives in one macro-generated tslib layer instead of being smeared
across the emitter. It is zero-cost (rustc inlines each trait method) and uniform —
**one mechanism for all operators**, no native/trait/constraint split.

## The trait layer (tslib)

One trait per operator (fine granularity is *forced*: `String` supports `+` but not
`-`, so arithmetic can't be a single bound). Because **both operands are the same
`T`**, arithmetic returns `Self` and comparison/equality returns `bool` — so **no
associated `Output` type is needed**; bounds are bare (`T: JsAdd`).

Dispatch is **by reference** (`&self, &Self`) so it composes with the ownership
passes — never move out of a field.

```rust
// crates/tslib — module `ops`; impls macro-generated (see below)
pub trait JsAdd { fn js_add(&self, rhs: &Self) -> Self; }   // + : f64 add / String concat
pub trait JsSub { fn js_sub(&self, rhs: &Self) -> Self; }   // - : f64 only
pub trait JsMul { fn js_mul(&self, rhs: &Self) -> Self; }   // * : f64 only
pub trait JsDiv { fn js_div(&self, rhs: &Self) -> Self; }   // / : f64 only
pub trait JsRem { fn js_rem(&self, rhs: &Self) -> Self; }   // % : f64 only
pub trait JsOrd { fn js_lt(&self,&Self)->bool; fn js_le(&self,&Self)->bool;
                  fn js_gt(&self,&Self)->bool; fn js_ge(&self,&Self)->bool; } // < <= > >=
pub trait JsEq  { fn js_eq(&self,&Self)->bool; fn js_ne(&self,&Self)->bool; } // === !==
```

### Which types implement what (encodes JS's type rules)

| type | JsAdd | JsSub/Mul/Div/Rem | JsOrd | JsEq |
| --- | --- | --- | --- | --- |
| `f64` | ✅ add | ✅ | ✅ numeric | ✅ |
| `String` | ✅ concat | ❌ | ✅ lexicographic | ✅ |
| `bool` | ❌ | ❌ | ✅ (`false<true`) | ✅ |
| user `struct` (derives `PartialEq`) | ❌ | ❌ | ❌ | ✅ **structural** |

- `JsAdd` for `String` = `format!("{self}{rhs}")`; for `f64` = `self + rhs`.
- `JsEq` for a `struct` = structural (delegates to the struct's derived `PartialEq`),
  consistent with the existing concrete struct-eq series. Emitted **only** for
  structs that carry `PartialEq` in their derive set (`derives.ts`), so the impl
  always compiles.
- Impls are generated by a `macro_rules!` (`impl_js_ops!`) to avoid boilerplate;
  the per-`String` `js_add`/`js_ord` and per-struct `js_eq` are the specialized arms.

## Decisions (2026-07-14, with Collin)

### 1. The uniform trait layer is the sole mechanism
Every operator over a bare `T` → its tslib trait method. No native operators, no
`JsPlus`-style one-offs, no separate numeric constraint.

### 2. The trait bound *is* the constraint — `<T extends number>` does NOT exist
No new TS syntax. The author writes plain `<T>` and uses operators; **legality is
enforced by which types implement which trait.** A generic method using `-` bounds
`T: JsSub`, which only `f64` satisfies, so a `String` instantiation fails **at the
bound** (loud, never miscompiled). "Numeric-only arithmetic" is thus encoded in the
tslib impl set, not in the validator.

### 3. Scope v1 — arithmetic + comparison + equality
`+ - * / %`, `< > <= >=`, `=== !==`. Logical (`&& || !`), bitwise, and compound
assignment (`+=`) over a bare `T` stay fail-loud (existing behavior), a later slice.

### 4. Structural `===` for a struct-typed `T`
`JsEq` is implemented for user structs (structural), so `===`/`!==` work over a
struct-instantiated `T`. `JsOrd`/arithmetic are **not** implemented for structs
(→ loud bound error if misused).

### 5. Bounds are demand-driven
A body adds a bound only for the operators it actually uses (`+` → `T: JsAdd`; `<`
→ `T: JsOrd`; `===` → `T: JsEq`), unioned onto the scope's generic clause (reusing
081's `Clone`-bound machinery). Keeps clauses minimal.

## Emission

```ts
class Box<T> {
  v: T;
  combine(o: T): T { return this.v + o; }
  before(o: T): boolean { return this.v < o; }
  same(o: T): boolean { return this.v === o; }
}
```
```rust
struct Box<T: t2r::JsAdd + t2r::JsOrd + t2r::JsEq> { v: T }
impl<T: t2r::JsAdd + t2r::JsOrd + t2r::JsEq> Box<T> {
    fn combine(&self, o: T) -> T   { self.v.js_add(&o) }
    fn before(&self, o: T) -> bool { self.v.js_lt(&o) }
    fn same(&self, o: T) -> bool   { self.v.js_eq(&o) }
}
```
- `new Box(5).combine(3)` → `8`; `new Box("a").combine("b")` → `"ab"`; both from one
  unconstrained `T`. Differential-matches JS.
- The emitted tslib path (`t2r::…`) matches the existing tslib import/alias
  convention used elsewhere in emitted Rust.

## What stays fail-loud (with guard specs)

- **Mixed operands** — an operator where the two sides are **not the same `T`**
  (`this.v + 1`, `t < 5`, `a` is `T` and `b` is `U`): the JS coercion case
  (`"a"+1`→`"a1"`), out of scope → our `UnsupportedError`. Only *both-operands-the-
  same-type-param* routes to the trait layer.
- **Logical/bitwise/compound** over a bare `T` → fail-loud (existing), later slice.
- **Type-illegal use surfaced by rustc** (loud, documented, NOT our error, never a
  miscompile): `- * / %` on a `String`-instantiated `T` (`String: JsSub` unmet); `+`
  or ordering on a struct-instantiated `T`; `===` on a struct-`T` whose struct lacks
  `PartialEq`.

### Documented JS ⇄ Rust edges (accepted)
- `<`/`>` on a `String`-`T`: Rust orders by UTF-8 bytes (≡ Unicode scalar); JS by
  UTF-16 code units — differ only for astral (non-BMP) chars.
- `===` on a struct-`T` is **structural** (Rust) vs identity (JS) — the same edge the
  dialect already accepts for concrete struct `===`.

## Mechanism (reuse map)

- **tslib** — new `ops` module: the seven traits + `impl_js_ops!` macro; impls for
  `f64`/`String`/`bool`; export the traits. Struct `JsEq` impls are emitted with each
  qualifying struct (compiler side), not in tslib.
- **`paramTypeOfOperand`** (081) already identifies a bare-`T` operand. Extend the
  binary-expression lowering: if **both** sides are the same `{kind:"param"}` → emit
  the trait-method call and register the operator's bound; if exactly one side is a
  bare `T` → the mixed-operand fail-loud; else the existing concrete path.
- **Bounds** — extend 081's per-type-param bound set (currently `Clone`) with
  `JsAdd`/`JsSub`/…/`JsOrd`/`JsEq`; rendered by the existing `genericClause`/
  `implGenericClause`/`fnGenericClause` emitters.
- **HIR/emitter** — a `jsOp` method-call lowering (receiver `.js_add(&rhs)`); or reuse
  the existing method-call HIR node with the tslib trait method name.
- **Struct `JsEq`** — when emitting a struct that derives `PartialEq`, also emit
  `impl t2r::JsEq for S { fn js_eq(&self,o:&Self)->bool { self == o } fn js_ne(… ) { self != o } }`.
- **Retarget 081 CG8** — its blanket "operator on `T` → UnsupportedError" spec
  narrows to the still-loud cases (mixed operands / logical). Other CG specs stay green.

## Impl decomposition (each spec-first; ship together)

1. **tslib `ops` layer** — traits + macro + primitive impls. (No compiler behavior yet.)
2. **Arithmetic + `+` concat** — `+ - * / %` over a bare `T` → `JsAdd`/`JsSub`/… .
3. **Comparison + equality** — `< > <= >=` → `JsOrd`; `=== !==` → `JsEq` (incl.
   per-struct `JsEq` emission). Mixed-operand fail-loud guard.

## Specs sketch (→ `specs.md`)

- **GOP1** — `+` over one unconstrained `T` at BOTH a numeric (`→ 8`) and a string
  (`→ "ab"`) instantiation; both differential-match.
- **GOP2** — `- * / %` over a numeric-instantiated `T` (`→` correct arithmetic).
- **GOP3** — `< > <= >=` over a numeric `T` and a (BMP) string `T`; differential-match.
- **GOP4** — `=== !==` over a primitive `T` (number, string, bool); differential-match.
- **GOP5** — `=== ` over a **struct**-instantiated `T` (structural); differential-match.
- **GOP6** — mixed `Pair<A, B>` computing `+` on `A` and comparing `B`; both params
  independently bounded; differential-matches.
- **Fail-loud GOP7** — mixed operands (`this.v + 1`, `t < 5`) → `UnsupportedError`.
- **Fail-loud GOP8** — logical/bitwise over a bare `T` → `UnsupportedError`.
- **Regression GOP9** — a concrete-typed operator (non-generic class) is byte-for-byte
  unchanged; 081 CG8 retargeted to the still-loud mixed/logical case.

## Open sub-details (impl, not dialect forks)

- Exact `impl_js_ops!` macro shape and the tslib module path/name (`t2r::JsAdd` vs
  `tslib::ops::JsAdd`) — match the existing emitted-Rust tslib convention.
- Whether per-struct `JsEq` is emitted unconditionally (for every `PartialEq` struct)
  or only when a struct is observed as a generic `===` argument — prefer unconditional
  for `PartialEq` structs (cheap, avoids usage analysis), guarded by the derive set.
- Reusing the method-call HIR node vs a dedicated `jsOp` node for the trait-method
  emission.
