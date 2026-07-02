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
   with `update`. Block bodies thread the enclosing function's scope key —
   mutability is name-based and per-function, so a block-local binding still
   resolves there (no per-block scope yet). Numeric inference flattens
   control-flow and block bodies so index refinement reaches inside them.
   `for…of`, `switch`, and `break`/`continue` are not yet lowered (each its own
   series); the `for`-desugar is sound only without `continue` (which would skip
   the appended `update`).

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
- Control flow implements `if`/`else`/`while`/`for`; C-style `for` desugars to a
  `while` (general, not the idiomatic `for i in a..b` range — a deferred
  optimization — and unsound with `continue`). `for…of`, `switch → match`,
  `break`/`continue`, and negative literals (`-3`, a `UnaryExpression`) are
  unshipped and throw `UnsupportedError`.
- `string → String` for owned/mutated bindings; a read-only string **parameter**
  refines to `&str` (`strings.ts`). `&str` in return position and struct fields
  awaits a lifetime story, and the bare-literal call-site optimization
  (`greet("x")` still allocates via coercion) is a documented follow-up.
