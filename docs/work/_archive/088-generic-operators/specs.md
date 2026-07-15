# 088 — specs (operators on a generic `T` via a uniform tslib JS-operator trait layer)

> The shippable increment of issue **#62** (`design.md`). Graduates the
> operators-on-`T` fail-loud from series 081. Ships **three slices together**:
> (1) the tslib `ops` layer (seven `Js*` traits + `impl_js_ops!` macro + primitive
> impls), (2) arithmetic + `+` concat, (3) comparison + equality (incl. per-struct
> `JsEq`).
>
> **The mechanism.** Inside a generic body, a bare `T` is a JS value. When **both
> operands of an operator are the same `{kind:"param"}` T**, the operator lowers to
> a tslib JS-operator trait method (`self.v.js_add(&o)`), and the operator's bound
> (`T: tslib::ops::JsAdd`) is unioned onto the scope's generic clause (reusing 081's
> derive-driven `Clone`-bound machinery). Dispatch is by reference (`&self, &Self`),
> ownership-safe. Concrete (non-generic) code is completely untouched.
>
> **The trait bound IS the constraint.** No `<T extends number>` syntax. Legality is
> enforced by which types implement which trait (`String: JsSub` is unmet, so a
> `String`-instantiated `-` fails **at the bound** — loud, never miscompiled).
>
> **In scope:** `+ - * / %` (arithmetic; `+` also String concat), `< > <= >=`
> (ordering), `=== !==` (equality, incl. structural over a struct-typed `T`) — each
> over a **same-`T`** operand pair.
>
> **Fail-loud residuals (guards):** **mixed operands** (an operator where the two
> sides are not the same type param — `this.v + 1`, `t < 5`, `A` vs `B`): the JS
> coercion case, out of scope → `UnsupportedError`. **Logical / bitwise / compound**
> over a bare `T` → `UnsupportedError` (existing, a later slice). Type-illegal uses
> (`String`-minus, struct arithmetic, struct-without-`PartialEq` `===`) surface as
> **loud rustc bound errors** (never a miscompile), documented, not our error.

Spec IDs map to `packages/compiler/tests/generic-operators.test.ts`.

## The tslib `ops` trait layer

- One trait per operator (`String` supports `+` but not `-`, so arithmetic can't be a
  single bound): `JsAdd JsSub JsMul JsDiv JsRem` (arithmetic, return `Self`),
  `JsOrd` (`js_lt/js_le/js_gt/js_ge`, return `bool`), `JsEq` (`js_eq/js_ne`, return
  `bool`). By-reference (`&self, &Self`). No associated `Output` type.
- Impls (macro-generated where uniform): `f64` — all traits (`js_add` = `+`);
  `String` — `JsAdd` (concat via `format!("{self}{rhs}")`), `JsOrd` (lexicographic),
  `JsEq`; `bool` — `JsOrd` (`false<true`), `JsEq`. Encodes JS's type rules.

## In-scope operators over a same-`T` pair (differential)

- **GOP1** — polymorphic `+`: `class Box<T> { v: T; combine(o: T): T { return this.v + o; } }`
  emits `impl<T: tslib::ops::JsAdd + Clone>` with `self.v.js_add(&o)`. `new Box(5).combine(3)`
  → `8` (numeric add) **and** `new Box("a").combine("b")` → `"ab"` (String concat) —
  both from one unconstrained `T`; both differential-match JS.
- **GOP2** — `- * / %` over a numeric-instantiated `T`: a method computing
  `this.v - o`, `* o`, `/ o`, `% o` (each same-`T`) lowers to `js_sub/js_mul/js_div/
  js_rem`; the scope bounds `T: JsSub + JsMul + JsDiv + JsRem`. Correct arithmetic;
  differential-matches.
- **GOP3** — ordering `< > <= >=` over a numeric `T` and a (BMP) string `T`: a method
  returning `this.v < o` (etc.) lowers to `js_lt/js_gt/js_le/js_ge`, bounds `T: JsOrd`.
  Numeric and BMP-string instantiations both differential-match JS.
- **GOP4** — equality `=== !==` over a **primitive** `T` (number, string, bool): a
  method returning `this.v === o` / `this.v !== o` lowers to `js_eq/js_ne`, bounds
  `T: JsEq`. All three primitive instantiations differential-match.
- **GOP5** — `===` over a **struct**-instantiated `T` (structural): the same generic
  method, instantiated at a user struct that derives `PartialEq`, works via the
  per-struct `impl tslib::ops::JsEq for S { … self == o … }`. `===` is **structural**
  (Rust) — the same documented edge the dialect already accepts for concrete struct
  `===` (JS uses object identity). A same-reference / differing-field comparison
  fully differential-matches; the distinct-but-equal case pins the structural-vs-
  identity divergence (Rust `true`, JS `false`).
- **GOP6** — mixed `class Pair<A, B>`: `+` on the `A` field and `<` on the `B` field;
  each param **independently** bounded (`A: JsAdd`, `B: JsOrd`), each operator's two
  operands the same param. Differential-matches at a `<number, string>` instantiation.

## Fail-loud residuals (guards)

- **GOP7** — **mixed operands**: an operator where the two sides are **not the same
  `T`** — `this.v + 1` (a `T` and a literal), `t < 5` (a `T` and a number). The JS
  coercion case (`"a"+1`→`"a1"`), out of scope → `UnsupportedError`. Only
  both-operands-the-same-type-param routes to the trait layer.
- **GOP8** — **logical / bitwise** over a bare `T`: `a && b` (or `a | b`) where
  `a,b: T` → `UnsupportedError` (existing behavior, a later slice).

## Regression / retarget

- **GOP9** — a **concrete-typed operator** in a non-generic class is byte-for-byte
  unchanged (native `+`, no `js_add`, no `tslib::ops`). And **081 CG8 is retargeted**
  in place: it previously asserted a blanket "operator on `T` → `UnsupportedError`";
  it now asserts a still-loud case (a **mixed operand** `this.v + 1`), keeping all
  other CG specs green.
