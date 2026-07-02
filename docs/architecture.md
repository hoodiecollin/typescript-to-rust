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
│   ├── src/hir.ts                 # typed IR (Rust's shape) between AST and Rust
│   ├── src/lower.ts               # AST → HIR: the single dialect gate
│   ├── src/emitter/index.ts       # HIR → Rust module string (pure, total)
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

2. **Fail loudly, in one place.** Unsupported constructs throw `UnsupportedError`
   **during lowering** — never in the emitter, never as silent `Any` or
   commented-out stubs. The harness then reports the gap.

3. **Numeric literals.** `number → f64`, and integer literals get an explicit
   `.0` so the type is unambiguous (a literal *index* is emitted as bare `usize`).
   A future numeric-inference pass will pick `usize`/`i64` more broadly — `arr[i]`
   with `i: f64` does not compile, so today's `f64`-everywhere is a
   deliberately-scoped limitation, not a finished design. The HIR is where that
   pass will attach refined types.

## Known limitations (tracked, not hidden)

- Ownership inference is **intra-procedural and name-based** (no nested-scope
  shadowing, no inter-procedural moves through returns/stores). Documented and
  enforced by the dialect, not silently widened.
- Numeric types are `f64` everywhere except literal indices → variable array
  indexing and `for`-loop counters await the numeric-inference pass.
- `string → String` everywhere (owned); `&str` borrows await a read-only-string
  generalization of the ownership pass.
