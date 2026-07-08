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

- **Explicit type annotations** on every variable, function parameter, and
  function return type. Exception: a binding whose initializer is a
  statically-obvious literal — a scalar (`const n = 5`, `const s = "hi"`,
  `const b = true`) or a **non-empty, homogeneous scalar-literal array**
  (`const xs = [1, 2, 3]`, `["a", "b"]`, `[true, false]`) — may be left untyped
  (series 046). Builtin forms the compiler types by construction are likewise
  exempt: a stored `Object.entries(…)`, an untyped `JSON.parse(…)` (→ `Value`),
  an `<array>.find(…)`, and a `using` resource. Everything else — a call to a
  user function, arithmetic, `-5`, `null`/`undefined`, a bare identifier, a
  member access, a template literal, an empty/mixed/nested array — must be
  annotated. A **missing function/method return type** is likewise fail-loud
  (it no longer defaults to `-> ()`); annotate `: void` for a unit return.
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
  silent miscompile.

---

## Types & the accepted type surface

The accepted type annotations are exactly: `number`, `string`, `boolean`, `void`,
`Array<T>` / `T[]`, `Record<string, V>`, `Promise<T>`, a declared `interface` /
`class` name (nominal `struct`), and `T | undefined` / `T | null` (→ `Option<T>`).
Everything else is fail-loud.

| Trigger | Kind | Message |
|---------|------|---------|
| `any` type anywhere | Forbidden | `` `any` type `` |
| `unknown` type anywhere | Forbidden | `` `unknown` type `` |
| Bare `Array` with no element type | Not yet | generic `Unsupported <node>` |
| Bare `Promise` with no inner type | Not yet | generic `Unsupported <node>` |
| `Record<K, V>` missing key or value type | Not yet | generic `Unsupported <node>` |
| `Record<number, V>` / non-string key | Not yet | `Record with a non-string key (only string keys map to HashMap)` |
| Unknown/undeclared type name (`Map`, `Set`, `Date`, an unresolved generic, …) | Not yet | generic `Unsupported <node>` |
| Bare `null` / `undefined` type (not inside a union) | Not yet | generic `Unsupported <node>` |
| A union whose non-nullish member count ≠ 1 (`string \| number`, enum-like unions) | Not yet | generic `Unsupported <node>` |
| Any other type keyword/form: `bigint`, `symbol`, tuple, function type, intersection, mapped, conditional, indexed-access, literal type, `typeof` query, type predicate | Not yet | generic `Unsupported <node>` |

Nullability note: `T | undefined` and `T | null` lower to `Option<T>`. That is the
*only* accepted union shape — see [Nullability & optional chaining](#nullability--optional-chaining).

---

## Variables & bindings

| Trigger | Kind | Message |
|---------|------|---------|
| Uninitialized binding (`let x: T;` with no initializer) | Not yet | `uninitialized binding` |
| Destructuring binding (`const {a} = …` / `const [a] = …` in a plain `let`/`const`) | Not yet | `destructuring binding` |
| Parameter without a type annotation | Not yet | `parameter '<name>' without a type annotation` |
| An untyped binding outside the obvious-literal exception (scalar or homogeneous scalar-literal array), excluding the builtin `Object.entries`/`JSON.parse`/`.find`/`using` forms | Not yet | `binding '<name>' without a type annotation` |

> Array-destructuring `[k, v]` *is* supported in one place only: a `for-of` head
> over `Object.entries(...)`. See [Control flow](#control-flow--loops).

---

## Functions

| Trigger | Kind | Message |
|---------|------|---------|
| Anonymous function declaration (no name) | Not yet | generic `Unsupported <node>` |
| Function without a body | Not yet | `function without a body` |
| Function without a return-type annotation (was a silent `-> ()`) | Not yet | `function '<name>' without a return type annotation` |
| Method without a return-type annotation | Not yet | `method '<name>' without a return type annotation` |
| Top-level script statements alongside a user-defined `main()` | Not yet | `top-level statements alongside a user-defined main()` |

---

## Generators

Only the simplest finite shape is modeled: a **named, non-async `function*`** whose
body is a straight-line sequence of `yield <value>;` statements, annotated
`Generator<T>` / `IterableIterator<T>` / `Iterable<T>`.

| Trigger | Kind | Message |
|---------|------|---------|
| `async function*` (async generator) | Forbidden | `async generator functions (`async function*`)` |
| Generator method or generator *expression* (`function*` not a top-level decl) | Forbidden | `generator methods / expressions (`function*`)` |
| Anonymous generator | Not yet | generic `Unsupported <node>` |
| Generator with no `Generator<T>` / `IterableIterator<T>` return annotation | Not yet | `generator without a `Generator<T>` / `IterableIterator<T>` return annotation` |
| That annotation missing its item type argument | Not yet | `generator without an item type` |
| Generator without a body | Not yet | `generator without a body` |
| Body is not a straight-line sequence of `yield` (loops, conditionals, locals, any non-yield statement) | Not yet | `generator body is not a straight-line sequence of `yield` (state-machine generators are a later slice)` |
| `yield*` delegation | Not yet | `` `yield*` delegation `` |
| Bare `yield` with no value | Not yet | `bare `yield` (no value)` |

---

## Classes

Modeled: a **named** class with instance fields (all explicitly typed), an explicit
field-initializing constructor, and instance methods. **Single-`extends` class
inheritance** (series 053) is modeled via a composition + trait hybrid; no statics,
no accessors, no generics.

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
| `implements` / interface conformance | Not yet | `class inheritance (implements / interface conformance)` |
| `class extends` a non-identifier / non-declared base | Not yet | `class extends a non-identifier base` / `class extends '<name>' which is not a declared class` |
| Subclass constructor with no `super(...)` | Not yet | `subclass constructor without a \`super(...)\` call (base field uninitialized)` |
| Subclass-only field read through a `dyn IA` (downcast) | Not yet | `field '<name>' read through a 'dyn I<Base>' is not a shared/base field (downcast — deferred to #17)` |
| `static` or computed-name field | Not yet | `static/computed class field` |
| Class field without a type annotation | Not yet | `class field '<name>' without a type` |
| Parameter property (`constructor(public x: T)`) without a type | Not yet | `parameter property '<name>' without a type` |
| `static` or computed-name method | Not yet | `static/computed class method` |
| `get` / `set` accessor | Not yet | `class get accessor` / `class set accessor` |
| Class with no explicit constructor | Not yet | `class without an explicit constructor` |
| `async` method | Not yet | `async method (async only on free functions this slice)` |
| Method without a body | Not yet | `method without a body` |
| `[Symbol.dispose]()` method without a body | Not yet | `[Symbol.dispose] without a body` |

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

## Interfaces

| Trigger | Kind | Message |
|---------|------|---------|
| `interface extends` (inheritance) | Not yet | `interface extends (inheritance)` |
| A member that is not a plain (non-computed) property signature (methods, index signatures, call signatures) | Not yet | `unsupported interface member` |
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
| Any statement type not modeled (`LabeledStatement`, `EmptyStatement`, `DebuggerStatement`, bare nested `BlockStatement`, `with`, …) | Not yet | generic `Unsupported <node>` |

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

Modeled: a free `async function` → `async fn`; `Promise<T>` return → `T`;
`await asyncFn(...)` → `.await`. Un-polled futures and cross-cutting async are
rejected.

| Trigger | Kind | Message |
|---------|------|---------|
| `await using` (async resource disposal) | Forbidden | `` `await using` (async resource disposal) `` |
| `await` of a non-call expression (`await x`, `await x.m()`) | Not yet | `await of a non-call expression (only `await asyncFn(...)`)` |
| `await` of a call to a non-async / non-free function | Not yet | `await of a call to a non-async function` |
| Calling an async function without directly awaiting it (un-polled future) | Not yet | `call to an async function not directly awaited (an un-polled future never runs)` |
| `async` method (see [Classes](#classes)) | Not yet | `async method (async only on free functions this slice)` |
| `async` arrow closure (see [Closures](#closures--callbacks)) | Not yet | `async arrow closure` |

---

## Operators

| Trigger | Kind | Message |
|---------|------|---------|
| Logical operator other than `&&`, `\|\|`, `??` | Not yet | `logical operator '<op>'` |
| Unary operator other than `-`, `!` (i.e. `+`, `~`, `typeof`, `void`, `delete`) | Not yet | `unary operator '<op>'` |
| `UpdateExpression` (`++`/`--`), `ConditionalExpression` (`?:`), `SequenceExpression` (comma), tagged/template literals, and any other unmodeled expression | Not yet | generic `Unsupported <node>` |

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
`reduce`, `sort`, `find`, `some`, `every`, `at`, `slice`, `forEach`; string
`padStart`, `padEnd`; `Object.*` (above); `JSON.*` (below).

| Trigger | Kind | Message |
|---------|------|---------|
| Method call whose property is computed (`obj[key]()`, `obj["m"]()`) | Not yet | generic `Unsupported <node>` |
| Call whose callee is neither identifier nor member (`(f1 \|\| f2)()`, `(arr[0])()`) | Not yet | generic `Unsupported <node>` |
| `reduce` with no explicit initial value | Not yet | `reduce without an explicit initial value (Option-typed, a later slice)` |
| `sort` with a non-arrow comparator | Not yet | `sort with a non-arrow comparator (pass `(a, b) => …` or no argument)` |
| Any receiver/method combination not in the supported set | Not yet | generic `Unsupported <node>` (`lowerCall` fallback) |

### Closures & callbacks

Callback arrows (to `map`/`filter`/`reduce`/`sort`/`find`/`some`/`every`/`forEach`)
must be non-async, have the exact arity the method expects, take plain-identifier
parameters, and have an expression body or a single `return`.

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
| `async` arrow callback | Not yet | `async arrow closure` |
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

---

## Nullability & optional chaining

`T | undefined` / `T | null` → `Option<T>`; `??` → `unwrap_or`; `=== undefined` /
`=== null` narrows via `if let`. Only single-level optional chaining is built.

| Trigger | Kind | Message |
|---------|------|---------|
| Optional chaining deeper than one `a?.b` member (`a?.b?.c`, `a?.[i]`, `a?.()`) | Not yet | `optional chaining beyond a single `a?.b` member (deeper chains are a later slice)` |

---

## JSON

Supported: `JSON.stringify` (JS number fidelity via `tslib`), annotation-driven
`JSON.parse` (`from_str::<T>`), and an untyped `serde_json::Value` fallback.

| Trigger | Kind | Message |
|---------|------|---------|
| Any `JSON.*` other than `stringify` / `parse`, or `stringify` with a replacer/space argument (wrong arity) | Not yet | `JSON.<name>` |

---

## Directives (`"use …"` string prologues)

Recognized: `"use strict"` (ignored), `"use panic"`, `"use rc"`, `"use arena"`.
Strategy directives are only valid on a free function or at script scope.

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

The validator carries a `MODELED` set of ~60 ESTree node types. **Any node whose
`type` is not in the set is rejected** with a generic `Unsupported <NodeType>`
before lowering even runs — so a construct the compiler has never heard of can
never slip through as silent wrong output. This is why the tables above end with
"any other …" rows: those collapse into this default-deny.

The currently-modeled node types are:

`Program` · `VariableDeclaration` · `VariableDeclarator` · `FunctionDeclaration` ·
`BlockStatement` · `ReturnStatement` · `ExpressionStatement` · `IfStatement` ·
`WhileStatement` · `ForStatement` · `ForOfStatement` · `SwitchStatement` ·
`SwitchCase` · `BreakStatement` · `ContinueStatement` · `ThrowStatement` ·
`TryStatement` · `CatchClause` · `TSInterfaceDeclaration` · `TSInterfaceBody` ·
`TSPropertySignature` · `ClassDeclaration` · `ClassBody` · `PropertyDefinition` ·
`MethodDefinition` · `FunctionExpression` · `TSParameterProperty` ·
`TSEnumDeclaration` · `TSEnumBody` · `TSEnumMember` · `Identifier` · `Literal` ·
`BinaryExpression` · `LogicalExpression` · `UnaryExpression` ·
`AssignmentExpression` · `CallExpression` · `MemberExpression` · `ArrayExpression` ·
`ObjectExpression` · `Property` · `ThisExpression` · `Super` · `NewExpression` ·
`ParenthesizedExpression` · `AwaitExpression` · `ArrowFunctionExpression` ·
`YieldExpression` · `ChainExpression` · `ArrayPattern` · `SpreadElement` ·
`TSTypeAnnotation` · `TSTypeReference` · `TSTypeParameterInstantiation` ·
`TSNumberKeyword` · `TSStringKeyword` · `TSBooleanKeyword` · `TSVoidKeyword` ·
`TSUnionType` · `TSUndefinedKeyword` · `TSNullKeyword` · `TSAnyKeyword` ·
`TSUnknownKeyword`.

Notable node types **not** modeled (rejected at the gate): `LabeledStatement`,
`EmptyStatement`, `DebuggerStatement`, `DoWhileStatement`, `WithStatement`,
`ConditionalExpression`, `SequenceExpression`, `UpdateExpression`,
`TaggedTemplateExpression`, `TemplateLiteral`, `TSAsExpression`,
`TSNonNullExpression`, `ObjectPattern`, `RestElement`, `MetaProperty`,
`ImportExpression`, and all module `import`/`export` syntax.

---

## Maintaining this catalog

This document mirrors the throw sites in `validate.ts`, `lower.ts`, `numeric.ts`,
and `emitter.ts` and the `MODELED` allowlist in `validate.ts`. When a fail-loud
case is **added** (new restriction) or **graduated** (a deferral becomes real
support), update the matching row here in the same change. The messages are the
stable anchors — grep the source for the quoted string to find its site.
