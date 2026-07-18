# TypeScript → Rust Translator — Plan

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

**Next** (order reflects decisions made 2026-07-01)
- [ ] Two gaps surfaced by **series 030** (fixture-coverage expansion) remain
      open. The three *fail-loud holes* it surfaced — (A) integer-arg retyping
      across call boundaries, (C) Rust-keyword identifier hygiene, (E) HashMap
      index-assignment → `.insert` — are **closed in series 031**
      (docs/work/_archive/031-fail-loud-lowering-holes): each now compiles+behaves
      for the common case and fails loud (`UnsupportedError`) on the residual
      instead of emitting broken Rust. Still open:
      - **(B)** nested/inferred struct literals — **CLOSED in series 032**
        (docs/work/_archive/032-nested-struct-literals): `analysis.structFields`
        + a `lowerTyped(expr, ty)` pass recurse an object/array literal into a
        struct-typed field / `Vec` element by its declared type. Function-argument
        struct literals (no binding annotation) remain the residual.
      - **(D)** `ParenthesizedExpression` + precedence — **CLOSED (026 first
        slice)**: the validator now models `ParenthesizedExpression`, lowering
        unwraps it (grouping is structural), and the emitter parenthesizes a
        `binary` operand from a `BINARY_PREC` table (left-assoc: right same-prec
        operand wraps). The full rust-ast.ts/printer.ts rewrite stays deferred
        (026 doc trigger: 027 method-chain nesting). Specs in precedence.test.ts.
- [ ] Finish generalizing ownership (**GitHub epic #1** — the backlog now lives in
      issues, see CLAUDE.md). **CFG + liveness LANDED (series 037a):**
      `refineMoves` → `refineOwnership` (`ownership.ts`) now runs real **backward
      liveness over a control-flow graph** instead of the straight-line last-use
      heuristic — a `.clone()` is placed at a move site iff the moved binding is
      *live* after it, so **loop back-edges** (a move live across iterations) and
      **branch joins** (dead-after-a-mutually-exclusive-branch → no needless clone)
      are both correct. Still a *may*-analysis that only ever adds clones →
      fail-loud preserved (unprovable shapes stay bare → cargo-loud). Supersedes
      the 034 `refineMoves` heuristic; all 034 cases preserved
      (`tests/ownership-cfg.test.ts`). **Struct derives LANDED (series 037b):** a
      shared `structDeriveClause` (`src/derives.ts`) gives every interface/class
      struct `#[derive(Clone, Debug)]` on-demand (gated by field eligibility;
      `Clone` for the ownership pass, `Debug` for `console.log` per issue #22), and
      `refineOwnership` folds `struct` into the movable set via the same
      cloneability test — so struct moves clone in lockstep with the derive. The
      refine chain reorders so `refineOwnership` runs **last** (after
      `refineRc`/`refineArena`), letting the directives impose their ownership model
      first. Specs: `tests/struct-derives.test.ts`. **First increment was series
      034** (use-after-move → `.clone()`, straight-line; see
      docs/work/_archive/034-ownership-clone-moves). **Move coverage COMPLETE
      (series 038):** move-through-store (a name moved into a struct/array/hashmap
      literal, a by-value method arg, or an assignment value) and move-out-of-place
      (a non-Copy `field`/`index` projection read by value that moves out of an
      index, a borrowed param, or a reused owned base — partial moves +
      move-out-of-borrow, `E0382`/`E0507`), driven by a per-body type environment +
      `refParams`. So the epic-#1 sub-parts — conditional/loop/shadowed moves
      (037a), struct `Clone` (037b), and stores/projections (038) — are all done;
      the frontier that stays fail-loud is owned-`self` receiver moves and
      dynamic-shape moves (out of dialect). The `PartialEq`/`===` struct-equality
      decision is issue #28. Read-only-string `&str` params are done (`strings.ts`).
- [ ] Extend the dialect validator further (default-deny landed in series 024 —
      rejects `any`/`unknown`, `for await`, `await using`, decorators, `abstract`,
      `declare`, and any unmodeled node type; **sync finite-yield generators now
      supported** — series 035 — while async/method generators stay rejected):
      still open are missing-annotation enforcement (with the trivial-literal
      exception), class `extends` inheritance, dynamic object manipulation,
      escaping mutable aliasing.
- [x] Logical operators `&&`/`||` → Rust short-circuit ops (series 036); `??`
      stays fail-loud (needs `Option`). Rode the 026 `BINARY_PREC` table — no new
      HIR. See docs/work/_archive/036-logical-operators.
- [ ] Formal plans drafted (docs/work/025–029, design-only, spec-first when
      picked up). **Recommended sequence** (decided 2026-07-06):
      1. **025** esoteric *support* — **025a/b/c LANDED** (parameter properties →
         field+assign; `enum` → C-like Rust enum with `Copy`/`PartialEq` +
         `E.Variant`→`E::Variant` path + by-value enum params; `using` +
         `[Symbol.dispose]` → `impl Drop`, reverse-order RAII). **Sync
         generators→`impl Iterator` LANDED as series 035** — straight-line
         finite-yield `function*` → `fn -> impl Iterator` via `vec![…].into_iter()`
         (no state machine; `for-of` consumes it directly). Deferred: yield in a
         loop/branch (state machine / adapter chain), `yield*`, non-`for-of`
         consumption. Async-iteration and `await using` deferred; **decorators
         permanently rejected**. See docs/work/_archive/025-esoteric-feature-support
         and docs/work/_archive/035-sync-generators.
      2. **closures** — **FIRST SLICE LANDED** (series 033): a single-param arrow
         to `map`/`filter`/`forEach` over `Array<number>` → iterator chains
         (`iterMap`/`iterFilter` HIR exprs; `forEach`→`forIn`). Deferred:
         index/array params, non-Copy elements, `reduce`/`find`/…, closures in
         non-method value positions (`Fn`/`FnMut` + capture analysis). See
         docs/work/_archive/033-value-position-closures.
      3. **027 + 029** — **027 FIRST SLICE LANDED**: `crates/tslib` fidelity
         crate + hybrid routing (`Array.at` negative index, `String.padStart`/
         `padEnd` → `tslib`; user methods guarded by `analysis.methodNames`).
         Unary `-`/`!` added as the `at(-1)` prerequisite (also enables negative
         literals). 029 catalog folded in the `Tf`/`Tm` route column. Next slices:
         `reduce`/`find`/`sort`/`slice`, Object/JSON. See
         docs/work/027-tslib-runtime-crate.
      4. **`"use panic"`** (028a) — **LANDED**. A leading `"use panic"` directive
         makes a free fn / script infallible: `throw` → `panic!("{}", msg)`, the
         signature stays non-`Result`, callers don't `?`. `takeDirectives`
         validates directives (unknown `"use …"` → `DialectError`; `"use rc"`/
         `"use arena"` → `UnsupportedError` "not yet"). See
         docs/work/028-compiler-directives.
      5. **026** Rust-AST + pretty-printer — *downstream of 027* by dependency
         order (it cleans up 027's nested/chained output); build signal is an
         oracle-caught precedence defect on a fixture we write, not a schedule.
      6. **`"use rc"`** (028b) — **FIRST SLICE LANDED**. A `"use rc"` scope
         (free fn / script) wraps class-typed bindings in `Rc<RefCell<T>>`:
         construct → `Rc::new(RefCell::new(C::new(…)))`, alias `const b = a` →
         `Rc::clone(&a)`, read `a.f` → `a.borrow().f`, write → `a.borrow_mut().f`.
         A post-lowering `refineRc` pass (`src/rc.ts`), unblocked by the 034
         ownership increment. Deferred (cargo-loud): `rc` method calls, `rc`
         fields/params, cross-call `rc` values. See
         docs/work/028-compiler-directives + rc-directive.test.ts.
      7. **`"use arena"`** (028c) — **FIRST SLICE LANDED**. A `"use arena"` scope
         builds `Vec` literals from a bump arena: `let arena = bumpalo::Bump::new();`
         + `bumpalo::vec![in &arena; …]` (type annotation dropped → lifetime
         inferred, so no `'a` is written). A post-lowering `refineArena` pass
         (`src/arena.ts`); `bumpalo` pinned in `rust-oracle/Cargo.toml`. **Soundness
         by the oracle:** an escaping arena value is a cargo lifetime error —
         cargo *is* the escape analysis, no bespoke pass needed. Deferred: arena
         `String`/trees, arena values in signatures/fields, nested arenas. See
         docs/work/028-compiler-directives/arena-spike.md + arena-directive.test.ts.
- [ ] Control-flow refinements (deferred, revisit as needed): or-pattern
      (`1 | 2 =>`) and string/range literal `match` arms; native `continue`-in-range,
      downward/non-unit-step and bound-driven `i64` ranges; for…of element
      ergonomics (owned/`&mut`, destructuring); labeled/stacked jumps. All are
      optimizations or edge cases over today's correct lowerings — not blockers.
      (The C-`for` `continue` desugar shipped in series 018; integer literal-pattern
      `match` in series 019; index-driven `for i in a..b` ranges in series 020.)
- [ ] Value-yielding `try`/`catch` — a `try`/`catch` that computes a function's
      return value (the closure's `Ok` payload carries the returned value; both
      arms yield it), plus `try`/`finally` without a handler and `instanceof`-based
      catch discrimination (downcast). Series 021 shipped statement-level recovery.
- [ ] Finish all deferred work — sweep the fail-loud deferrals accumulated across
      the shipped slices (arrows: `let`/value-position/`async`/capturing arrows;
      async: un-awaited calls, `await` of a sync call, `async` methods, `Promise`
      combinators; errors: value-yielding `try`/`catch`, catch discrimination,
      error enums; classes/interfaces/records/control-flow deferrals) rather
      than starting new fixture areas. The error trio landed 2026-07-06 —
      `try`/`catch`/`finally` (021), custom error types → `Box<dyn Error>` (022),
      throw-in-method/ctor (023). `09_modules` (`import`/`export`) **shipped
      2026-07-17** as series 050 (a–d): multi-file crate emission, `pub(crate)`
      visibility inference, pure-barrel `pub use` facades, default import/export
      via `__default_export`, namespace imports (module alias), `namespace`→inline
      `mod`, and prelude generation. See `docs/work/_archive/050-module-system/`.

The `tests/fixtures/**` tree enumerates these as `test.todo` targets; each flips
to a real compile/behave test as the feature lands.

## Development flow

Strict TDD, but against the **oracle**, not golden strings: add/enable a fixture
(or a differential program), watch it fail to compile/run (RED), implement the
emitter/analysis until `cargo` accepts it and output matches (GREEN). See
[../.agents/AGENTS.md](../.agents/AGENTS.md).
