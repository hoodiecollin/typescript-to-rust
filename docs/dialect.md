# The Input Dialect — Complete Fail-Loud Catalog

The translator accepts a **strict subset** of TypeScript and rejects everything
outside it. "Reject loudly" beats "mistranslate silently": every construct the
compiler cannot soundly lower stops the build with an error rather than emitting
wrong Rust.

This document is the **complete catalog of every fail-loud case** — grouped by
feature. If the compiler rejected your input, the exact message is here, with the
input shape that triggers it and whether it is a hard "no" or a "not yet".

> Why the subset exists: TypeScript is intentionally unsound (bivariant params,
> `any` escape hatches) and garbage-collected. A *total* TS→Rust translation does
> not exist. Constraining the input is what makes the problem decidable and the
> output idiomatic — under the "Option A" memory model (idiomatic borrows, no
> blanket `Rc<RefCell<T>>`). See [plan.md](./plan.md) and
> [architecture.md](./architecture.md).

## How to read this catalog

Every rejection is one of two kinds:

- **Forbidden** (`DialectError`) — *fix your input.* The construct is outside the
  accepted dialect and will **never** be translated as written (e.g. `any`,
  decorators, `abstract`). Change the code.
- **Not yet** (`UnsupportedError`) — *in the dialect, not built.* The construct is
  intended to work eventually but the compiler does not lower it today. It may
  graduate in a later series. The workaround is to rewrite into a supported shape.

The distinction lives in [`packages/compiler/src/errors.ts`](../packages/compiler/src/errors.ts).
The **error message string is the stable anchor** — line numbers drift, messages
don't. Each row below quotes the message the compiler prints.

## The two gates (where rejection happens)

1. **Validator** (`validate.ts`) — a whole-tree walk run first. It enforces the
   parse-level allowlist (default-deny: any AST node type not modeled is rejected),
   the forbidden *types* (`any`/`unknown`), and forbidden *flags*
   (`async function*`, `for await`, decorators, `abstract`, `declare`, …).
2. **Lowering** (`lower.ts`, with `numeric.ts` refinement) — the single semantic
   gate. Everything that is syntactically modeled but cannot be soundly lowered in
   a given *shape* is rejected here.
3. **Emitter** (`emitter.ts`) — pure and total by design. It carries exactly one
   defensive throw (an invariant guard, not a feature boundary — see
   [Identifier hygiene](#identifier-hygiene)).

---

## Required (the positive rules)

- **Explicit type annotations** on every function **parameter**. A parameter has
  no inferable type (an un-annotated param is implicit `any`, which is forbidden),
  so this is a hard requirement — `parameter '<name>' without a type annotation`.
  **Bindings and function/method/getter return types may be left un-annotated**
  (series 099): the tsc-backed TypeOracle infers the type *through* built-in
  signatures (`.map`, `.find`, template literals, `Object.entries`, …) and a
  **re-validation gate** either maps it to a modeled `RustType` (then it is used,
  exactly as an annotation would be) or keeps the fail-loud "without a … type
  annotation" throw. So an un-annotated `const doubled = xs.map(x => x*2)` or a
  return-type-less `function area(w: number, h: number) { return w*h; }` now lower.
  What the gate still rejects (unchanged-loud): an inferred **tuple**, **function
  type**, **anonymous object**, **wide non-nullish union** (093 unions are
  name-driven), `any`/`unknown` (a `DialectError`), `bigint`/`symbol`, an
  `null`/`undefined`-only initializer, or anything else outside the modeled
  surface. Statically-obvious literals (`const n = 5`, `["a","b"]`) and the
  by-construction forms (`Object.entries`, `parseJson<T>`, `.find`, `.at`, `using`)
  keep their fast pre-check and never reach the oracle. A `: void` return still
  lowers to a unit fn. (Class-field non-literal initializers are **not** inferred
  this series — that stays fail-loud, deferred.)
- **Statically-known, closed object shapes** via `interface`, `type`, or `class`.
  Object literals must conform to a declared shape.
- **No shared mutable aliasing that escapes what the ownership pass can prove
  sound.** Two live mutable references to the same object generally cannot be
  expressed in idiomatic Rust (the Option A tax). `"use rc"` is the local escape
  hatch when it's genuinely needed.

---

## Semantic divergences from TypeScript

A short, closed list of constructs the compiler **accepts and translates**, but
whose runtime meaning **intentionally differs** from TypeScript. These are not
rejections — they are documented, deliberate choices (usually forced by the
Option A memory model). Each is pinned by a fixture so a refactor can't silently
flip it.

- **Object `===`/`!==` is structural, not identity (series 047).** JS `===` on
  objects compares *identity* (two distinct objects with equal fields are `!==`);
  the dialect's default is **structural** equality (`derive(PartialEq)`) — equal
  fields ⇒ equal. This is what survives the move/clone model (a struct has no
  stable identity to observe once it is moved, cloned, or rebuilt from a literal)
  and what idiomatic Rust derives. **Identity is restored only under `"use rc"`**
  (`Rc::ptr_eq` on the shared handle) **and `"use arena"`** (allocation identity),
  where an instance has a stable heap home — there `===` matches JS again. `f64`
  fields are `PartialEq` (so numeric records compare) but not `Eq`, so this does
  **not** unlock struct map/set keys (#21). A struct with a non-`PartialEq` field
  (an `fn`-pointer) compared with `===` is a clean `UnsupportedError`, not a
  silent miscompile. The **same structural equality** applies to `===`/`!==` over a
  **struct-instantiated generic `T`** (series 088), via the per-struct
  `impl tslib::ops::JsEq` — see the *Generics* section.

- **`JsonValue` navigation: absent → `Null`, mismatch → fail-loud (series 090).**
  The opt-in dynamic `JsonValue` (reached only via `@ttr/std`'s `parseJsonValue` /
  `fromJsonValue` / `toJsonValue`, and **not** a reopening of `any`) navigates by
  explicit accessors. An **absent object key** (`v.get("nope")`) or an
  **out-of-bounds index** (`v.at(99)`) yields a `Null` `JsonValue` — so `.isNull()`
  distinguishes it and `v.get("a").get("b")` chains safely — where JS would produce
  `undefined`. But a **coercion mismatch** (`.asNumber()` on a string) or
  **navigating into a non-container** (`.get` on a number, `.at` on an object) is
  **fail-loud** (`panic!` in Rust / `throw` under Bun, differential-matched), where
  JS would silently yield `undefined`/`NaN`. The safe path is a `.isNumber()` /
  `.isArray()` / … guard first. Pinned by `packages/compiler/tests/json-value.test.ts`.

- **`stringifyJson` omits `undefined`-only object keys, keeps `null` (series 091).**
  JS `JSON.stringify` drops an `undefined`-valued object key but serializes a
  `null`-valued one. The dialect collapses `T | null` and `T | undefined` to one
  `Option<T>`, so provenance is recovered from the **declared field type**: an
  `undefined`-only field (`x?: T` / `x: T | undefined`) emits
  `#[serde(skip_serializing_if = "Option::is_none")]` (key omitted when `None`); a
  `null`-bearing field (`x: T | null`, and — **"null wins"** — `x: T | null | undefined`)
  keeps the key and serializes `null`. **Divergence:** a *both-nullable*
  (`T | null | undefined`) field whose key is *omitted from the literal* (or set
  `undefined`) serializes as `null` here but is *absent* in JS — the collapsed
  `Option` can't tell an omitted/`undefined` both-nullable field from an explicit
  `null`; "null wins" never silently drops data. Pinned by
  `packages/compiler/tests/undefined-omission.test.ts`.

---

## Types & the accepted type surface

The accepted type annotations are exactly: `number`, `string`, `boolean`, `void`,
`Array<T>` / `T[]`, `Record<string, V>`, `Promise<T>`, a declared `interface` /
`class` name (nominal `struct`, incl. a **generic instantiation** `Box<number>` —
series 081), an in-scope **generic type parameter** `T` (inside a generic class /
method / fn, series 081 → the `param` type variable), a **union type** `A | B | …`
(→ a Rust `enum`, series 093 — see the Union-types note below), and
`T | undefined` / `T | null` (→ `Option<T>`). Everything else is fail-loud. (A bare
`T` that is *not* an in-scope type parameter stays fail-loud as an undeclared type
name.)

| Trigger | Kind | Message |
|---------|------|---------|
| `any` type anywhere | Forbidden | `` `any` type `` |
| `unknown` type anywhere | Forbidden | `` `unknown` type `` |
| Bare `Array` with no element type | Not yet | generic `Unsupported <node>` |
| Bare `Promise` with no inner type | Not yet | generic `Unsupported <node>` |
| `Record<K, V>` missing key or value type | Not yet | generic `Unsupported <node>` |
| `Record<number, V>` / non-string key | Not yet | `Record with a non-string key (only string keys map to HashMap)` |
| Unknown/undeclared type name (an unresolved generic, an unknown class, …) | Not yet | generic `Unsupported <node>` |
| Bare `null` / `undefined` type (not inside a union) | Not yet | generic `Unsupported <node>` |
| A union of a **recursive** type (`type Tree = … \| { kids: Tree[] }`) | Not yet | fails when the recursive field lowers (needs `Box`) |
| A **generic** union (`type Wrap<T> = {some:T} \| {none:true}`) | Not yet | generic `Unsupported <node>` |
| A **mixed literal + object** union (`"loading" \| { kind: "done" }`, G) | Not yet | `union alias '…' mixes literal and object members …` |
| Two named structs with **no shared discriminant** (`Point \| Circle`) | Not yet | generic `Unsupported <node>` (no `typeof`/`in` narrowing shape) |
| Any other type keyword/form: `bigint`, `symbol`, tuple, function type, intersection, mapped, conditional, indexed-access, `typeof` query, type predicate | Not yet | generic `Unsupported <node>` |

Union types (series 093): a union of real members lowers to a Rust `enum`.
**Literal** unions (`"a" | "b"`, `0 | 1`) → a fieldless enum with a `Display`
round-trip; **discriminated object** unions (`{kind:"circle",r} | {kind:"square",s}`)
→ struct-variant enums (the discriminant is consumed into the variant name);
**named-interface** members (`Circle | Square`) → newtype-variant enums preserving the
inner struct; **primitive/mixed** unions (`string | number`, `string | Point`) →
newtype variants narrowed by `typeof`; **non-discriminated** object unions
(`{a} | {b}`) → struct variants narrowed by `"a" in x`. Anonymous/inline unions are
named `__anonymous_union_<hash>` and structurally deduped (order-independent). A
singleton literal *type* used as a field (`kind: "circle"`) widens to its base
primitive (`String`/`f64`/`bool`) at the value level. The residual boundary
(recursive, generic, and mixed literal+object unions) is the fail-loud rows above.

Nullability note: `T | undefined` and `T | null` lower to `Option<T>` (a union whose
only real member is `T`); a union carrying real members *plus* a nullish member wraps
the synthesized `enum` in `Option`. The runtime `Option` is flavourless (a `None`
doesn't record `null` vs `undefined`); the one place the distinction is recovered —
from the declared field type — is JSON key omission on `stringifyJson` (series 091,
see the JSON-divergence bullet above).

---

## Variables & bindings

| Trigger | Kind | Message |
|---------|------|---------|
| Uninitialized binding (`let x: T;` with no initializer) | Not yet | `uninitialized binding` |
| Destructuring default value (`const { x = 1 } = …` / `const [a = 0] = …`) | Not yet | `object-destructuring default value` / `array-destructuring default value` |
| Nested destructuring pattern (`const { p: { x } } = …`) | Not yet | `object-destructuring nested pattern` |
| Array/object destructuring over a **non-identifier** source (a call / complex expr — bind it to a variable first) | Not yet | `… over a non-identifier source` |
| Object-rest over a non-named-struct source | Not yet | `object-rest over a non-named-struct source` |
| Array-destructuring over a source whose element type is unknown | Not yet | `array-destructuring over a source whose element type is unknown` |
| Rest **parameter** `(...args: T[])` (variadic — distinct from a rest *binding*) | Not yet | `rest parameter` |
| Parameter without a type annotation | Not yet | `parameter '<name>' without a type annotation` |
| An un-annotated binding whose initializer the oracle **can't infer to a modeled type** (inferred tuple / function type / anonymous object / wide union / `null`/`undefined`-only / no source threaded). Inferable-to-modeled bindings now lower (series 099); obvious literals + by-construction forms short-circuit before the oracle. | Not yet | `binding '<name>' without a type annotation` |

> **Binding destructuring is supported** (series 067 + 097). Object: `const { x, y
> } = point`, renamed `const { x: px } = point`, and rest `const { x, ...rest } =
> point` (rest → a synthesized anonymous struct) — over a **named-struct** source.
> Array: `const [a, b] = [1, 2]` (fixed-arity literal → plain values) and `const [a,
> ...tail] = arr` over a **Vec/Array variable** — element slots bind `Option<T>`
> (an out-of-bounds slot is `undefined` → `None`; consume via `??` / `!` / an `if (x
> !== undefined)` narrow), `tail` binds the remaining `Vec<T>`. Sources must be a
> plain identifier (array-over-Vec / rest). Array-destructuring `[k, v]` is also a
> `for-of` head over `Object.entries(...)` — see [Control flow](#control-flow--loops).

---

## Functions

| Trigger | Kind | Message |
|---------|------|---------|
| Anonymous function declaration (no name) | Not yet | generic `Unsupported <node>` |
| Function without a body | Not yet | `function without a body` |
| Function without a return-type annotation **whose inferred return is out of surface** (series 099 infers modeled returns via `getReturnTypeOfSignature`; a `Promise<T>` unwraps to `T`) | Not yet | `function '<name>' without a return type annotation` |
| Method / static-method / getter without a return-type annotation, inferred return out of surface | Not yet | `method '<name>' without a return type annotation` |
| Top-level script statements alongside a user-defined `main()` | Not yet | `top-level statements alongside a user-defined main()` |

---

## Generators

A **named, non-async `function*`** annotated `Generator<T>` /
`IterableIterator<T>` / `Iterable<T>` is modeled two ways by body shape:

- **Straight-line finite yields** (`yield a; yield b; …`) → `vec![a, b, …]
  .into_iter()` (series 035). No state machine.
- **Loops / branches / non-`yield` statements interleaved with yields** (series
  052) → a resumable **state-machine `struct` + `impl Iterator`**: a `state: u32`
  discriminant plus the generator's params and any local **live across a yield**
  become struct fields; `next()` is a `loop { match self.state { … } }` that runs
  non-yielding states straight through and `return Some(v)` at each yield after
  recording the resume state. The public wrapper stays `fn g(…) -> impl
  Iterator<Item = T>`, so `for-of` consumption composes unchanged. A local not
  live across any yield stays a bare `let` inside its state arm.

| Trigger | Kind | Message |
|---------|------|---------|
| `async function*` (async generator) | Forbidden | `async generator functions (`async function*`)` |
| Generator method or generator *expression* (`function*` not a top-level decl) | Forbidden | `generator methods / expressions (`function*`)` |
| Anonymous generator | Not yet | generic `Unsupported <node>` |
| Generator with no `Generator<T>` / `IterableIterator<T>` return annotation | Not yet | `generator without a `Generator<T>` / `IterableIterator<T>` return annotation` |
| That annotation missing its item type argument | Not yet | `generator without an item type` |
| Generator without a body | Not yet | `generator without a body` |
| State-machine generator with a borrowed (non-owned) param — can't be captured by value across a suspend | Not yet | `state-machine generator with a borrowed (non-owned) parameter` |
| `yield` inside a `try`/`catch` (or any other unsupported statement) in a state-machine generator | Not yet | `unsupported statement in a state-machine generator: <type>` |
| Generator `return <value>` (only a bare `return` ends iteration) | Not yet | `generator `return <value>` (only a bare `return` ends iteration)` |
| `yield*` delegation | Not yet | `` `yield*` delegation `` |
| Bare `yield` with no value | Not yet | `bare `yield` (no value)` |

---

## Classes

Modeled: a **named** class with instance fields, a constructor (explicit or
synthesized), and instance methods. **Single-`extends` class inheritance** (series
053) is modeled via a composition + trait hybrid. **Generics** (`class Box<T>`) are
modeled by monomorphization (series 081) — see the *Generics* section below.

### Construction — implicit & partial constructors (series 070)

A class need not have an explicit field-initializing constructor. Each field's
construction value is resolved from one of three sources, and the class always
lowers to a valid `struct` + associated `new`:

- **Constructor-assigned** (`this.x = …`, or a `public/private x: T` parameter
  property) → from the constructor (the existing 060 path).
- **Field initializer** (`x = 5`) → the initializer becomes the construction
  default (`x: 5.0`). An un-annotated initializer types via the numeric literal
  pass (`5` → `f64`); an `Option`-typed default is `Some`-wrapped. An initializer
  that references `this` / another field is fail-loud (not a construction constant).
- **Neither** → the field is `Option<T>` (series 066), initialized `None`; a read
  requires narrowing. A `class C { x: number }` with no constructor and no
  initializer thus makes `x: Option<f64>`, `new()` setting `x: None`.

A class with **no** constructor synthesizes a zero-parameter `new()` from these
sources; a **partial** constructor fills the fields it doesn't assign the same way.
A user `static new` that would collide with the synthesized `new()` is fail-loud.

### Inheritance (`extends`) — composition + trait

`class B extends A` decomposes by *what is reused* (series 053):

- **Data / `super` / inherited fields → composition.** `B` gains a synthetic
  `base: A` embed (`struct B { base: A, … }`, zero-cost). `super(args)` →
  `base: A::new(args)`; `super.m(args)` → `self.base.m(args)`; an inherited-field
  read `b.x` → `b.base.x` (multi-level chains hop repeatedly).
- **Methods / override / polymorphism → a shared `trait IA`** (named `I` + the
  root base). Each participating class provides an `impl IA for Name`: the base
  supplies every method body, a subclass its overrides plus a forwarder
  (`fn m(&self){ self.base.m() }`) for the rest. A trait appears **only** for a
  class in an `extends` relationship — a plain standalone class emits exactly as
  before (no `base`, no trait, no `dyn`).
- **Monomorphic base-typed param** (`fn greet(a: Animal)`) → `impl IA` (static
  dispatch, zero-cost, no heap).
- **Heterogeneous base-typed collection** (`const zoo: Array<A> = [new Dog(), new
  Cat()]`) → `Vec<Box<dyn IA>>` — the *only* place a vtable/heap cost appears.
- **Base-field read through a `dyn IA`** → an on-demand trait accessor
  `a.x()` (emitted only for fields actually read polymorphically).

| Trigger | Kind | Message |
|---------|------|---------|
| `abstract class` | Forbidden | `` `abstract` classes `` |
| Anonymous class | Not yet | `anonymous class` |
| `implements` a *behavioral* interface → `impl I<Name> for C` (series 071); a *pure-data* interface → field-shape assertion (plain struct, no trait) | Modeled | — |
| `class extends` a non-identifier / non-declared base | Not yet | `class extends a non-identifier base` / `class extends '<name>' which is not a declared class` |
| Subclass constructor with no `super(...)` | Not yet | `subclass constructor without a \`super(...)\` call (base field uninitialized)` |
| Subclass-only field read through a `dyn IA` (downcast) | Not yet | `field '<name>' read through a 'dyn I<Base>' is not a shared/base field (downcast — deferred to #17)` |
| `static` or computed-name field | Not yet | `static/computed class field` |
| Class field without a type annotation *and* no inferable initializer | Not yet | `class field '<name>' without a type (nor an inferable initializer)` |
| Field initializer referencing `this` / another field | Not yet | `field initializer for '<name>' references \`this\` …` |
| `static new` colliding with a synthesized constructor | Not yet | `class has a \`static new\` that collides with the synthesized zero-arg constructor` |
| Parameter property (`constructor(public x: T)`) without a type | Not yet | `parameter property '<name>' without a type` |
| `static` or computed-name method | Not yet | `static/computed class method` |
| `get` / `set` accessor | Not yet | `class get accessor` / `class set accessor` |
| Method without a body | Not yet | `method without a body` |
| `[Symbol.dispose]()` method without a body | Not yet | `[Symbol.dispose] without a body` |

### Generics (series 081) — monomorphization + interface bounds

Type parameters are the **first user type variable** in the type system (the
`{kind:"param"}` `RustType`, rendered as the bare name). A generic class/method
lowers by **monomorphization**: rustc emits one specialization per instantiation
(zero-cost, idiomatic Rust).

- **Unbounded** `class Box<T> { v: T; get(): T { … } }` → `struct Box<T>` +
  `impl<T: Clone> Box<T>`. A bare `T` in scope (class or method type params) lowers
  to `{kind:"param"}`; nested `Vec<T>` / `Option<T>` / `T[]` render the name inside
  the wrapper unchanged. Multiple params (`class Pair<A, B>`) and a **generic method**
  (`first<U>(xs: U[]): U`) are modeled.
- **Bounds are derive-driven.** The struct gets the derives its fields already earn
  (`Clone` / `Debug` / `PartialEq`); rustc adds the per-derive `T: …` bound. The
  inherent `impl` and a generic method's own `<U>` additionally carry an explicit
  `Clone` bound, because a `return this.field` of a `T` field clones it. A
  `Box<NonClone>` therefore fails at that bound (accepted cost).
- **Interface-bounded** `class Boxed<T extends I>` where `I` is a **behavioral**
  interface → `struct Boxed<T: I<Name>>` / `impl<T: I<Name> + Clone> Boxed<T>`
  (reuses 071 `traitNameOf`); the bounded `T` can **call the interface's methods**
  (`this.v.area()`).
- **Construction is inference-only.** `new Box(5)` → `Box::new(5.0)` (rustc infers
  `Box<f64>` from the ctor arg); no turbofish is emitted. A generic **struct-reference**
  annotation `const b: Box<number> = new Box(5)` lowers (`Box<f64>`).

#### Operators over a generic `T` — the JS-operator trait layer (series 088)

Inside a generic body a bare `T` is a **JS value**: when **both operands of an
operator are the same `{kind:"param"}` T**, the operator lowers to a **tslib
JS-operator trait method** (`this.v + o` → `self.v.js_add(&o)`), not a native Rust
operator. This is the Rust-side mirror of the std-shim isolation boundary — every
JS-operator quirk lives in one macro-generated tslib `ops` layer
(`crates/tslib/src/ops.rs`) instead of being smeared across the emitter. It is
zero-cost (rustc inlines each method) and **uniform** — one mechanism for all
operators, no native/trait/constraint split. Concrete (non-generic) code is
**completely untouched** (native `+`, existing string-concat path, struct-eq).

- **In scope (each over a same-`T` pair):** `+ - * / %` (arithmetic; `+` is also
  String concat), `< <= > >=` (ordering), `=== !==` (equality). Dispatch is
  by-reference (`&self, &Self`), ownership-safe.
- **The trait bound IS the constraint.** There is **no `<T extends number>` syntax.**
  The author writes plain `<T>` and uses operators; legality is enforced by *which
  types implement which trait*. A body using `-` bounds `T: tslib::ops::JsSub`, which
  only `f64` satisfies, so a `String` instantiation fails **at the bound** (loud,
  never miscompiled). "Numeric-only arithmetic" is encoded in the tslib impl set, not
  the validator. Type coverage: `f64` — all; `String` — `JsAdd`(concat)/`JsOrd`/
  `JsEq`; `bool` — `JsOrd`/`JsEq`; a `PartialEq` user struct — `JsEq` (structural).
- **Bounds are demand-driven.** A body adds a bound only for the operators it uses
  (`+` → `JsAdd`, `<` → `JsOrd`, `===` → `JsEq`), unioned onto the scope's generic
  clause (reusing 081's `Clone`-bound machinery): `struct Box<T: tslib::ops::JsAdd>` /
  `impl<T: tslib::ops::JsAdd + Clone> Box<T>`.
- **Structural `===` over a struct-`T`.** Every `PartialEq`-deriving struct/class
  emits `impl tslib::ops::JsEq for S { fn js_eq(&self,o) { self == o } … }`
  (unconditionally, guarded by the derive set so it always compiles), so `===`/`!==`
  work over a struct-instantiated `T` — **structural** (Rust) vs identity (JS), the
  same divergence the dialect already accepts for concrete struct `===`.
- **Documented edge:** `<`/`>` on a `String`-`T` orders by UTF-8 bytes (≡ Unicode
  scalar); JS by UTF-16 code units — differ only for astral (non-BMP) chars.

**Fail-loud residuals (still loud, a later slice):**

| Form | Status | Message shape |
|------|--------|---------------|
| **Mixed operands** — an operator with a `T` and a **non-`T`** side (`this.v + 1`, `t < 5`): the JS coercion case | Not yet | `operator '<op>' on a generic type parameter '<T>' and a non-'<T>' operand (a mixed-operand JS coercion …)` |
| **Logical** (`&& \|\|`) over a bare `T` — truthiness of an opaque `T` isn't knowable | Not yet | `logical operator '<op>' on a generic type parameter — truthiness of an opaque 'T' isn't knowable …` |
| **Bitwise / compound** (or a same-`T` operator on a **method's own `<U>`**) over a bare `T` | Not yet | `operator '<op>' on a generic type parameter '<T>' — only arithmetic / ordering / equality over two same-'<T>' operands … (a class-level type parameter) …` |
| **Type-illegal use** — `String`-minus, struct arithmetic, struct-`===` without `PartialEq` | Loud (rustc) | a rustc bound error (`Js…` unmet) — documented, never a miscompile |

**Other fail-loud residuals (slice 3, graduates with #44 — the TS type layer):**

| Form | Status | Message shape |
|------|--------|---------------|
| **Explicit call-site type args** on `new` (`new Box<string>(x)`) | Not yet | `explicit type arguments on \`new Box<…>(…)\` (construction is inference-only …)` |
| **Explicit call-site type args** on a call (`identity<number>(5)`) | Not yet | `explicit type arguments on a generic call \`f<…>(…)\` (calls are inference-only …)` |
| A **class** as a bound (`<T extends SomeClass>`) | Not yet | `class '<C>' used as a generic bound … (a class isn't a trait bound)` |
| A **multi-bound** (`<T extends A & B>`) | Not yet | `multi-bound generic '<T extends A & B>' …` |
| A **data-only / unknown interface** bound (no trait to bind) | Not yet | `generic bound '<T extends I>' where 'I' is not a behavioral interface …` |
| A **bound on a method/fn type param** (`<U extends I>`) | Not yet | `a bound on the method/function type parameter '<U>' …` |
| A generic class that **also** does inheritance / `implements` | Not yet | `generic class '<C>' that also participates in inheritance / \`implements\` …` |
| `where`-clauses, const generics, lifetime params | Not yet | generic `Unsupported <node>` |

### Constructors

A non-fallible constructor may contain **only** `this.field = expr` assignments,
and must initialize exactly the declared fields (Rust struct-literal totality). A
constructor that `throw`s becomes fallible and may carry leading guard statements.

| Trigger | Kind | Message |
|---------|------|---------|
| Constructor without a body | Not yet | `constructor without a body` |
| Non-fallible constructor body beyond `this.field = expr` (branches, locals, calls) | Not yet | `constructor body beyond `this.field = expr` initialization` |
| Constructor initializes ≠ the declared field set | Not yet | `constructor must initialize exactly the declared fields` |
| A declared field left uninitialized | Not yet | `constructor does not initialize field '<name>'` |

---

## Interfaces — usage-directed dual lowering (series 059 + 071)

An interface lowers by its *declaration shape*:

- **Pure-data interface** (only property signatures) → a **`struct <Name>`**
  (unchanged, the dominant data-record use). A getter `trait I<Name>` is
  synthesized **only when needed** — i.e. when the interface is `extends`ed (059)
  or used as a generic bound.
- **Behavioral / mixed interface** (declares ≥1 method signature) → a synthesized
  **`trait I<Name>`** carrying the method signatures, plus a **by-value getter**
  per data field (mixed case). No canonical struct is emitted — every *value* of
  the interface type is backed by a concrete struct.

Conformance (all → `impl I<Name> for <ConcreteStruct>`):

- **`class C implements I`** (behavioral `I`) → `impl I<I> for C` (method
  forwarders to the inherent method + 059 data-field getters); propagates down
  `extends` chains.
- **`class C implements I`** (pure-data `I`) → a **field-shape assertion**: `C`
  stays a plain `struct` with **no trait / no `impl`** (nothing to dispatch; TS
  already checked the fields).
- **Object literal typed as a behavioral `I`** → a synthesized per-literal nominal
  struct `struct I__litN` (data fields + **non-capturing** method literals as
  **`fn`-pointer fields**) + `impl I<I>`; the binding retypes to the synthesized
  struct.

Value representation reuses the 053c dispatch heuristic verbatim: a **monomorphic**
param/local (`fn f(s: Shape)`) → `&impl I<Name>` (static); a **heterogeneous /
stored** collection (`const xs: Array<Shape> = [new Circle(), new Square()]`) →
`Vec<Box<dyn I<Name>>>` (vtable) — each `.method()` dispatches virtually.

| Trigger | Kind | Message |
|---------|------|---------|
| A non-computed property signature or **method signature** | Modeled | — |
| `interface extends` (inheritance) | Modeled (059) | — |
| A **capturing** method literal in an interface-typed object literal (`{ area: () => this.r * 2 }` / closes over a local) | Not yet | `capturing method literal in an interface-typed object literal (…needs a boxed-closure field, a later series)` |
| A computed / non-identifier interface method signature | Not yet | `computed / non-identifier interface method signature` |
| A member that is not a property signature or a method signature (index / call signatures) | Not yet | `unsupported interface member` |
| A property signature without a type annotation | Not yet | `interface field '<name>' without a type` |

---

## Enums

Modeled: a runtime numeric enum with integer-literal (or auto) discriminants.

| Trigger | Kind | Message |
|---------|------|---------|
| `const enum` (compile-time inlining) | Not yet | `` `const enum` (compile-time inlining) `` |
| Computed member name | Not yet | `computed enum member` |
| Member initializer that is not an integer literal (string enums, expressions) | Not yet | `enum member initializer must be an integer literal (string enums unsupported)` |
| Member with a fractional discriminant | Not yet | `enum member with a fractional discriminant` |

---

## Control flow & loops

Supported: `if`, `while`, C-style `for`, `for-of`, `switch`, `break`, `continue`,
`throw`, `try`. The fail-loud edges:

| Trigger | Kind | Message |
|---------|------|---------|
| `for await (…)` async iteration | Forbidden | `` `for await` async iteration `` |
| Labeled `break` | Not yet | `labeled break` |
| Labeled `continue` | Not yet | `labeled continue` |
| `for-of` with more than one binding declaration | Not yet | `for-of with a non-single binding` |
| `for-of` array-destructuring head that isn't exactly `[k, v]` plain identifiers | Not yet | `for-of destructuring must bind exactly `[k, v]` identifiers` |
| Empty or stacked (fall-through) `switch` case | Not yet | `empty/stacked switch case (fall-through not supported)` |
| Non-final `switch` case not ending in `break`/`return` (fall-through) | Not yet | `switch case falls through (needs break or return)` |
| Any statement type not modeled (`EmptyStatement`, `DebuggerStatement`, `DoWhileStatement`, bare nested `BlockStatement`, `with`, …) | Not yet | generic `Unsupported <node>` |

---

## throw / try / catch

Only two throw forms are accepted: `throw new <ErrorClass>(message, …fields)`
and `throw "string literal"`. With **no** custom error class declared, errors
propagate as `Result<T, String>` + `?`. The moment any `class X extends Error`
is declared, the whole program's error type becomes the synthesized `AppError`
enum (series 049 — see *Custom error classes* below), and both a `throw new
Error(msg)` and a `throw "lit"` construct the `AppError::Other { message }`
catch-all variant.

| Trigger | Kind | Message |
|---------|------|---------|
| `throw new <expr>(...)` where the callee isn't a plain identifier | Not yet | `throw of a non-identifier constructor` |
| `throw new <Name>(...)` where `<Name>` is not a built-in error class nor a declared `class X extends Error` | Not yet | `throw of an unknown error class (declare it as `class X extends Error`)` |
| `throw new Error(...)` (built-in) with ≠ 1 argument | Not yet | `throw new Error() must have exactly one message argument` |
| `throw new <CustomClass>(...)` with the wrong field-argument count | Not yet | `throw new <Class>() takes a message plus N field argument(s)` |
| `throw <expr>` that is neither `new Error(...)` nor a string literal (variables, numbers, objects) | Not yet | `throw of a non-Error, non-string-literal value` |
| `try` without a `catch` handler (`try`/`finally` only) | Not yet | `try/finally without a catch handler (deferred)` |
| `return`/`break`/`continue` escaping a `try`/`catch` (value-yielding try/catch) | Not yet | `return/break/continue inside try/catch (value-yielding try/catch: deferred)` |
| Re-throw (or nested `try`) inside `catch` alongside a `finally` | Not yet | `re-throw inside catch alongside a finally (deferred)` |

### The `AppError` enum + `instanceof` catch discrimination (series 049)

A custom `class X extends Error` becomes a **struct variant** of one whole-program
`#[derive(thiserror::Error, Debug)] enum AppError` — `message: String` first, then
its declared typed fields — alongside a fixed `Other { message: String }`
catch-all. thiserror derives `Display` / `std::error::Error`; the `#[error(...)]`
is **`#[error("{message}")]`** for every variant (**option A**): Display shows only
the message, mirroring JS `String(err)` / `console.log(err.message)` — a variant's
extra fields stay first-class in `match` but are *not* rendered by Display. `From<String>`/`From<&str>` impls construct `Other` so a `String` composes into the
enum via `.into()` / `?`.

A `catch` whose body is a clean `if (e instanceof Foo) … else if (e instanceof
Bar) … [else …]` ladder lowers to a native exhaustive `match` over the owned bound
error (no `downcast_ref`); a branch reading `e.field` binds `field` owned. A ladder
with **no trailing `else`** gets an appended `_ => {}` — **JS parity**: a
`try`/`catch` whose ladder matches nothing silently completes (the non-matching
error is swallowed).

| Trigger | Kind | Message |
|---------|------|---------|
| Anonymous error class | Not yet | `anonymous error class` |
| Error class with a method / getter / setter (non-data member) | Not yet | `custom error class with a method/getter (only typed data fields are supported)` |
| Error class with ≠ 1 constructor | Not yet | `custom error class must have exactly one constructor` |
| Constructor params not `(message, …fields)` 1:1 with the declared fields | Not yet | `custom error class constructor params must be (message, …fields) 1:1` |
| Constructor param out of field order | Not yet | `error-class constructor param '<p>' must match field '<f>' (reordering unsupported)` |
| Constructor body not `super(message);` then one identity `this.f = f;` per field | Not yet | `error-class constructor body must be `super(message);` then one `this.f = f;` per field` |
| Computed / defaulted / reordered field init (`this.f = f.trim()`) | Not yet | `error-class constructor must assign `this.<f> = <f>;` (computed/defaulted/reordered init unsupported)` |
| `e instanceof <BuiltinError>` in a catch (built-in throws collapse into `Other`) | Not yet | ``instanceof <Class>` in a catch — built-in error throws collapse into Other (no variant to match)`` |

A non-`instanceof` catch (`e.message === …`, property tests) keeps the opaque
Display bind (`if let Err(e) = … { … }`, no `match`); a per-branch-*returning*
discriminating catch is still the value-yielding-try/catch deferral (rejected by
the escaping-`return` rule above — #16).

---

## async / await

Modeled: a free `async function` → `async fn`; an **`async` method** →
`async fn m(&self, …)`; a **top-level `const` `async` arrow** (normalized to a free
`async fn`, series 054b); `Promise<T>` return → `T`; `await asyncFn(...)` /
`await obj.method(...)` → `.await` (a fallible async fn/method `?`-propagates via
`.await?`). Directly-awaited only — an un-polled future is rejected (un-awaited-call
→ `tokio::spawn` is series 051c).

**`await` of a non-future drops the `await` (series 055).** In JS, `await` on a
non-thenable just yields the value. So `await syncFn(...)` (a declared non-async
free fn), `await obj.m(...)` (a non-async method), and `await x` / `await obj.field`
(any non-call operand) **drop the `await`** and lower the operand as an ordinary
expression — a fallible sync call still threads `?` (from `lowerCall`), and a
spawned-handle identifier still keeps its real `.await`. There is no fail-loud
`await` shape left.

**Concurrency combinators (series 051a/b).** Under `await`, these shapes map onto
tokio / `futures`:

| TypeScript | Rust |
|---|---|
| `await asyncFn(...).then(cb)` (non-async single-expr `cb`) | `__cb_then_<n>(asyncFn(...).await)` (the `cb` lifts to a named `fn`; no `.then`) |
| `await Promise.all([a(), b(), …])` (array literal, infallible) | `tokio::join!(a(), b(), …)` → a tuple (`const [a,b] = …` → `let (a, b) = …`) |
| `await Promise.all([…])` where any element is fallible | `tokio::try_join!(…)?` → the tuple after `?` |
| `await Promise.race([a(), b(), …])` (array literal, homogeneous) | `tokio::select! { res = a() => res, … }` (first to complete; losers dropped) |
| `await Promise.all(arr.map(f))` (dynamic fan-out, infallible) | `futures::future::join_all(arr.into_iter().map(…)).await` → `Vec<T>` |
| `await Promise.all(arr.map(f))` where `f`'s call is fallible | `futures::future::try_join_all(…).await?` → `Vec<T>` (short-circuit) |
| `await Promise.allSettled(arr.map(f))` | `futures::future::join_all(…).await` → `Vec<Result<T, String>>` (no short-circuit) |
| `await sleep(ms)` (the modeled delay primitive) | `tokio::time::sleep(std::time::Duration::from_millis(ms as u64)).await` |

The fan-out `.map(f)` callback `f` may be an **inline non-async closure**
(`id => asyncFn(id)` → `|id| async_fn(id)`) or a **lifted async arrow**
(`async id => await asyncFn(id)` → a hoisted `async fn __cb_map_<n>`). `tokio::select!`
**drops** the losing arms (cancels them at their next await) — see
[Semantic divergences](#semantic-divergences-from-typescript).

**Task spawning + shared state (series 051c).** An **un-awaited** async free call is no
longer rejected — it schedules an eager task:

| TypeScript | Rust |
|---|---|
| `const h = doWork()` (un-awaited async free call) | `let h = tokio::spawn(do_work())` → `JoinHandle<T>` (bare statement = fire-and-forget) |
| `await h` (on a spawned handle) | `h.await.unwrap()` (a task panic aborts — a documented divergence) |
| `setTimeout(fn, ms)` | `tokio::spawn(async move { tokio::time::sleep(…).await; <fn>; })` |
| a binding passed to ≥2 spawned tasks (or 1 task + reused), read-only | wrapped `std::sync::Arc<T>`; `Arc::clone(&b)` per spawn (**inter-procedural** — the receiving async fn's param becomes `Arc<T>`) |
| a binding shared into a task **and mutated** | wrapped `std::sync::Arc<std::sync::Mutex<T>>`; accesses through `.lock().unwrap()`; the callee's param + body are rewritten |

The task-escape pass (`refineTaskEscape`) only emits shapes it can prove
`Send + 'static`-sound; anything else stays fail-loud (below). It **never** emits a
`spawn` that would not compile.

| Trigger | Kind | Message |
|---------|------|---------|
| `await using` (async resource disposal) | Forbidden | `` `await using` (async resource disposal) `` |
| `Promise.all` / `Promise.allSettled` argument that is neither an array literal nor `arr.map(f)` | Not yet | `Promise.all/allSettled argument must be an array literal or arr.map(f)` |
| Heterogeneous `Promise.race` (arms don't unify to one type) | Not yet | `heterogeneous Promise.race (select! arms must unify to one type)` |
| `.then` with a reject handler (two-arg `.then(onOk, onErr)`) | Not yet | `` `.then` with a reject handler (two-arg) — catch territory `` |
| `.then` on a non-async-call receiver | Not yet | `` `.then` receiver must be a call to an async function `` |
| Calling an async **method** without awaiting it (un-polled future) | Not yet | `call to an async method not directly awaited (an un-polled future never runs)` |
| An async fn used **both** as a spawned shared-state task **and** a direct call | Not yet | `async fn used both as a spawned shared-state task and a direct call — split it` |
| A shared capture the task-escape pass cannot bound (spawn nested in a branch/loop; unbounded `Vec<JoinHandle>`; non-wrappable shared type) | Not yet | `shared mutable state across tasks not provably safe …` / `… the task-escape pass cannot wrap in Arc/Arc<Mutex> …` |
| `async` arrow **callback** in an array adapter (`arr.map(async …)`) — dynamic async fan-out is series 051 | Not yet | `async callback in '.<method>' — dynamic async fan-out (Promise.all(arr.map(f)) → join_all) lands in series 051` |
| `async` arrow in value position (not a top-level `const`) | Not yet | `async arrow closure` |

---

## Operators

| Trigger | Kind | Message |
|---------|------|---------|
| Logical operator other than `&&`, `\|\|`, `??` | Not yet | `logical operator '<op>'` |
| Unary operator other than `-`, `!` (i.e. `+`, `~`, `typeof`, `void`, `delete`) | Not yet | `unary operator '<op>'` |
| A **heterogeneous** ternary (arms of different type) in an *untyped* value position with a **non-primitive** (struct/object) arm (`c ? pt : "a"`) | Not yet | `heterogeneous ternary in an untyped value position with a non-primitive arm — annotate the target with a declared union type` |
| A `${…}` interpolation of a **nested/object-element array** (`` `${[[1],[2]]}` ``) | Not yet | `template interpolation of a nested/object array — only arrays of string/number/boolean render (JS .join(","))` |
| A `${…}` interpolation of a **`Map`/`Set`/function** value | Not yet | `template interpolation of a <hashmap\|set\|fnPtr> value` |
| A **tagged** template `` tag`…` `` (`TaggedTemplateExpression`) | Not yet | `TaggedTemplateExpression` |
| A **value-position** `++`/`--` on a **non-identifier** target (`const y = a[i]++`, `use(obj.n++)`) | Not yet | `++/-- on a non-identifier target in a value position — assign in a statement` |
| `SequenceExpression` (comma) and any other unmodeled expression | Not yet | generic `Unsupported <node>` |

**Ternary `cond ? a : b` (series 094)** → Rust's `if`/`else` **expression**
(emitted parenthesized). The `test` uses the same truthiness path as an `if`
statement (native `bool`, else `is_truthy`). In a **typed context** (annotated
`const`/return/param/field/element) each arm coerces to the target `T` — so
homogeneous arms, a declared-union target (`const x: A | B = c ? … : …`), and an
`Option` target all work. In an **untyped** position (`console.log(c ? … : …)`),
homogeneous arms emit a bare `if`/`else`; **heterogeneous primitive** arms
auto-synthesize a printable anonymous union (`c ? 1 : "a"` → `__anonymous_union_<hash>`,
reusing 093 case F, now with a `Display`). The one residual is the fail-loud row
above (a non-primitive arm with no type context).

**Template literals `` `a${x}b` `` (series 095)** → the `strConcat` node (`format!`),
sugar for a `+` concatenation. Each `${…}` renders **JS-faithfully** by its static
type: a **scalar** (string/number/bool) via `Display`; an **array** of scalars via
`Array.prototype.join(",")` (`` `${[1,2,3]}` `` → `"1,2,3"`); an **optional** via the
`console.log` convention (`Some(v)`→`v`, `None`→`undefined`); a **plain data struct**
→ the JS `String(object)` constant `"[object Object]"` (plain structs never derive
`Display`); a **union enum** via its `Display` inner value (JS-faithful for
`string|number`). The residuals are the three fail-loud rows above — a nested/object
array, a `Map`/`Set`/function interpolation, and a tagged template. Numbers inside
`${…}` use the same `format!("{}")` path as `+` concat (not `to_js_string`), so the
rare `1e21`/`Infinity` divergences are inherited from series 080, not new here.

**`++` / `--` (`UpdateExpression`, series 096)** → Rust `+= 1` / `-= 1` (Rust has no
`++`/`--`). In **statement position** (a standalone `x++;`, the `for` update slot,
a while/if-body) it lowers to a bare `x += 1` and supports every target — local,
field (`this.n++`), index (`a[i]++`); prefix and postfix are equivalent there. In a
**value position** it is a block-temp with JS semantics: postfix `x++` yields the
**old** value, prefix `++x` the **new** (`const y = x++`, `while (n-- > 0)`,
`return x++`, `arr[i++]`). The increment on an integer-promoted counter stays an
integer (`arr[i++]` keeps `i: usize`, no `1.0`). Value position is restricted to an
**identifier** target — a field/index target used *as a value* is the fail-loud row
above (statement position handles those targets).

---

## Literals

| Trigger | Kind | Message |
|---------|------|---------|
| A literal that is not a number, string, boolean, or `null` (bigint, symbol, regex) | Not yet | `literal <typeof>` |

---

## Objects, records & struct literals

An object literal is lowered only when its target shape is known — as the
initializer of a `const x: T = { … }` (struct or `Record`), inside another struct
literal, or in an object-spread context. A bare untyped object literal is
fail-loud.

| Trigger | Kind | Message |
|---------|------|---------|
| Object literal with no `Record`/struct type in context | Not yet | `object literal without a Record type (struct literals: series 011)` |
| Spread or computed key in a `Record`/HashMap literal | Not yet | `unsupported object property (spread or computed key)` |
| Spread or computed key in a struct literal | Not yet | `unsupported object property (spread or computed key)` |
| Struct field name that isn't a static string/identifier | Not yet | `struct field name must be static` |
| Record key that isn't a string literal or bare identifier | Not yet | `record key must be a string literal or identifier` |
| Object-spread property with a computed key (`{ ...a, [k]: v }`) | Not yet | `unsupported object-spread property (computed key)` |
| Member access whose property isn't a plain identifier (and isn't the entries tuple-field pattern) | Not yet | generic `Unsupported <node>` |
| `new` with a non-identifier callee (`new (Cond ? A : B)()`) | Not yet | `new with a non-identifier callee` |

### `Object.*` statics

Supported: `Object.keys`, `Object.values`, `Object.entries`, `Object.assign`.

| Trigger | Kind | Message |
|---------|------|---------|
| Any other `Object.*` static (`freeze`, `fromEntries`, `getOwnPropertyNames`, …) or wrong arity | Not yet | `Object.<name> (only keys/values/entries/assign are supported)` |

---

## Calls, methods & array/string library

Supported receiver methods route to `tslib`/native Rust: array `map`, `filter`,
`reduce`, `sort`, `find`, `some`, `every`, `flatMap`, `flat`, `at`, `slice`,
`join`, `concat`, `forEach`; the string methods below; `Object.*` (above);
`JSON.*` (below).

**String methods (series 083 + 098).** `toUpperCase`/`toLowerCase`, `trim`/
`trimStart`/`trimEnd`, `includes`/`startsWith`/`endsWith`, `repeat`, `replace`
(first-only) / `replaceAll`, `split(sep)` / `split(sep, limit)` / `split("")`,
`slice`/`substring`/`charAt`, `substr(start[, len])`, `padStart`/`padEnd` (1- and
2-arg), `indexOf`/`indexOf(x, from)`, `lastIndexOf`, `at`, `concat`, and `.length`.

- **`at(i)` → `string | undefined`** (JS-faithful): a negative `i` counts from the
  end, out-of-range → `undefined` (a `None`, unlike `charAt`'s `""`) — consumed via
  `??` / `!` / `if (x !== undefined)` narrowing like any optional (series 066).
- **`.length` and `slice`/`substring`/`charAt`/`at`/`indexOf`/`substr` count Rust
  `char`s**, not UTF-16 code units — correct for all BMP text, diverging from JS
  only for astral (non-BMP) chars (the same documented `char`-vs-UTF-16 edge as
  string ordering). `.length` lowers to `.chars().count()`.
- **Residual:** `.length` (a `usize`) in an `f64`-mixing binary (`s.length - 1`,
  `i < s.length` with an `f64` counter) is a pre-existing numeric-pass gap shared
  with array `.len()`; the clean uses are Display print and index position.

| Trigger | Kind | Message shape |
|---------|------|---------------|
| `charCodeAt` / `codePointAt` | Not yet | `.charCodeAt`/`.codePointAt` uses UTF-16 code units/points (deferred) |
| `String.fromCharCode` / `fromCodePoint` | Not yet | `String.fromCharCode uses UTF-16 code units (deferred)` |
| `match` / `matchAll` / `search` | Not yet | RegExp deferred (Tier 3) |
| `localeCompare` / `normalize` / `toLocale*Case` | Not yet | locale-aware string ops not modeled |
| `lastIndexOf(x, from)` (2-arg) | Not yet | falls through (bind/annotate) |

**`flatMap` / `flat` (series 085 + 092).** `xs.flatMap(f)` with a uniform
`U[]`-returning callback → `xs.iter().flat_map(f).collect::<Vec<_>>()` — the
lifted callback returns `Vec<U>` (one-level element unwrap), so `flat_map`
flattens exactly one level to `Vec<U>`. **Series 092** also lifts a **ternary**
callback `x => cond ? U : U[]`: both arms share the scalar `U`, a scalar arm is
wrapped `vec![x]`, so the lifted fn returns a uniform `Vec<U>` (homogeneous
result — no `JsonValue`). `xs.flat(k)` flattens `min(k, N)` levels, where `N` is
the receiver's statically-known nesting depth (the homogeneous dialect makes it a
compile-time constant): `xs.flat()` is depth 1, `xs.flat(Infinity)` flattens all
`N` levels to the scalar leaf, and an over-deep / already-flat `flat(k)` is a
**no-op** shallow copy (never an under-nested error). Residuals stay fail-loud →
**epic #59** (the deferred `JsonValue`-backed increment): a runtime-**variable**
`flat(n)` depth, and a genuinely-heterogeneous `(U | U[])[]` / empty-arm callback
return.

| Trigger | Kind | Message |
|---------|------|---------|
| Method call whose property is computed (`obj[key]()`, `obj["m"]()`) | Not yet | generic `Unsupported <node>` |
| Call whose callee is neither identifier nor member (`(f1 \|\| f2)()`, `(arr[0])()`) | Not yet | generic `Unsupported <node>` |
| `reduce` with no explicit initial value | Not yet | `reduce without an explicit initial value (Option-typed, a later slice)` |
| `sort` with a non-arrow comparator | Not yet | `sort with a non-arrow comparator (pass `(a, b) => …` or no argument)` |
| `flatMap` returning a heterogeneous `(U \| U[])[]` or empty array (→ #59) | Not yet | `cannot lift flatMap callback: heterogeneous array-literal return …` / `… different element types … → #59` |
| `flat(n)` with a runtime-**variable** depth (→ #59) | Not yet | generic `Unsupported <node>` (cargo-loud: `Vec` has no `.flat`) |
| Any receiver/method combination not in the supported set | Not yet | generic `Unsupported <node>` (`lowerCall` fallback) |

### Closures & callbacks

Callback arrows (to `map`/`filter`/`reduce`/`sort`/`find`/`some`/`every`/`flatMap`/`forEach`)
must have the exact arity the method expects, take plain-identifier parameters, and
have an expression body or a single `return`. An **`async`** adapter callback is
rejected in-dialect (the lift is async-aware, but driving the resulting `Vec<Future>`
to values is `Promise.all(arr.map(f))` → `join_all`, series 051) — see [async /
await](#async--await).

**Lambda lifting (series 048).** Every expression-bodied adapter callback is
*lifted* to a named top-level `fn __cb_<method>_<n>` whose params are the arrow's
own params plus its **read-only Copy free variables** (forwarded by value at a thin
shim). The body is typed by a bounded typer over the numeric surface. `forEach` is
the exception — it lowers to a `for` loop, so a mutable-accumulator body is fine.
A **function value** (an annotated `(x: T) => U` parameter/field/return) lowers to
a `fn`-pointer; a bare top-level fn or normalized arrow coerces to it
(`apply(double, 5)`).

| Trigger | Kind | Message |
|---------|------|---------|
| `async` arrow callback in an adapter (dynamic async fan-out → series 051) | Not yet | `async callback in '.<method>' — dynamic async fan-out (Promise.all(arr.map(f)) → join_all) lands in series 051` |
| Callback with the wrong parameter count | Not yet | `closure must take exactly <n> parameter(s)` |
| Callback with a destructured/patterned parameter | Not yet | `closure parameter binding` |
| Callback body that isn't an expression or a single `return` | Not yet | `closure body must be an expression or a single return` |
| Mutable capture in a lifted callback (a free var it *assigns*) | Not yet | `mutable capture in a callback (lift to a named fn taking the state as an explicit param)` |
| Lifted callback body outside the numeric surface | Not yet | `callback body too complex to lift (numeric surface only)` |
| Lifted callback free var of unknown/non-Copy type | Not yet | `cannot lift callback: free variable '<name>' has unknown type` |
| `async` `forEach` callback | Not yet | `async forEach closure` |
| `forEach` callback not taking exactly one parameter | Not yet | `forEach closure must take exactly one parameter` |

> A **capturing** arrow used as a first-class value (it reads an outer local) has no
> `fn`-pointer form → fail-loud; the user lifts it to a named fn taking the data as
> an explicit param. A `let`/`var`-bound arrow, or any other value-position arrow
> that is not a nameable non-capturing top-level fn, falls through to the generic
> expression fallback (`Not yet`).

**Captured containers (series 079/086).** A **stored** arrow `const add = (x) => { s.add(x); }`
that captures a container (`Set`/`Map`/`Array`/`String`) and is **only invoked directly**
threads the captured container as an extra leading parameter of its lifted
`__arrow_n` fn, borrowed **by need**:

- **read-only** → `&T`; **owned-mutable (non-aliased)** → `&mut T` (series 079). Each call
  `add(a)` is rewritten to `__arrow_n(&mut s, a)`, borrowing `s` only for that call.
- **shared / aliased** (the container also has an alias `const t: Set<number> = s`) →
  the whole alias closure promotes to **`Rc<RefCell<T>>`** (series 086, the settled 062
  model): the construction becomes `Rc::new(RefCell::new(…))`, the alias `Rc::clone(&s)`,
  the closure captures a **clone** of the handle, mutations go through `.borrow_mut()`, and
  every outer read (`t.size`) through `.borrow()`. This rides the **same** shared
  promoted-set (`computeAutoRc`/`refineRc`) as class aliasing — containers are one more
  alias shape, not a fork. A plain (no-closure) aliased+mutated container promotes the same
  way (the faithful JS shared-reference semantics; previously a silent `.clone()` miscompile).

| Trigger | Kind | Message |
|---------|------|---------|
| Captured-container closure that **escapes** (returned / stored / passed as a value) | Not yet | `closure '<name>' captures a container and escapes …` |
| Capture through **two closure levels** (a container from a scope > 1 level out) | Not yet | `closure captures container '<name>' from an enclosing scope more than one level out …` |
| Captured **scalar** mutable capture (`n++`) / container **rebound wholesale** (`s = new Set()`) | Not yet | `mutable capture in a closure …` |
| Owned-mutable capture in an **inline** adapter callback (numeric-surface typer) | Not yet | `cannot lift callback: free variable '<name>' …` |
| **Re-entrant** read-in-mutate of a shared `Rc<RefCell>` container (`m.set(k, m.get(k)+v)`) | Not yet | `re-entrant mutation of a shared \`Rc<RefCell>\` container '<name>' …` |

---

## Nullability & optional chaining

Absence is modeled first-class as `Option<T>` (series 066, issue #42) — **absence
is out-of-band, always `Option::None`, never an in-band value of the type**. The
settled rules:

- **Representation (A).** `null ≡ undefined` collapse to a single `Option::None`
  (both spellings accepted). An *absent value of a `T`* (`T | undefined`, optional
  field, failed lookup) is `Option<T>`; a *no-meaningful-result* (`void` fn,
  statement value) is Rust `()`. **Emptiness is never absence** — `0`, `""`, `[]`,
  empty `Map`/`Set`, and `()` are present, operable values; `Some(vec![])`
  (present-but-empty) is distinct from `None` (absent).
- **Surface (B).** `T | undefined`, `T | null`, and `?` optional fields/params all
  denote `Option<T>`. A literal `undefined`/`null` in such a slot → `None`; a value
  → `Some(v)` (let-init, arg, return, field init, **and reassignment** all coerce).
  Bare/unannotated absence stays fail-loud (`strictNullChecks`).
- **Print / collapse (C).** Canonical `None` print spelling is the literal
  `undefined`: `console.log` of a `Some(v)` renders `v`, of a `None` renders
  `undefined`. A source `null` therefore prints `undefined` (a deliberate
  divergence). A `T | null | undefined` union (carrying *both* spellings) compiles
  but records a **non-fatal 056-channel warning** — its collapsed print/`===`/
  coercion may diverge from JS. A single-spelling union warns nothing.
- **`None → T` coercion (D) — required-explicit, never automatic.** `x ?? d` →
  `unwrap_or(d)` (**absence-only**); default param `f(x = d)` → an `Option<T>` param
  plus a `let x = x.unwrap_or(d);` body prelude; non-null `x!` → `.unwrap()`
  (explicit opt-in, panics on `None`); `if (x !== undefined)` / `x != null` /
  `if (x)` narrow via `if let Some(x)`. No silent `None → T::default()`.
- **JS-truthiness (E).** `x || d` takes **full JS falsy** semantics (falsy =
  `false`/`0`/`-0`/`""`/`null`/`undefined`/`NaN`) — it is **not** `unwrap_or`. One
  shared `tslib::truthy::is_truthy` helper powers `||`, `&&`, `if (x)`, and `!x`; a
  bare-`bool` operand stays a native short-circuit op (no helper).
- **Arithmetic on optionals (F) — fail-loud.** An un-narrowed optional in a value
  position (arithmetic `optNum + 1`, or a `T`-expecting callee) without an explicit
  coercion is rejected — narrow or default first. `NaN` is a *present, invalid*
  `f64` (`0.0/0.0`), unrelated to absence, and maps straight through.

Only single-level optional chaining (`a?.b`) is built.

| Trigger | Kind | Message |
|---------|------|---------|
| Un-narrowed optional in arithmetic (`optNum + 1`) | Not yet | `arithmetic on an un-narrowed optional — narrow it (…) or coerce (…) first` |
| Un-narrowed optional passed to a `T`-expecting callee | Not yet | `an un-narrowed optional passed where '<fn>' expects a concrete value — narrow it (…) or coerce (…) first` |
| Bare `null` / `undefined` type (not inside a union) | Not yet | generic `Unsupported <node>` |
| Optional chaining deeper than one `a?.b` member (`a?.b?.c`, `a?.[i]`, `a?.()`) | Not yet | `optional chaining beyond a single `a?.b` member (deeper chains are a later slice)` |
| `T \| null \| undefined` (both spellings) | Warned (056) | `a `T \| null \| undefined` union collapses both `null` and `undefined`…` |

---

## The `@ttr/std` std-shim (series 084)

`@ttr/std` is a **third routing lane** (alongside Rust-side `tslib` and compiler
inference): a blessed TS-side surface the developer imports *instead of* footgun
APIs. The compiler recognizes it **by the reserved import specifier `"@ttr/std"`**
— never a name heuristic. It is the dialect's isolation boundary for JS-divergent
behavior: the type/policy problem moves to an explicit call-site API. The shim is
**real, Bun-resolvable TS** (`packages/std`, a workspace package) so the
differential oracle runs faithful behavior matching the emitted Rust.

`@ttr/std` is the **only** modeled import. Exports: JSON (`parseJson`,
`stringifyJson`, and the 090 `JsonValue` boundary), the 089 seeded `rng`, the
102 seeded `clock` (the differential-stable "now" — see
[Date & time](#date--time-series-102)), and the series-100 **I/O** surface (fs /
env / process / stdin / async fs / HTTP — see
[I/O via `@ttr/std`](#io-via-t2rstd-series-100) below).

- **`stringifyJson(v): string`** → the `tslib::json::stringify` writer (JS number
  fidelity: integrals no `.0`, shortest-round-trip fractions, `Infinity`/`NaN` →
  `null`). **`undefined`-omission (series 091, epic #59):** an `undefined`-only
  field (`x?: T` / `x: T | undefined`) omits its key when `None` (matching JS); a
  `null`-bearing field keeps the key as `null` ("null wins" for `T | null | undefined`).
  Provenance is recovered from the *declared* field type; the one residual (a
  both-nullable field whose key is omitted from the literal) is noted in the
  `JsonValue`/`stringifyJson` divergence bullet near the top of this doc.
- **`parseJson<T>(s: string)`** → `tslib::json::ParseResult::<T>::parse(&s)`, a
  purpose-built std-shim result type (the dialect has no generic/payload-carrying
  enum to model a raw `{ ok, value } | { ok, error }` union). `T` must be an
  explicit call type argument and a **modeled** struct/enum (or a
  primitive/`Array`/`Record`/`Option` of them) — serde's structural deserialize
  *is* the validation. Consumed via `.ok` (bool), `.value` / `.error` (accessors);
  never throws — a parse/shape error lands in the `!ok` branch. A `parseJson<T>`
  result binding needs no annotation (`<T>` carries the type).

| Trigger | Kind | Message |
|---------|------|---------|
| An import from any specifier other than `@ttr/std` **in the single-file path** (a `./`-relative import reached without the crate resolver) | Not yet | `import from '<x>' — only "@ttr/std" is a recognized module (bare/relative module imports are not yet supported)` — note: `./`-relative imports **are** shipped via the multi-file **crate** resolver (`lowerCrate`, series 050); this single-file `validate` message only fires when a relative import is compiled outside a crate entry (see [Modules](#modules-importexport-series-050)) |
| An `@ttr/std` import of a name it does not export | Not yet | `'<name>' is not exported by "@ttr/std" (Tier A exports: parseJson, stringifyJson)` |
| A non-named import form from `@ttr/std` (default/namespace) | Not yet | `unsupported import form from "@ttr/std" (only named imports are recognized)` |
| `parseJson` with no explicit type argument | Not yet | `` `parseJson<T>` needs an explicit modeled type argument (`parseJson<Point>(s)`)… `` |
| `parseJson<T>` where `T` is not a modeled struct/enum/primitive/array/record | Not yet | `` `parseJson<T>` needs a modeled struct/enum type argument… `` / `'<T>' is not a modeled struct/enum…` |
| `.<prop>` on a `parseJson` result other than `.ok`/`.value`/`.error` | Not yet | `` `.<prop>` on a parseJson result — only `.ok`, `.value`, `.error` are available `` |

## Modules (`import`/`export`, series 050)

A multi-file program is a **single Rust crate**: the CLI/harness takes an **entry**
file and follows its `./`-relative `import`s transitively (a resolver + cycle-
terminating visited set), lowering the whole graph as **one compilation unit** →
**one binary, one stdout** to diff. Each TS file → a real Rust source file
(`./math.ts` → `src/math.rs`, `./util/math.ts` → `src/util/math.rs`); the crate root
(`main.rs`) carries the entry items + `fn main` + the `pub(crate) mod …;` edges. A
single file with **no** `import`/`export` still emits via the inline fast path
(byte-unchanged). **The gate is pre-`validate`:** `lowerCrate` strips the module
plumbing while merging, and `namespace` blocks are extracted before the dialect gate
— so `Export*`/`TSModuleDeclaration` are **not** in `MODELED`; the fail-loud module
shapes reject in `lowerCrate`/`extractNamespaces` with dedicated messages.

| Shape | Rust |
|---|---|
| `export function f` / `class C` / `interface S` / `enum E` | inferred `pub`/`pub(crate)` item (visibility inference, Axis 1) |
| `import { f } from "./x"` / `import { f as g }` | `use crate::x::f;` / `use crate::x::f as g;` |
| a signature-reachable non-exported type | widened to `pub(crate)` (Rust's `private_interfaces` rule) |
| a **pure barrel** `index.ts` (only `./`-relative re-exports) | a generated `pub(crate) use` **facade** module (Axis 3); `export { x as y } from` → `… as y;` |
| `export default <fn/class>` (named) | the item + `pub(crate) use self::<name> as __default_export;` |
| `export default function () {…}` (anonymous fn/class) | a named item `__default_export` |
| `import def from "./d"` (default import) | `use crate::d::__default_export as def;` |
| `import * as ns from "./n"` (namespace import) | `use crate::n as ns;`; `ns.f()` → `ns::f()` |
| `namespace Foo { export … }` | an inline `mod Foo { pub … }`; `Foo.bar()` → `Foo::bar()`; a reopened namespace coalesces |
| (generated) prelude | an inline `mod prelude { pub(crate) use … }` gathering library exports; module files `use crate::prelude::*;` |

An **import cycle** (`A ↔ B`) is **accepted** (sibling `mod`s are mutually visible;
only the entry runs top-level statements, so there is no init-order hazard).

| Trigger (fail-loud) | Kind | Message |
|---|---|---|
| an anonymous **value** `export default 42/{}` | Not yet | `anonymous value \`export default\` (only a named fn/class default has a Rust symbol)` |
| a **glob** re-export (`export * from`) in a **mixed** (non-pure-barrel) file | Forbidden | `re-export outside a pure barrel (a mixed logic + re-export file is ambiguous)` |
| dynamic `import("./x")` (`ImportExpression`) | Not yet | `dynamic \`import()\` (only static \`import\`/\`export\` are modeled)` |
| a top-level statement in an **imported** (non-entry) module | Not yet | `top-level statement in an imported module (declarations only)` |
| a non-declaration `namespace` member (statement / bare `const` / re-export) | Not yet | `namespace member must be a declaration …` |
| a bare/package import (`import x from "lodash"`) | Not yet | `import from '<x>' — only "@ttr/std" is a recognized module …` |

**Cross-module inference (series 050, #68):** the 099 type-oracle compiles the WHOLE
crate — tsc walks the `./`-relative imports — so a **cross-module** untyped
`new`/builtin-call binding infers *through* the import, exactly as a same-file binding
does (`const p = new Point(1,2)` with an imported `Point`, or `` const g = `hi ${who()}` ``
over an imported `who()`, needs no annotation). Each module is given a disjoint offset
window so a merged AST node routes back to its owning file + file-local span; tsc parses
each file's original source, so the windows only touch the merged oxc AST.

**Mixed re-export lineage (series 050, #71):** a **named** re-export in a *mixed* file
(own declarations + `export { x } from "./y"`) is accepted — the file emits only its own
declarations, and a consumer importing a re-exported name binds directly to the module
that **defines** it (`use crate::<src>::x`), bypassing the re-exporter. The chain is
chased through mixed intermediaries (a cycle is fail-loud). Only a **glob** `export *
from` in a mixed file stays forbidden (ambiguous).

## JSON (bare `JSON.*` — forbidden, redirected to `@ttr/std`)

Bare `JSON.parse` **and** `JSON.stringify` are fail-loud and **redirect** to the
shim (series 084). The type/fidelity policy moved to the blessed call-site API
(above): `parseJson<T>` gives the emitter a concrete `from_str::<T>` target (no
`any`), and `stringifyJson` carries the number fidelity. The old 045
annotation-driven `JSON.parse` and untyped `serde_json::Value` fallback are
**removed** — the only JSON entry points are the two `@ttr/std` intrinsics.

| Trigger | Kind | Message |
|---------|------|---------|
| `JSON.stringify(...)` (bare) | Not yet | `` `JSON.stringify` is not accepted — import `stringifyJson` from "@ttr/std" and call `stringifyJson(v)` `` |
| `JSON.parse(...)` (bare, any position, annotated or not) | Not yet | `` `JSON.parse` is not accepted — import `parseJson` from "@ttr/std" and call `parseJson<T>(s)` `` |
| Any other `JSON.*` (`JSON.rawJSON`, …) | Not yet | `JSON.<name>` |

## I/O via `@ttr/std` (series 100)

The I/O surface rides the same shim lane — sync fs / env / process / stdin, async
fs, and HTTP, each recognized only by the reserved specifier and lowered to a
concrete Rust target. Every fallible op folds into the shipped `throw`↔`Result`/`?`
model (design series 049): a failing call `throw`s in the Bun run and returns
`Err` in Rust, so `try`/`catch` and propagation mirror exactly, with I/O as the
error source. Fallible tslib helpers normalize their error to `String` at the
leaf, so the emitter only ever sees `Result<_, String>` (the `String`-error spine
is intact; `?` composes into a `String`- or `AppError`-returning fn).

- **Sync fs** (`std::fs` / `tslib::io`): `readFile`/`writeFile`/`appendFile`/
  `removeFile`/`readDir`(sorted)/`mkdir`(recursive)/`removeDir`(recursive) — all
  fallible; `exists` — infallible (`false` on any error).
- **Env / process** (`std::env` / `std::process`): `env(name): string | null` →
  `Option<String>` (the 066 model; `?? d` / narrowing apply), `args(): string[]`
  (the args after the binary — `process.argv.slice(2)` parity), `exit(code): never`.
- **Stdin / streams** (`std::io` / `tslib::io`): `readStdin()` (all of stdin),
  `readLine(): string | null` (one line, newline stripped, `null` at EOF),
  `stdout()`/`stderr()` → a `Writer` handle with `write`/`writeLine`/`flush`
  (byte-precise, **infallible** — JS `process.stdout.write` doesn't throw either).
- **Async fs** (`tokio::fs`): the `fsAsync.*` namespace — `readFile`/`writeFile`/
  `readDir`/`removeFile`/`mkdir`, only valid **awaited** inside an `async` fn
  (`.await?`); an un-awaited one is the 051 un-polled-future fail-loud.
- **HTTP** (`tslib::http` over reqwest, rustls): the `http.get(url)` /
  `http.post(url, body)` namespace → a `HttpResponse` (`.status`/`.ok` fields,
  `.body` accessor). GET/POST of **text bodies only**; awaited (`.await?`).

Handle/result bindings need no annotation (typed by construction, like
`parseJson<T>`); an I/O `Vec<String>`/`Option<String>` binding is recorded so a
chained `.join(",")` / `?? d` resolves.

| Trigger | Kind | Message |
|---------|------|---------|
| Bare `fetch(...)` (Bun/Node global) | Not yet | `` `fetch` is not accepted — import `http` from "@ttr/std"… `` |
| Bare `process.argv`/`env`/`exit`/`stdin`/`stdout`/`stderr` | Not yet | `` `process.<name>` is not accepted — import `args`/`env`/`exit`/`readStdin`… `` |
| Bare `node:fs` / other-specifier import (`readFileSync`, …) | Not yet | `import from '<x>' — only "@ttr/std" is a recognized module…` |
| An `fsAsync.*` / `http.*` call **not** directly awaited (un-polled future) | Not yet | `call to an async method not directly awaited (an un-polled future never runs)` |
| An unknown `http` method (not `get`/`post`) | Not yet | `` `.<m>` on `http` — only get/post of text bodies are available `` |
| An unknown `Writer` method (not `write`/`writeLine`/`flush`) | Not yet | `` `.<m>` on a Writer — only `write`, `writeLine`, `flush` are available `` |
| `.<prop>` on an http response other than `.status`/`.ok`/`.body` | Not yet | `` `.<prop>` on an http response — only `.status`, `.ok`, `.body` are available `` |
| `await` inside a `try`/`catch` (async error recovery) | Not yet | `await inside a try/catch is not yet supported (async error recovery is a later slice)…` |
| Streaming / file-watch / raw sockets / binary file I/O / HTTP headers | Not yet | (out-of-surface — no shim entry; unknown `@ttr/std` name → `'<name>' is not exported…`) |

---

## RegExp (series 101)

A regex literal `/pat/flags` and `new RegExp("lit", "flags")` (string-literal
pattern) lower to a `tslib::regex::Regex` over the Rust `regex` crate. Because the
pattern is **statically known**, it is translated + validated **at transpile
time**: the `regex` engine is a finite automaton (linear-time, **no
backreferences, no lookaround**), so the faithful core ships and the unsupported
constructs fail loud *naming the construct* — never mistranslated. Flags `i`/`m`/`s`
fold into an inline `(?ims)` prefix; `g` is carried on the value (picks the
call-site shape); `u` is a no-op accept (Rust `regex` is Unicode by default).

The regex is a **stateless value** (sub-decision RE-STATE): the non-stateful uses
ship fully; the stateful `g`/`lastIndex`/`exec`-loop idiom is fail-loud →
`s.matchAll(re)`.

- **Regex methods**: `re.test(s)` → `bool`; a single `re.exec(s)` → the first
  match (`RegExpMatchArray | null`).
- **String methods** (the regex is the Rust receiver, the string the argument):
  `s.match(re)` → the capture array (no `g`) or the full-match list (`g`);
  `s.matchAll(re)` (requires `g`) → an iterator of match arrays; `s.replace`/
  `s.replaceAll` → `replace_first`/`replace_all` (a **string-literal** replacement
  template, `$1`/`$<name>`/`$&`/`$$` translated); `s.split(re)`; `s.search(re)` →
  the first match's **char** index (`-1` if none).
- **Match arrays**: `m![i]` (positional) and `m!.groups!.name` (named) → an
  `Option<String>` (`None` = out-of-range / non-participating → JS `undefined`,
  the 066 model). A regex binding / match result needs no annotation (typed by
  construction, like `.find`/`.at`).

Divergences (faithful-but-documented, not fail-loud): `\d`/`\w`/`\s` are
Unicode-aware in Rust `regex` (JS is ASCII-ish) — faithful for ASCII input; a
capturing split (`/(sep)/`) drops the captured separators (JS keeps them); offsets
are **char** indices (the 083/098 char-indexed model, not UTF-16 code units); a
`matchAll` non-participating group renders `""` (not `undefined`).

| Trigger | Kind | Message |
|---------|------|---------|
| A backreference (`\1`, `\k<name>`) in a literal pattern | Not yet | `` a backreference (`\1`) is not supported by the Rust `regex` engine… `` |
| Lookahead (`(?=…)`/`(?!…)`) / lookbehind (`(?<=…)`/`(?<!…)`) | Not yet | `` lookahead `(?=…)` is not supported… `` / `` lookbehind `(?<=…)`… `` |
| The sticky `y` flag / the `d` (hasIndices) flag | Not yet | `` the sticky `y` flag … is not modeled `` / `` the `d` (hasIndices…) flag is not modeled `` |
| `re.lastIndex` read/write | Not yet | `` `RegExp.lastIndex` (stateful matching) is not modeled … use `s.matchAll(re)` `` |
| A stateful `exec` loop (`while ((m = re.exec(s)))`) | Not yet | `` the stateful `RegExp.exec` loop is not modeled — use `s.matchAll(re)` `` |
| `new RegExp(runtimeVar)` (non-literal pattern) | Not yet | `` a `RegExp` built from a non-literal pattern cannot be validated … inline the pattern as a literal `` |
| A function replacer `s.replace(re, (m) => …)` | Not yet | `` a function replacer in `.replace` is not modeled (v1) — use a string replacement template `` |
| The `` $` `` / `$'` (before-/after-match) replacement specials | Not yet | `` the `` $` `` / `$'` … replacement specials have no Rust `regex` equivalent `` |
| `s.matchAll(re)` / `s.replaceAll(re, …)` without the `g` flag | Not yet | `` `s.matchAll(re)` requires the `g` flag on the regex (as in JS) `` |

---

## Date & time (series 102)

`new Date(...)` lowers to a `tslib::date::Date` over the `chrono` crate — a
**deterministic instant algebra**: construct from epoch-ms, a strict ISO-8601
string, or 0-based-month calendar fields; read fields back; format. Because it is
a pure function of its inputs it is fully differential-stable. Date **arithmetic
and comparison go through epoch-ms** (`a.getTime() < b.getTime()`,
`new Date(d.getTime() + 86_400_000)`) — plain `number` operations, no new
machinery; a bare `date < date` (implicit `valueOf`) is not accepted.

The **wall-clock reader** (`Date.now()`, no-arg `new Date()`) reads the host
clock, so like `Math.random` it cannot be differential — it is fail-loud,
redirected to a seeded `clock(epochMs)` from `@ttr/std` (a `tslib::date::Clock`
handle with `now()` / `date()` / `tick(ms)`, the direct twin of `rng(seed)`). The
seed is an explicit call-site argument, so both runtimes observe the same instant.

- **Construction**: `new Date(ms)` → `from_epoch_ms`; `new Date(isoString)` →
  `parse_iso` (**strict** RFC3339 / `YYYY-MM-DD` only); `new Date(y, m0, d, …)` →
  `from_parts` (month is **0-based**, JS semantics).
- **Accessors** (all `→ number`): `getTime`, `getFullYear`, `getMonth` (0-based),
  `getDate`, `getDay` (Sun=0), `getHours`/`getMinutes`/`getSeconds`/
  `getMilliseconds`, `getTimezoneOffset`. The `getUTC*` twins are accepted and
  **the short local names alias them** (see the timezone note). A Date binding
  needs no annotation (typed by construction).
- **Formatting**: `toISOString()` / `toJSON()` → `YYYY-MM-DDTHH:mm:ss.sssZ` (exact
  JS shape — literal `Z`, 3-digit ms); `toDateString()` → the fixed English
  `"Www Mmm DD YYYY"` (hand-written, no locale).

**Timezone divergence (documented, not fail-loud):** all instants are UTC
internally and the short local accessors are **UTC-normalized**
(`getHours ≡ getUTCHours`, `getTimezoneOffset ≡ 0`). On a non-UTC host, stock JS
`getHours()` would return the local hour; here it returns the UTC hour. This is
internally consistent and differential-stable (the harness also pins `TZ=UTC` on
the oracle run). Real per-zone fidelity is a future graduation.

| Trigger | Kind | Message |
|---------|------|---------|
| Bare `Date.now()` | Not yet | `` `Date.now()` reads the host wall-clock … call `clock(epochMs).now()` `` |
| No-arg `new Date()` | Not yet | `` no-arg `new Date()` reads the host wall-clock … call `clock(epochMs)` `` |
| Loose-format parse (`new Date("Nov 14 2023")`) | Not yet | `` …is a loose date string — only strict RFC3339 … are accepted `` |
| A setter (`d.setFullYear(…)`, `setTime`, …) | Not yet | `` …Date setters are not accepted (Date is immutable …; construct a new Date from ms) `` |
| A locale formatter (`toLocaleDateString`, …) | Not yet | `` …locale formatting is non-portable and not modeled … `` |
| An unknown method on a Date | Not yet | `` …on a Date — only the get*/getUTC* accessors, `toISOString`, `toJSON`, `toDateString` are available `` |

---

## Directives (`"use …"` string prologues)

Recognized: `"use strict"` (ignored), `"use panic"`, `"use rc"`, `"use arena"`.
Strategy directives are only valid on a free function or at script scope.

`"use rc"` (`Rc<RefCell<T>>`) covers, within its scope: class-typed local bindings,
**method calls** (receiver routed `.borrow()`/`.borrow_mut()`), **fields / params**
(analysis-promoted), and **cross-call** values — passing an rc binding into an
analysis-promoted callee param clones the handle (`Rc::clone(&x)`), and a *read*
into a **non-promoted** param of the inner class type wraps `f(&a.borrow())`
(series 087). A `refMut`/owned use of an rc binding into a non-promoted position
(e.g. `Vec<T>::push(a)`, or a cross-fn self-referential write `x.v = x.v + 1` that
re-borrows one cell) stays **cargo-loud** — never silent.

`"use arena"` (bumpalo) covers: `array`-literal and `string`-literal `let` inits →
`bumpalo::vec![in &arena; …]` / `bumpalo::collections::String::from_str_in(…, &arena)`,
**recursively** (a nested `[[…]]` / `["…"]` allocates every level from the arena;
series 087). An arena value that **escapes** its scope (returned, stored past the
arena's lifetime, an explicit-`'a` signature/field) is a Rust lifetime error
**cargo rejects** — cargo is the escape analysis, so escape stays fail-loud.

| Trigger | Kind | Message |
|---------|------|---------|
| An unrecognized `"use …"` directive | Forbidden | `unrecognized directive "<d>"` |
| `"use panic"` outside a free function / script scope (e.g. in a method) | Not yet | `` `use panic` outside a free function or the top-level script `` |
| `"use rc"` outside a free function / script scope | Not yet | `` `use rc` outside a free function or the top-level script `` |
| `"use arena"` outside a free function / script scope | Not yet | `` `use arena` outside a free function or the top-level script `` |

---

## Numeric inference

`numeric.ts` refines `number` to `usize` (array indices) or `i64` (integer
`switch` discriminants). It fails loud on genuine contradictions, never silently.

| Trigger | Kind | Message |
|---------|------|---------|
| A `usize`-index value used in float arithmetic | Not yet | `numeric conflict: a usize index value used in float arithmetic` |
| A fractional or negative literal in a `usize` context | Not yet | `value <n> cannot be a usize index` |
| A fractional (or, for `usize`, negative) literal passed to a `usize`/`i64` parameter | Not yet | `non-integer literal <n> passed to a <usize\|i64> parameter` |
| A non-literal value passed to a `usize`/`i64` parameter that isn't already a `usize` identifier | Not yet | `inter-procedural integer inference: a non-literal value passed to a <kind> parameter is not yet supported (pass an integer literal, or index within the callee)` |

---

## Identifier hygiene

The emitter is otherwise pure and total. Its single throw is a **defensive
invariant guard**: most Rust keyword collisions are auto-escaped as raw
identifiers (`r#match`), but three keywords cannot be.

| Trigger | Kind | Message |
|---------|------|---------|
| A user identifier named `crate`, `super`, or `Self` (no valid raw form) | Not yet | `identifier '<name>' collides with a Rust keyword that cannot be a raw identifier` |

---

## Forbidden flags & meta (validator)

Rejected wherever they appear, regardless of feature:

| Trigger | Kind | Message |
|---------|------|---------|
| `any` type | Forbidden | `` `any` type `` |
| `unknown` type | Forbidden | `` `unknown` type `` |
| Decorators (`@decorator`) | Forbidden | `decorators (`@decorator`)` |
| `abstract` class | Forbidden | `` `abstract` classes `` |
| `declare` (ambient) declarations | Forbidden | `` `declare` (ambient) declarations `` |
| `async function*` | Forbidden | `async generator functions (`async function*`)` |
| Generator method / expression | Forbidden | `generator methods / expressions (`function*`)` |
| `for await` | Forbidden | `` `for await` async iteration `` |
| `await using` | Forbidden | `` `await using` (async resource disposal) `` |

---

## The default-deny allowlist (parse gate)

The validator carries a `MODELED` set of ~80 ESTree node types. **Any node whose
`type` is not in the set is rejected** with a generic `Unsupported <NodeType>`
before lowering even runs — so a construct the compiler has never heard of can
never slip through as silent wrong output. This is why the tables above end with
"any other …" rows: those collapse into this default-deny.

The currently-modeled node types are:

`Program` · `VariableDeclaration` · `VariableDeclarator` · `FunctionDeclaration` ·
`BlockStatement` · `ReturnStatement` · `ExpressionStatement` · `IfStatement` ·
`WhileStatement` · `ForStatement` · `ForOfStatement` · `SwitchStatement` ·
`SwitchCase` · `BreakStatement` · `ContinueStatement` · `LabeledStatement` ·
`ThrowStatement` · `TryStatement` · `CatchClause` · `TSInterfaceDeclaration` ·
`TSInterfaceBody` · `TSPropertySignature` · `TSMethodSignature` ·
`TSClassImplements` · `ClassDeclaration` · `ClassBody` · `PropertyDefinition` ·
`MethodDefinition` · `FunctionExpression` · `TSParameterProperty` ·
`TSEnumDeclaration` · `TSEnumBody` · `TSEnumMember` · `Identifier` · `Literal` ·
`TemplateLiteral` · `TemplateElement` ·
`BinaryExpression` · `LogicalExpression` · `UnaryExpression` ·
`ConditionalExpression` · `AssignmentExpression` · `UpdateExpression` · `CallExpression` ·
`MemberExpression` · `ArrayExpression` · `ObjectExpression` · `Property` ·
`ThisExpression` · `Super` · `NewExpression` · `ParenthesizedExpression` ·
`AwaitExpression` · `ArrowFunctionExpression` · `YieldExpression` ·
`TSNonNullExpression` · `AssignmentPattern` · `ChainExpression` · `ArrayPattern` ·
`ObjectPattern` · `RestElement` · `TSInterfaceHeritage` · `SpreadElement` · `TSTypeAnnotation` ·
`TSTypeReference` · `TSTypeParameterInstantiation` · `TSTypeParameterDeclaration` ·
`TSTypeParameter` · `TSIntersectionType` · `TSArrayType` · `TSNumberKeyword` ·
`TSStringKeyword` · `TSBooleanKeyword` · `TSVoidKeyword` · `TSFunctionType` ·
`TSUnionType` · `TSUndefinedKeyword` · `TSNullKeyword` · `TSAnyKeyword` ·
`TSUnknownKeyword` · `ImportDeclaration` · `ImportSpecifier`.

In `MODELED`, `ImportDeclaration`/`ImportSpecifier` are gated for the `@ttr/std`
std-shim (series 084) — a guard rejects any other specifier and any unknown
`@ttr/std` name. **General `./`-relative module imports (series 050) are shipped**,
but through the **crate** path: `lowerCrate` strips `Import*`/`Export*` while merging
and `extractNamespaces` pulls `namespace` blocks out — both **before** `validate` —
so `Export*` and `TSModuleDeclaration` never reach the gate and are deliberately
**not** in `MODELED` (see [Modules](#modules-importexport-series-050)).

Notable node types **not** modeled (rejected at the gate): `EmptyStatement`,
`DebuggerStatement`, `DoWhileStatement`, `WithStatement`, `SequenceExpression`,
`UpdateExpression`, `TaggedTemplateExpression`, `TemplateLiteral`,
`TSAsExpression`, `RestElement`, `MetaProperty`, and `ImportExpression` (dynamic
`import()`). `export` syntax / `namespace` / non-`@ttr/std` `import`s are handled
**pre-`validate`** in the crate + namespace paths (series 050), not at this gate.

---

## Maintaining this catalog

This document mirrors the throw sites in `validate.ts`, `lower.ts`, `numeric.ts`,
and `emitter.ts` and the `MODELED` allowlist in `validate.ts`. When a fail-loud
case is **added** (new restriction) or **graduated** (a deferral becomes real
support), update the matching row here in the same change. The messages are the
stable anchors — grep the source for the quoted string to find its site.
