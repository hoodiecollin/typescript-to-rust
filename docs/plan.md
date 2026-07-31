# TypeScript → Rust Translator — Plan

> **Status of this document (2026-07-18):** historical status/architecture record,
> not the live backlog. The **architecture, memory-model decision, and pipeline
> intent below remain authoritative.** The **feature-status prose is a snapshot**
> that lags the code: much of what the "Type mapping" table and Status section below
> call "deferred" (async methods & arrows, class inheritance/generics, `try`/`catch`,
> Map/Set methods, unions, the `Option` model for `?? `/`undefined`, modules, the
> `@ttr/std` shim, sync generators, RegExp/Date) has since **shipped** through series
> 102 — see `docs/work/_archive/` and the git log. The live backlog is **GitHub
> Issues** + the [TTR Roadmap project](https://github.com/users/hoodiecollin/projects/4).

## Goal (scoped honestly)

Translate a **strict, explicitly-enforced subset of TypeScript** into **idiomatic
Rust** (the "Option A" memory model — see below). This is a language-level
translator: no Node/Bun APIs. It is deliberately **not** "compile any TypeScript":
TS's type system is unsound and its GC semantics (shared mutable aliasing, cyclic
references, dynamic object shapes) have no total mapping onto Rust's affine
ownership. Tractability comes from restricting the input, not from heroics in the
backend. The accepted subset is specified in [dialect.md](./dialect.md) and is
**enforced** — input outside it is rejected, never silently mistranslated.

## Memory model: Option A (idiomatic borrows) — DECIDED

Two models were on the table:

- **Option A — idiomatic ownership.** Emit plain Rust (`T`, `&T`, `&mut T`,
  moves). Fast, idiomatic output. Cost: requires real **escape/mutation
  analysis** to choose ownership soundly.
- **Option B — managed memory.** Wrap everything in `Rc<RefCell<T>>` to mimic GC.
  Trivial to emit, but slow, unidiomatic, and lock/refcount-heavy.

**We chose Option A.** The whole point of targeting Rust is idiomatic, fast
output; Option B would make the project pointless. The consequence is explicit
and owned: **ownership inference is the central technical problem of this
project, not a footnote.** It gets first-class, multi-pass treatment below.
`Rc<RefCell<T>>` remains available as a *local* fallback for the rare in-dialect
shape that genuinely needs shared mutability, but it is the exception, not the
strategy.

## Pipeline

```
.ts source
  │  oxc-parser (parseSync → ESTree AST; see architecture.md for the ESTree gotcha)
  ▼
1. Parse
  │
  ▼
2. Dialect validation        reject anything outside dialect.md — FAIL LOUD
  │  (validate.ts)           `DialectError`. Enforces `any`/`unknown` today;
  │                          untyped bindings et al. are pending slices.
  ▼
3. Symbol table & scopes     resolve every identifier to a declaration
  │
  ▼
4. Typed HIR                 AST → IR carrying resolved types + binding info
  │
  ▼
5. Ownership & mutation      THE hard pass. Per binding/param, infer
   analysis                  move / &T / &mut T from how it is read, mutated,
  │                          aliased, returned, and passed to callees.
  ▼
6. Rust emission             HIR → idiomatic Rust string
  │
  ▼
7. rustfmt                   normalize formatting
  ▼
.rs output  ──►  verification harness: cargo check + cargo run (the oracle)
```

Note: there is **one** IR (HIR). The earlier draft mentioned both "HIR" and
"MIR" inconsistently; we lower TS-AST → HIR → Rust and do not maintain a
separate MIR.

## The oracle: compile and run, never string-match

Correctness is judged by a **real Rust toolchain**, driven by a Bun-based
harness (`packages/compiler/src/harness`):

- **Tier 1 — COMPILES:** emit Rust, `cargo check` it (as a library, so
  bare-function snippets verify without a `main`). Structured JSON diagnostics
  (error code, message, span) come back, so failures are explainable and can be
  mapped to TS source.
- **Tier 2 — BEHAVES:** for complete programs, run the TypeScript (via Bun) and
  the emitted Rust (via `cargo run`) and assert their stdout matches —
  differential testing.

The previous approach (string-equality against hand-written `.rs` golden files)
was retired: it is brittle to formatting, rejects idiomatic-but-different output,
and — as several of the original fixtures proved — let invalid Rust (e.g. bare
`let` at module scope) masquerade as a passing oracle. See
[architecture.md](./architecture.md) for the harness design.

## Type mapping (current + intended)

> Snapshot ~series 037. Several "deferred" notes below have **shipped** since
> (class inheritance/generics 053/081, async methods/arrows 054, `try`/`catch`
> 021, Map/Set methods 041/061/072, the `Option` model for `undefined`/`??` 066,
> unions 093). Treat the *type-mapping shapes* as authoritative and the *deferral
> annotations* as historical; the code + `_archive/` are ground truth.

| TypeScript            | Rust (today)                  | Notes |
|-----------------------|-------------------------------|-------|
| `number`              | `f64`, `usize` for indices, `i64` for integer discriminants | Numeric inference (`numeric.ts`) refines index-reached values to `usize` so `Vec` indexing compiles, and an integer `switch` discriminant to `i64` (literal-pattern `match`, series 019). General `i64` counter inference is future work. |
| `string`              | `String`, or `&str` for read-only params | Read-only string params refine to `&str` (`strings.ts`); owned params stay `String`, mutated stay `&mut String`. |
| `boolean`             | `bool`                        | |
| `Array<T>` / `T[]`    | `Vec<T>`                      | ownership pass picks `Vec<T>` / `&Vec<T>` / `&mut Vec<T>`. |
| `Record<string, T>`   | `HashMap<String, T>`          | Done: type + literal construction (`HashMap::from`) + string-literal lookup (`lower.ts`). String keys only (`f64` isn't `Hash`/`Eq`); mutation/methods/variable keys deferred. |
| `interface` / object  | `struct`                      | Done: `interface` → `struct` item + named-struct literals (`lower.ts`, resolved via `analysis.structs`). Optional/readonly/nested fields and inheritance deferred. |
| `class`               | `struct` + `impl`             | Done: fields + field-init `constructor` → `new` + methods (`&self`/`&mut self`), `this`→`self`, `new C()`→`C::new()` (`lower.ts`). No inheritance/statics/accessors/generics; method-param borrows and implicit constructors deferred. Shared-mutable instances would need the `Rc<RefCell>` fallback. |
| `throw` / `try`       | `Result<T, E>` + `?`          | Done (propagation): a throwing/thrower-calling function returns `Result<T, String>`, `throw new Error(msg)` → `Err(msg)`, returns wrap in `Ok`, callers `?`-propagate (`main` too). **not** `panic!` (changes catch semantics). `try`/`catch`, custom error types, throw-in-method/`async` deferred. |
| `async` / `await`     | `async fn` / `.await`         | Done: a free `async function` → `async fn`, `Promise<T>` return → `T`, `await asyncFn(...)` → `.await`; a script that awaits gets a `#[tokio::main] async fn main()`. Un-awaited async calls, `await` of a sync call, async methods, and `Promise` combinators/concurrency deferred (fail-loud). |
| `any` / `unknown`     | `ts_primitives::TsAny`        | escape hatch only. |

## Status

**Done**
- Verification harness (cargo check/run + structured diagnostics + rustfmt,
  offline-first with online fallback), proven by self-tests in
  `tests/harness.test.ts` — including a tokio async program.
- `ts-primitives` runtime crate with a real, tested `TsAny` (Option-A minimal).
- Typed emitter (off `any`, against a verified ESTree AST subset) producing
  *complete, compilable* modules — top-level script statements are wrapped in a
  generated `fn main()`.
- Working vertical slice (variables, mutability, functions, binary ops,
  `console.log`) that compiles **and** passes a differential run.
- **Ownership spike** (`src/analysis.ts`): intra-procedural parameter ownership
  (`T` / `&T` / `&mut T`) + usage-based local mutability, with call-site argument
  adaptation. Unlocks all three `10_ownership` fixtures + basic arrays. Rules
  unit-tested in `tests/analysis.test.ts`.
- **Typed HIR layer** (`src/hir.ts` + `src/lower.ts`): the pipeline is now
  AST → HIR → Rust. Lowering is the single dialect gate — it consumes the
  ownership analysis once and bakes resolved `RustType`s, borrow forms, `mut`-ness,
  and call-site borrows into the IR. The emitter (`src/emitter.ts`) is a pure, total
  HIR → string function with no analysis and no rejection. Side tables are an
  internal detail of lowering, no longer threaded downstream.
- **Numeric inference** (`src/numeric.ts`): a post-lowering HIR→HIR pass refining
  `number → usize` where array indexing demands it, propagating usize-ness through
  initializers and integer arithmetic and failing loud on an int/float conflict.
  Unblocks variable array indexing (`arr[i]`, `arr[i + 1]`). Two *preferring*
  integer promotions layer on top (series 019/020, each with a valid f64 fallback,
  never fail-loud): `promoteIntegerMatches` retypes an integer-safe `switch`
  discriminant to `i64` and emits literal-pattern `match` arms (a whole-program
  transform — integer-literal call args at that param retype too; a non-literal
  caller keeps the guarded f64 form), and `promoteRanges` rewrites a canonical
  `usize` counting `for` into a `for i in a..b` range. General `i64` counter
  inference (bare, non-index, non-discriminant counters) remains future work.
- **String-borrow inference** (`src/strings.ts`): a post-lowering HIR→HIR pass
  refining a read-only `string` parameter's `&String` into the idiomatic `&str`.
  Owned params stay `String`, mutated stay `&mut String`; call sites are unchanged
  (`&String` coerces to `&str`).
- **Dialect validation — default-deny** (`src/validate.ts`, series 024): pipeline
  step 2, run first in `lower()`, now a whole-tree gate on the accepted node
  vocabulary. Three rules: (a) forbidden *types* (`any`/`unknown`) → `DialectError`;
  (b) forbidden *flags* on modeled nodes → `DialectError` — generators
  (`function*`), `for await`, `using`/`await using`, decorators, `abstract`,
  `declare` (these previously slipped through and were *silently mistranslated* —
  the fail-loud hole 024 closes); (c) any node whose `type` is not in the
  `MODELED` allowlist → `UnsupportedError` ("not implemented yet"). Adding a
  construct to the dialect now requires adding its node type to `MODELED`,
  mirroring the emitter's exhaustiveness guard. Both error classes moved to a
  dependency-free `src/errors.ts` (so `validate` can throw `UnsupportedError`
  without a cycle); re-exported from `lower.ts`, public surface unchanged.
- **Control flow — complete** (`src/hir.ts`, `src/lower.ts`, `src/emitter.ts`):
  all five `02_control_flow` fixtures compile **and** behave (differential).
  `if`/`else if`/`else` and `while` are HIR `if`/`while` nodes with real block
  bodies (idiomatic `else if` chains); C-style `for` desugars to a
  scope-containing `block` + `while` (`lowerFor`); `for…of` →
  `for <pat> in <iterable>.iter()` (`lowerForOf`, by reference); `switch` → a
  guarded-wildcard `match` (`lowerSwitch`, sidestepping Rust's `f64`
  literal-pattern ban; cases must terminate, no fall-through); `break`/`continue`
  → Rust `break;`/`continue;`. An own `continue` inside a C-`for` is supported —
  `lowerFor` inlines the `update` before each own `continue` (`{ update; continue;
  }`), so the counter still advances (series 018; label-free — an unlabeled break
  through a labeled block is E0695). Numeric inference descends into every
  control-flow body. **Idiomatic integer forms** (series 019/020, post-lowering
  refinements in `numeric.ts`): an integer `switch` → literal-pattern `match`
  (`match x { 1 => …, _ => … }`, discriminant retyped `i64`); an index-driven
  `usize` counting `for` → a `for i in a..b` range (`..=` for `<=`). Both prefer
  the idiomatic form and fall back to the guarded `match` / `while` desugar when a
  construct isn't eligible (the accumulator loop, a `continue` loop, a
  non-integer/non-literal-caller `switch`). **Deferred refinements** (each its own
  future series): or-patterns (`1 | 2 =>`) and string/range literal patterns;
  native `continue`-in-range, downward/non-unit-step and bound-driven `i64` ranges;
  for…of element ergonomics (`&T` binding — fine for arithmetic, not by-value
  comparison; destructuring / owned / `&mut` elements); labeled and stacked jumps;
  general `i64` counters.
- **Data structures — records → `HashMap`** (`src/hir.ts`, `src/lower.ts`,
  `src/emitter.ts`): `04_data_structures/02_records` compiles **and** behaves.
  `Record<string, V>` → a `hashmap` `RustType` (`HashMap<String, V>`); a
  record-typed object literal → `HashMap::from([(k, v), …])` (empty → `::new()`),
  interpreted **contextually** from the binding's annotation (`lowerVarDecl` +
  `lowerHashMapLiteral`); a string-literal lookup `map["a"]` emits a bare `&str`
  index (not `.to_string()` — `HashMap: Index<&Q>`). A module using a map gets
  `use std::collections::HashMap;` prepended. A bare/struct-typed object literal
  is fail-loud (`UnsupportedError`). **Deferred** (each its own future series):
  non-`string` keys (`f64` is not `Hash`/`Eq`); variable/non-literal keys (need
  `&k` + numeric-seeding care); mutation / `.get` / `.has` / iteration / maps API;
  the `Map`/`Set` classes.
- **Data structures — `interface`/object → `struct` literals** (`src/hir.ts`,
  `src/lower.ts`, `src/emitter.ts`, `src/analysis.ts`): `05_interfaces/01_basic`
  compiles **and** behaves. An `interface` → a `HirStruct` **item**
  (`HirModule.items` is now a `HirFn | HirStruct` union); interface names are
  collected into `analysis.structs`, so `lowerType` resolves a `TSTypeReference`
  to a nominal `struct` `RustType` (an unknown type name stays fail-loud). An
  object literal in a struct-typed binding → a `structLit` (`Name { f: v, … }`),
  chosen contextually in `lowerVarDecl` (parallel to the record path); a field
  read reuses the existing `field` node. **Deferred** (each its own future
  series): `class` → `struct` + `impl` (methods/`new`/`this`); `interface extends`
  / inheritance; optional (`x?: T`) and readonly fields; nested/struct-typed
  fields and structs inside collections; struct mutation / field assignment;
  `#[derive(...)]` and whole-struct printing.
- **Data structures — `class` → `struct` + `impl`** (`src/hir.ts`, `src/lower.ts`,
  `src/emitter.ts`, `src/analysis.ts`): `06_classes/01_basic` compiles **and**
  behaves. A `class` → a `HirClass` item (`HirModule.items` is a
  `HirFn | HirStruct | HirClass` union) emitted as a `struct` + an `impl`. A
  field-init `constructor` → an associated `fn new(params) -> Name` returning a
  struct literal (fields must be exactly the declared set); methods → `fn`s with a
  `self` receiver (`HirFn.recv`), `&mut self` when the body assigns a
  `this.<field>` else `&self`. `this` → the `self` identifier (so `this.x` reuses
  the `field` node), `new C(args)` → `C::new(args)`. Calling a self-mutating
  method marks its receiver binding `mut` (`analysis.mutatingMethods`), so
  `const c = new C(); c.increment();` → `let mut c`. **Deferred** (each its own
  future series): inheritance (`extends`/`super`/`implements`); implicit or
  non-field-init constructors; static members, getters/setters, accessibility,
  generics, decorators; method-parameter borrow inference (params are moved in) and
  owned-`self` methods; the name-based receiver-mutability's cross-class
  same-name-method edge (a `unused_mut` warning at worst).
- **Errors — `throw` → `Result<T, String>` + `?`** (`src/analysis.ts`,
  `src/lower.ts`, `src/emitter.ts`, `src/hir.ts`): `08_errors/01_throw` compiles
  and a success-path differential behaves. A function is *fallible* iff it `throw`s
  or (transitively) calls a fallible function — a fixpoint over the top-level call
  graph (`analysis.fallible`, incl. the `SCRIPT_SCOPE` sentinel for `main`). A
  fallible function's return type wraps in a `result` `RustType` (`Result<T,
  String>`, `void`→`()`); `throw new Error(msg)` → a `throw` HIR stmt emitting
  `return Err(msg)`; `makeFallible` wraps every normal `return v` in `Ok` (a `ok`
  HirExpr; `null`→`Ok(())`) and appends a trailing `Ok(())` to a fall-through
  `void` body; a call to a fallible function wraps in a `try` HirExpr (`expr?`).
  When the script propagates a throwing call, `main` returns `Result` via
  `HirModule.mainRet`. `throw` also accepts the built-in Error subclasses
  (`TypeError`/`RangeError`/…) and bare string literals (both → `Err(String)`, the
  class erased — see the generalized-throw slice below), and a fallible `async` fn
  composes (see async×errors). **Deferred** (each its own future series):
  `try`/`catch`/`finally` (the recovery side); custom error *types* / an error enum
  / `Box<dyn Error>` (`E` is uniformly `String`); `throw` of a variable or
  non-string value (needs type tracking) and a `cause`/multi-arg throw; throwing /
  propagation inside a class method or constructor (rejected fail-loud);
  ignoring/storing a `Result` (every fallible call is `?`-propagated).
- **Errors — generalized `throw` values** (`src/lower.ts`): `lowerThrow` accepts
  the standard built-in Error constructors (`Error`, `TypeError`, `RangeError`,
  `SyntaxError`, `ReferenceError`, `EvalError`, `URIError`) via an `ERROR_CLASSES`
  set, and a bare string literal (`throw "boom"`) — each → `return Err(<String>);`
  (the class distinction erased; `E` stays uniformly `String`). Lowering-only, no
  new shape; a subclass+string differential behaves (`positive`). **Deferred:** a
  thrown variable/expression (needs type tracking to confirm `String`), a
  `cause`/multi-arg throw, and user/custom error classes (the error-enum series).
- **Async — `async`/`await` → `async fn` + `#[tokio::main]`** (`src/analysis.ts`,
  `src/lower.ts`, `src/emitter.ts`, `src/hir.ts`): `07_async/01_async_await`
  compiles and a top-level-await differential behaves (prints `row`). A free
  `async function` → an `async fn` (`HirFn.isAsync`, already emitted); its
  `Promise<T>` return annotation unwraps to `T` in `lowerType` (`Promise<void>` →
  `()`) — Rust wraps in `Future` implicitly. `await asyncFn(...)` → an `await`
  HirExpr (`<call>.await`); the awaited target must be a call to a known `async`
  function (`analysis.asyncFns`). A call to an `async` function is fail-loud unless
  directly awaited (an un-polled future never runs — a silent divergence from TS's
  eager promise). When the top-level script awaits, the generated entry becomes
  `#[tokio::main] async fn main()` via `HirModule.mainAsync` (composes with
  `mainRet`). A fallible `async` fn is now supported too (see the async×errors
  slice below). **Deferred** (each its own future series): un-awaited async calls
  and `await` of a non-async call (rejected); `async` methods (rejected fail-loud);
  `async` arrows (only the non-`async` arrow normalizes — see below); `Promise`
  combinators / concurrency (`Promise.all`, timers, spawning, `.then`) and real
  async I/O.
- **Async×errors — a fallible `async function` → `async fn … -> Result<T, String>`**
  (`src/lower.ts`): the intersection series 013/014 left fail-loud. Dropping the
  `func.async` guard in `lowerFunction` lets an async throwing fn lower like any
  fallible fn (`Result`-wrapped return, `Ok`/`Err` bodies) while keeping
  `isAsync`; `lowerAwait` wraps an awaited call to a fallible async fn in a `try`
  so it emits `<call>.await?` (the `?` outside the await, well-typed because the
  fixpoint already makes the enclosing fn — and `main` — `Result`). No HIR/emitter
  shape change; a success-path differential behaves (`5`). **Deferred:** catching
  an async error (`try`/`catch` — the recovery side), `async` methods, and a
  non-awaited fallible async call (still rejected — an un-polled future never runs).
- **Arrow functions — a top-level `const f = (…) => …` → a free `fn`**
  (`src/ast.ts`, `src/lower.ts`): `03_functions/02_arrow` compiles **and** a
  block+expression-body differential behaves (`7\n9`). A single-declarator,
  top-level, non-`async` `const` bound to an arrow normalizes to a synthetic
  `FunctionDeclaration` (`normalizeArrows`, run *before* `analyzeModule`) — `id` =
  the binding name, params/returnType/async carried over, body = the arrow's block
  verbatim or a `{ return <expr>; }` desugar for an expression body. The whole
  pipeline (ownership, fallibility, lowering, emitter) then treats it identically
  to a `function`; no HIR or emitter change. **Deferred** (each fail-loud, its own
  future series): `let`/`var`-bound arrows (a reassignable callable — a closure
  local); arrows in value position (argument/return/nested — local closures with
  capture and `Fn`/`FnMut` traits); `async` arrows; capturing top-level arrows (no
  capture analysis — caught by cargo); multiple declarators; destructuring/rest
  params.
- **Errors — `try`/`catch`/`finally`, the recovery side** (`src/ast.ts`,
  `src/hir.ts`, `src/lower.ts`, `src/emitter.ts`, `src/analysis.ts`):
  `08_errors/02_try_catch` compiles **and** behaves (`ran\ndone\ncaught\ndone`).
  A `try` block lowers to a `Result`-returning **IIFE closure** (`(|| ->
  Result<(), E> { … Ok(()) })()`) so its `?`/`throw`s short-circuit *to the
  closure*; `catch (e)` → `if let Err(e) = …` (`Err(_)` for a binding-less
  `catch`); `finally` → statements emitted after. The key analysis change is
  **fallibility shielding**: `analyzeFallible`'s walk skips a `try` block that has
  a handler, so the enclosing fn is *not* fallible (`fn attempt(n: f64)`, no
  `Result`) — the error is caught, not propagated. Statement-level recovery only.
  **Deferred** (each its own future series): `return`/`break`/`continue` inside
  `try`/`catch` (value-yielding `try`/`catch` — the closure would swallow the
  jump); `try`/`finally` with no handler; a re-`throw` in `catch` alongside a
  `finally`; typed/discriminated catch bindings.
- **Errors — custom error types → `Box<dyn Error>`** (`src/hir.ts`,
  `src/lower.ts`, `src/emitter.ts`, `src/analysis.ts`):
  `08_errors/03_custom_error` compiles **and** behaves (`6`). A `class X extends
  Error { constructor(message: string) { super(message); } }` (that exact shape)
  → a `struct X { message: String }` with an associated `new` and
  `Display`/`Debug`/`std::error::Error` impls (all fully-qualified, no `use`
  prelude). The **program error type** upgrades from `String` to `Box<dyn
  std::error::Error>` for *every* fallible fn iff any custom error class is
  declared (`programErrType`, uniform so `?` composes); otherwise `String` is
  unchanged (013/021 output preserved). `throw new X(msg)` → `Err(Box::new(X::new(
  msg)))`; a plain `throw new Error(msg)` / string under a boxed program converts
  with `.into()`. Custom error classes are tracked in `analysis.errorClasses`,
  **excluded** from `structs`. **Deferred** (each its own future series):
  `instanceof`-based catch discrimination (downcast); error classes with extra
  fields/methods; a synthesized error `enum`; deep hierarchies / `cause`.
- **Errors — `throw`/propagation in class methods & constructors** (`src/lower.ts`,
  `src/analysis.ts`): `08_errors/04_method_throw` compiles **and** behaves
  (`paid\n70`). `analyzeFallible` is generalised to a fixpoint over **all** scopes
  — free fns, script, each `Class.method`, each ctor — so a method/ctor that
  throws or transitively calls a fallible fn/method/`new` is fallible; a fallible
  method → `fn m(&self…) -> Result<T, E>`, a fallible ctor → `fn new(…) ->
  Result<Name, E>` (guards allowed before the field-inits; the struct return wraps
  in `Ok`). Fallible method/`new` **calls** propagate with `?` (`self.withdraw(
  amount)?`, `Account::new(100)?`), keyed name-based (`analysis.fallibleMethods` /
  `fallibleCtors`). `mutatingMethods` is now a **fixpoint** too, so a method that
  calls a self-mutating method (`pay` → `this.withdraw()`) is itself `&mut self`.
  The old throw-in-class rejection is removed. **Deferred**: cross-class same-name
  method resolution (name-based can over-`?`; cargo backstops); `try`/`catch`
  inside a method; fallible getters/setters/static/`async` methods.
- **Toolchain policy + bootstrap** (`src/toolchain.ts`, series 123): the MSRV is now
  explicit — `[workspace.package] rust-version = "1.85"`, inherited by every crate.
  Three roles carry distinct requirements (emitted = stable ≥ 1.85; harness = any
  stable, never nightly; facade = nightly rustdoc-json, opt-in). `ensureToolchain(
  role)` is the single fail-loud gate every cargo-spawning path routes through:
  detect → (interactive) consent-gated `rustup toolchain install` (or `rustup-init`
  when rustup is also absent) → else fail loud naming the exact command. Config comes
  from `ttr.toml` + `rust-toolchain.toml` + env + CLI (precedence CLI > env >
  `ttr.toml` > `rust-toolchain.toml` > default); a `no_std` key is rejected fail-loud
  (parked future target). `ttr facade`'s ad-hoc nightly check (FAC3) is generalized
  onto `ensureToolchain("facade")`, honoring `auto_install`/`--yes` and reusing a
  nightly `rust-toolchain.toml` without a `+nightly` shim. TTR can also **generate** a
  `rust-toolchain.toml` to pin a consumer's emitted crate (`generateRustToolchainToml`
  / `emittedPinChannel`, defaulting to the MSRV as a full version `1.85.0`), exposed
  on the `ttr` CLI as `--pin-toolchain [--toolchain <channel>]` for crate emits. Specs:
  TOOL1–TOOL15 (`tests/toolchain.test.ts`), hermetic over an injected spawn + prompt.

**Next** — the live backlog is **GitHub Issues** (`hoodiecollin/typescript-to-rust`)
and the [TTR Roadmap project](https://github.com/users/hoodiecollin/projects/4), **not**
this section (per [CLAUDE.md](../CLAUDE.md)). This document is a historical
status/architecture record. Its former inline "Next" list — the decisions from
2026-07-01 through the series-050 module system — has since shipped and been archived
under `docs/work/_archive/`; the roadmap now lives in the issue tracker.

The `tests/fixtures/**` tree enumerates these as `test.todo` targets; each flips
to a real compile/behave test as the feature lands.

## Development flow

Strict TDD, but against the **oracle**, not golden strings: add/enable a fixture
(or a differential program), watch it fail to compile/run (RED), implement the
emitter/analysis until `cargo` accepts it and output matches (GREEN). See
[../.agents/AGENTS.md](../.agents/AGENTS.md).
