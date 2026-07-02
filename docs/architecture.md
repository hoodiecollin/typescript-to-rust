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

6. **Records lower to `HashMap`, interpreted from the binding type.** An object
   literal is ambiguous in isolation (a `Record` map vs an `interface` struct), so
   it is lowered **contextually**: `lowerVarDecl` reads the binding's resolved
   `RustType`, and only when it is a `hashmap` (`Record<string, V>` →
   `{ kind: "hashmap"; key; value }`) does the literal become a `hashmap` HirExpr
   (`lowerHashMapLiteral`) → `HashMap::from([(k, v), …])` (empty → `HashMap::new()`,
   which needs the binding's annotation to infer `K,V`). A bare object literal
   reaching `lowerExpr` throws `UnsupportedError` (struct literals are a later
   series). A keyed lookup `map["a"]` reuses the `index` HIR node; the emitter's
   `emitIndex` renders a **string** index as a bare `&str` (`map["a"]`) — Rust's
   `HashMap: Index<&Q> where K: Borrow<Q>` wants `&str`, and a `Copy` value copies
   out of the returned place — mirroring the bare-integer case for `usize` `Vec`
   indices. `emitModule` prepends `use std::collections::HashMap;` when a generic
   deep-scan finds any `kind: "hashmap"` node (the emitter is the sole producer, so
   this is exact). Only `string` keys map soundly — `f64` (a `number` key) is
   neither `Hash` nor `Eq` — so a non-`string` `Record` key is rejected in lowering.

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
- `string → String` for owned/mutated bindings; a read-only string **parameter**
  refines to `&str` (`strings.ts`). `&str` in return position and struct fields
  awaits a lifetime story, and the bare-literal call-site optimization
  (`greet("x")` still allocates via coercion) is a documented follow-up.
