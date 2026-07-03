# Architecture Notes

Implementation details and decisions that aren't obvious from the code.

## Repo layout

```
.
├── Cargo.toml                     # Rust workspace (members = crates/*)
├── crates/ts-primitives/          # runtime crate: TsAny + Option-A helpers
├── packages/compiler/
│   ├── index.ts                   # CLI: parse → lower → emit → rustfmt → check/run
│   ├── src/ast.ts                 # typed ESTree subset (the real runtime shape)
│   ├── src/analysis.ts            # ownership/mutability inference (side tables)
│   ├── src/validate.ts            # dialect validation (step 2): forbidden input
│   ├── src/hir.ts                 # typed IR (Rust's shape) between AST and Rust
│   ├── src/lower.ts               # AST → HIR: the single dialect gate
│   ├── src/numeric.ts             # HIR → HIR: refine number → usize for indices
│   ├── src/strings.ts             # HIR → HIR: refine read-only &String → &str
│   ├── src/emitter.ts             # HIR → Rust module string (pure, total)
│   ├── src/harness/               # the verification oracle (cargo + rustfmt)
│   ├── .scratch/                  # persistent crate the harness compiles into
│   └── tests/
│       ├── harness.test.ts        # proves the oracle is sound
│       ├── compiler.test.ts       # fixture COMPILES + differential BEHAVES
│       └── fixtures/**            # dialect targets (.ts inputs only)
└── docs/                          # plan.md, dialect.md, architecture.md
```

## The oxc ESTree-vs-types gotcha (important)

`oxc-parser`'s `parseSync` JS API returns an **ESTree** AST at runtime:
`Literal` (with `value`/`raw`), ESTree `MemberExpression`, `CallExpression.arguments`,
etc. But the bundled `@oxc-project/types` describes the **Rust-native** oxc AST
(`NumericLiteral`, `StringLiteral`, …). The two do not match for literals and
member access. Typing the emitter against `@oxc-project/types` would lie about
the runtime shape, so `src/ast.ts` declares the subset we consume, verified
against real parser output. Extend `ast.ts` (not the bundled types) as the
dialect grows.

## The verification harness (`src/harness`)

The oracle is a real Rust toolchain, driven from TypeScript so we get structured,
programmable results instead of opaque pass/fail.

- **`cargo.ts`** — spawns `cargo`/`rustfmt`, parses `--message-format=json` into
  typed `RustDiagnostic`s (level, error code, source spans, rendered text). This
  is the leverage: failures are explainable and can be mapped back to TS spans.
- **`index.ts`** — `RustProject` owns the persistent `.scratch` crate. Access is
  serialized through a promise queue (one source file, one writer at a time).
  - `check(src)` writes `src/lib.rs` and runs `cargo check --lib` — **library**
    target, so a bare-function snippet with no `main` still verifies.
  - `run(src)` writes `src/main.rs` (and resets `lib.rs`, because a binary
    implicitly links the package lib) and runs `cargo run` for stdout.

### Why a persistent scratch crate

Reusing one crate keeps the incremental-compile cache warm, so repeated checks
stay fast. It declares an empty `[workspace]` to isolate itself from the repo's
root Cargo workspace, and depends on `ts-primitives` by path. Build artifacts and
the harness-managed source files are gitignored.

### Offline-first, online fallback (and tokio)

The scratch crate also depends on **tokio** (pinned) because async lowering
targets it (`async fn` + `#[tokio::main]`). tokio is a crates.io dependency, so
the harness can't be purely offline. `runCargo` in `cargo.ts` runs `--offline`
first (fast when the cache is warm) and retries **online only when cargo fails
before producing any diagnostic** — the signature of a cold-cache dependency
fetch. A genuine compile error always comes back with diagnostics and never
triggers a wasted online retry. After a successful check (which fetches/builds
deps), the `cargo run` step stays offline.

## The HIR and lowering (`src/hir.ts`, `src/lower.ts`)

The pipeline is **AST → HIR → Rust**, not AST → Rust. The HIR (`hir.ts`) is a
typed IR shaped like *Rust*, not TypeScript: types are resolved to `RustType`,
parameter borrow forms (`&T` / `&mut T`) are folded into the type, `let` bindings
carry `mut`-ness, and call arguments carry the borrow to apply. Lowering
(`lower.ts`) is the one place that consumes the ownership analysis (`analysis.ts`)
and bakes all of that in; side tables never leave lowering. This split makes the
emitter a **pure, total** `HIR → string` function — it analyzes nothing and
rejects nothing, so every dialect decision has exactly one home.

## Lowering / emitter invariants

1. **Output is always a complete, compilable module.** TS top-level code is
   imperative; Rust module scope holds only *items*. Lowering partitions
   top-level statements: declarations (`function`, later `class`/`interface`)
   become items; everything else becomes the body of a generated `fn main()`.
   (Mixing top-level statements with a user-defined `main` has no sound single
   lowering and is rejected.) This is the fix for the original fixtures that
   emitted bare `let a: f64 = 42.0;` at module scope — which is not valid Rust.

2. **Fail loudly, in one place — with two meanings.** Failures surface as one of
   two errors, never as silent `Any` or commented-out stubs:
   - `DialectError` (`validate.ts`, run first in `lower()` — pipeline step 2):
     input **forbidden** by the dialect and always will be (`any`/`unknown` today;
     more categories pending). The fix is the user's.
   - `UnsupportedError` (lowering): a construct **in** the dialect but not yet
     implemented (control flow, classes, …). The fix is ours.
   Both throw during the lower step, never in the emitter; the harness reports the
   gap. The distinction tells the user whether to change their code or wait.

3. **Numeric inference.** `number → f64` by default (integer literals get an
   explicit `.0` so the type is unambiguous). A post-lowering HIR→HIR pass
   (`numeric.ts`) then refines values that reach an array-index position to
   `usize` — `arr[i]` with `i: f64` does not compile — propagating usize-ness
   through initializers and integer arithmetic, and throwing `UnsupportedError`
   when a value is forced to be both `usize` and float. `i64` for integer-only
   counters is a documented future addition to the same pass.

4. **String-borrow refinement.** A second post-lowering HIR→HIR pass
   (`strings.ts`) refines a read-only string parameter's `&String` into the
   idiomatic `&str` (a new `RustType` `{ kind: "str" }`, only ever behind a
   `ref`). Mutable `&mut String` and owned `String` params are left alone. Call
   sites are unchanged — `&String` coerces to `&str` — so only signatures move.

5. **Control flow lowers to block-bodied HIR statements.** `if`/`else if`/`else`
   and `while` are HIR `if`/`while` nodes carrying nested `HirStmt[]` bodies. A
   single `block()` emitter helper renders those bodies (shared with function
   bodies); an `if` alternate that is a lone `if` prints as `else if …`, never
   `else { if … }`. C-style `for` has no Rust equivalent, so `lowerFor` desugars
   `for (init; test; update) body` into a scope-containing `block` (a bare
   `{ … }` HIR statement) wrapping `init` and a `while (test)` whose body ends
   with `update`. `for…of` lowers to `for <pat> in <iterable>.iter() { … }`
   (`lowerForOf`) — iterating by reference, which is sound whether the iterable is
   owned or borrowed and never consumes it, so the element binding is `&T`
   (`total + val`, `f64 + &f64`, compiles via std ref-arithmetic). Block bodies
   thread the enclosing function's scope key — mutability is name-based and
   per-function, so a block-local binding still resolves there (no per-block scope
   yet). `switch` lowers to a `match` with **guarded wildcard** arms
   (`_ if disc == case => …`, `default` → `_ =>`, `lowerSwitch`) — Rust forbids
   `f64` literal patterns, so the discriminant is compared in a guard; cases must
   terminate (a trailing `break` is the case terminator and is stripped, no
   fall-through), and a synthetic `_ => {}` is appended when there is no
   `default`. `break`/`continue` lower to Rust `break;`/`continue;`. Numeric
   inference flattens control-flow, block, `forIn`, and `match` bodies so index
   refinement reaches inside them.

   The `for`-desugar is sound with `break` (it exits the `while`, as the `for`
   would) but **not** with `continue` (which would skip the appended `update`);
   `lowerFor` therefore rejects an *own* `continue` (`hasOwnContinue`, stopping at
   nested loops). Control flow is otherwise complete — all five `02_control_flow`
   fixtures compile and behave.

6. **Object literals lower contextually, from the binding type.** A `{ … }`
   literal is ambiguous in isolation — a `Record` map vs an `interface` struct — so
   it is never lowered by `lowerExpr` (which throws `UnsupportedError`); instead
   `lowerVarDecl` reads the binding's resolved `RustType` and dispatches:
   - a `hashmap` type (`Record<string, V>` → `{ kind: "hashmap"; key; value }`) →
     a `hashmap` HirExpr (`lowerHashMapLiteral`) → `HashMap::from([(k, v), …])`
     (empty → `HashMap::new()`, which needs the annotation to infer `K,V`). A keyed
     lookup `map["a"]` reuses the `index` HIR node; `emitIndex` renders a **string**
     index as a bare `&str` (`map["a"]`) — `HashMap: Index<&Q> where K: Borrow<Q>`
     wants `&str`, and a `Copy` value copies out of the returned place — mirroring
     the bare-integer case for `usize` `Vec` indices. `emitModule` prepends
     `use std::collections::HashMap;` when a generic deep-scan finds any
     `kind: "hashmap"` node (the emitter is the sole producer, so this is exact).
     Only `string` keys map soundly (`f64` is neither `Hash` nor `Eq`), so a
     non-`string` `Record` key is rejected in lowering.
   - a `struct` type (a declared `interface`) → a `structLit` HirExpr
     (`lowerStructLiteral`) → `Name { field: value, … }`. An `interface` lowers to
     a `HirStruct` **item**, so `HirModule.items` is a `HirFn | HirStruct` union
     (`HirItem`); the emitter dispatches items through `emitItem`, and the numeric
     and string passes skip non-`fn` items. Interface names are collected in
     `analyzeModule` (`analysis.structs`), threaded into `lowerType`, which resolves
     a `TSTypeReference` to `{ kind: "struct"; name }` **only** for a declared name —
     an unknown type name (`Promise`, `Map`, …) stays fail-loud. Nominal, not
     structural: a literal must resolve to a named struct (or a record). Field reads
     (`p.x`) reuse the existing `field` node. `extends`/optional/readonly fields are
     rejected; classes (methods/`new`/`this`) are handled by invariant 7.

7. **Classes split into a `struct` + `impl`.** A `class` lowers to a `HirClass`
   item (`HirModule.items` is a `HirFn | HirStruct | HirClass` union) that the
   emitter renders as a `struct` (its fields) followed by an `impl` block holding
   an associated constructor and the methods. The field-init `constructor` becomes
   `fn new(params) -> Name` returning a struct literal — its body must be exactly
   `this.<field> = <expr>;` assignments covering every declared field (a Rust
   struct literal is total), else `UnsupportedError`; constructor params are moved
   into the fields. Each method becomes an `fn` with a `self` receiver
   (`HirFn.recv`): `&mut self` when the AST body assigns a `this.<field>`, else
   `&self` (`astAssignsThis`). `ThisExpression` lowers to the `self` identifier —
   so `this.count` reuses the existing `field` node (`self.count`) and
   `this.count = …` the `assign` node — and `new C(args)` to a `call` with callee
   `C::new`. Because Rust needs a binding to be `mut` before a `&mut self` method
   can be called on it, the ownership analysis collects the module's self-mutating
   method names (`analysis.mutatingMethods`) and `mutableBindings` marks a receiver
   `mut` when it calls one (`const c = new C(); c.increment();` → `let mut c`);
   this is name-based (not binding-type-aware), so a cross-class same-named method
   is a documented `unused_mut`-at-worst edge. Inheritance, statics, accessors,
   generics, implicit constructors, and method-param borrows are rejected/deferred.
   The numeric and string passes descend into a class's `ctor` and `methods`.

8. **`throw` lowers to `Result<T, String>` + `?`, driven by a fallibility
   fixpoint.** TS exceptions have no Rust equivalent; a `throw`ing function
   instead *returns* `Result`, and callers propagate with `?` (deliberately not
   `panic!`, which would change catch semantics). A function is **fallible** iff
   it `throw`s or (transitively) calls a fallible function — a fixpoint over the
   top-level call graph computed in `analyzeModule` (`analysis.fallible`, including
   the `SCRIPT_SCOPE` sentinel for the generated `main`). Everything reads that set:
   - **Return type.** A fallible function's `ret` wraps in a new `RustType`
     `{ kind: "result"; ok; err }` — `Result<T, String>` (`void` → `Result<(),
     String>`). `E` is uniformly `String` (the `Error` message) this slice.
   - **`throw`.** `throw new Error(<msg>)` → a `throw` HIR statement
     (`lowerThrow`, accepting only that exact shape) that the emitter renders as
     `return Err(<msg>);`; the message lowers as an expression, so a string
     literal becomes a `String`.
   - **Returns.** `makeFallible` rewrites every `return v` → `return Ok(v)` (a new
     `ok` HirExpr, `null` value ⇒ `Ok(())`), recursing through control-flow bodies,
     and appends a trailing `return Ok(());` to a `void` body that can fall through
     the end (`diverges` checks the last statement).
   - **`?` propagation.** A `call` to a fallible function wraps in a `try` HirExpr
     (`<expr>?`); the fixpoint guarantees the enclosing function is itself fallible,
     so its return type is already `Result` and `?` is well-typed. When the script
     propagates a throwing call, `main` becomes `fn main() -> Result<(), String>`
     via an optional `HirModule.mainRet` (absent ⇒ `()`).
   `throw`/propagation inside a class method/constructor, and `async` fallible
   functions, are rejected fail-loud (`hirHasThrowOrTry` guards the class; each is
   a later series). `try`/`catch` (the recovery side), custom error types, and
   non-`new Error(...)` throws are deferred. The numeric pass descends into the new
   `throw`/`ok`/`try` nodes.

9. **`async`/`await` lowers to `async fn` + `.await`, with a `#[tokio::main]`
   runtime entry.** TS promises are eager and driven by an ambient event loop;
   Rust futures are lazy and need a runtime to poll them. A free `async function`
   → an `async fn` (`HirFn.isAsync`), and its `Promise<T>` return annotation
   unwraps to `T` in `lowerType` (`Promise<void>` → `()`) — Rust wraps the result
   in `Future` implicitly, so the wrapper is not written. `await asyncFn(...)` → an
   `await` HirExpr rendered `<call>.await`; `lowerAwait` accepts only a call to a
   known `async` function (`analysis.asyncFns`). Because a bare (un-awaited) async
   call is an un-polled future that never runs — a `must_use` **warning**, not an
   error, so it would silently diverge from TS — `lowerCall` is fail-loud on any
   async call that is not directly awaited (`awaited` flag). When the top-level
   script `await`s, the generated entry becomes `#[tokio::main] async fn main()`
   via `HirModule.mainAsync` (detected by `hirHasAwait` over `main`; composes with
   `mainRet`). `async` + `throw` (a fallible async fn) and `async` methods are
   rejected fail-loud; the numeric pass descends into the new `await` node. The
   scratch crate pins `tokio`, so the runtime is present without extra plumbing.

10. **A top-level `const f = (…) => …` arrow normalizes to a free `fn` before
    analysis.** A module-scope `const` bound to a non-`async` arrow is semantically
    a plain named function, and Rust's idiomatic form is a free `fn` (not a closure
    `let f = |…|`), which participates in ownership/borrow/fallibility inference for
    free. `normalizeArrows` (run in `lower()` *before* `analyzeModule`) rewrites
    each qualifying statement into a synthetic `FunctionDeclaration` — `id` = the
    binding name, `params`/`returnType`/`async` carried over, body = the arrow's
    block verbatim or a `{ return <expr>; }` desugar for an expression body — so
    the whole pipeline treats it identically to a `function` (no HIR, emitter, or
    analysis-shape change). Only a single-declarator, top-level, non-`async` `const`
    arrow normalizes; a `let`/`var`-bound, value-position, nested, or `async` arrow
    stays an `ArrowFunctionExpression` and is rejected by `lowerExpr`'s `default`
    (the documented deferral boundary). A capturing top-level arrow (referencing a
    `main`-local binding) is caught by the cargo oracle, not the gate — a capture
    check belongs with the closure series.

## Known limitations (tracked, not hidden)

- Ownership inference is **intra-procedural and name-based** (no nested-scope
  shadowing, no inter-procedural moves through returns/stores). A use-after-move
  falls to the cargo oracle. Documented and enforced by the dialect, not silently
  widened. (Block bodies now exist for `if`/`while`, but they are **not** separate
  scopes — mutability/ownership stay name-based per function, so nested-scope
  *shadowing* is still unhandled and gets its own series.)
- Numeric inference refines `number → usize` for array indices (variable indexing
  compiles), and now descends into `if`/`while`/`block` bodies. `i64` counters are
  not yet done — `while`/`for` counters stay `f64` (they compile and print
  identically to JS).
- Control flow is complete (`if`/`else`/`while`/`for`/`for…of`/`switch`/`break`/
  `continue`), with these documented refinements deferred: C-style `for` desugars
  to a `while` (not the idiomatic `for i in a..b` range) and rejects an own
  `continue` (needs a labeled-block desugar); `switch` emits guarded-wildcard
  `match` arms (not literal/or-patterns), rejects fall-through and empty/stacked
  cases; `for…of` iterates arrays by reference (element `&T` — fine for
  arithmetic, but `&f64 == f64` has no impl, so by-value comparison, destructuring,
  non-array iterables, and owned/`&mut` elements are deferred); labeled
  `break`/`continue` and negative literals (`-3`, a `UnaryExpression`) are
  unshipped. Deferred and rejected constructs throw `UnsupportedError` (fail-loud),
  or fail the cargo oracle where a `&T` element reaches an unsupported use.
- Records lower to `HashMap<String, V>` for the **construct-and-look-up** shape
  (type, object-literal `HashMap::from`, string-literal keyed read). Deferred:
  `interface`/object → `struct` literals (the next data-structure series — an
  object literal only lowers in a record context today); non-`string` keys
  (`f64` isn't `Hash`/`Eq`); variable/non-literal keys (need `map[&k]` and care
  with the numeric pass, which seeds every index position as `usize`); map
  mutation, `.get`/`.has`/`.delete`, and iteration; the `Map`/`Set` classes.
- Interfaces lower to a `struct` for the **construct-and-read** shape (definition,
  named struct literal, field read). Deferred: `class` → `struct` + `impl`
  (methods, constructor, `this`, `new`); `interface extends` / inheritance;
  optional (`x?: T`) and readonly fields; nested / struct-typed fields and structs
  inside collections; struct-field mutation / assignment; `#[derive(...)]` and
  whole-struct printing. An object literal only lowers in a record- or
  struct-typed binding (nominal); a bare/unknown-typed literal is fail-loud.
- Classes lower to a `struct` + `impl` for the **field-init-constructor + methods**
  shape (construct, mutate/read through a binding). Deferred: inheritance
  (`extends`/`super`/`implements`); implicit / non-field-init constructors; static
  members, getters/setters, accessibility, generics, decorators; method-parameter
  borrow inference (params are moved in) and owned-`self` methods; binding-type-
  aware receiver mutability (today's is name-based across the module).
- Errors lower to `Result<T, String>` + `?` for the **propagation** shape: a
  function that `throw`s or calls a thrower returns `Result`, `throw new
  Error(msg)` → `return Err(msg)`, normal returns wrap in `Ok`, and fallible calls
  `?`-propagate (the generated `main` returns `Result` too). Deferred: `try`/
  `catch`/`finally` (the recovery side — this slice only propagates); custom error
  types / `Error` subclasses / an error enum / `Box<dyn Error>` (`E` is uniformly
  `String`); `throw` of a non-`new Error(...)` value; throwing / propagation inside
  a class method, constructor, or `async` function (rejected fail-loud); and
  ignoring/storing a `Result` (every fallible call is `?`-propagated).
- Async lowers to `async fn` + `.await` for the **sequential await** shape: a free
  `async function`, `await asyncFn(...)`, and a `#[tokio::main] async fn main()`
  when the script awaits. `Promise<T>` unwraps to `T` in any type-annotation
  position (in-dialect `Promise` only ever annotates an `async` return; a
  `Promise`-typed param/variable is out-of-dialect and its unwrap unspecified).
  Deferred (each fail-loud or its own series): a call to an `async` function that
  is not directly awaited, and `await` of a non-call or a sync call; `async` +
  `throw` (a fallible async fn) and `async` methods; `async` arrow functions
  (a top-level `const` arrow now normalizes to a free `fn`, but only the
  non-`async` form — see below); `Promise` combinators / concurrency
  (`Promise.all`/`race`, timers, spawning, `.then` chains, cancellation) and real
  async I/O. Async functions here are ordinary computations marked `async`.
- Arrow functions lower for the **top-level `const f = (…) => …`** shape only: a
  single-declarator, non-`async` `const` arrow normalizes to a free `fn` (block or
  expression body). Deferred (fail-loud, each a later series): `let`/`var`-bound
  arrows (a reassignable callable — needs a closure local); arrows in value
  position (argument, return, nested) — local closures with capture and `Fn`/`FnMut`
  traits; `async` arrows; capturing top-level arrows (no capture analysis — caught
  by cargo); multiple declarators; destructuring/rest params (the same gap as
  `function` declarations).
- `string → String` for owned/mutated bindings; a read-only string **parameter**
  refines to `&str` (`strings.ts`). `&str` in return position and struct fields
  awaits a lifetime story, and the bare-literal call-site optimization
  (`greet("x")` still allocates via coercion) is a documented follow-up.
