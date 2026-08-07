# What `ttr` is — and what it isn't

An honest per-feature account. The README sells the project; this document is where the
limits are stated plainly. **Where the README over-promises, this document wins.**

**Verify every maturity claim below against the code.** Ground truth is
`packages/compiler/src/`, `packages/compiler/tests/`, and a `bun run test` run — not this
file and not an issue body. If a claim here disagrees
with the code, the code is right and this file should be corrected, not explained away.

Last reconciled against the tree: **2026-08-06**.

## The one-sentence version

`ttr` translates a **strict, explicitly-enforced subset of TypeScript** into idiomatic
Rust — real `T` / `&T` / `&mut T` ownership, not `Rc<RefCell>`-everything — and rejects
everything outside that subset loudly, at translation time.

## What it is not

- **It is not "compile any TypeScript."** TS's type system is unsound and its GC semantics
  (shared mutable aliasing, cycles, dynamic object shapes) have no total mapping onto
  Rust's affine ownership. Tractability comes from restricting the input, not from heroics
  in the backend.
- **It is not a Node or Bun runtime port.** There are no Node APIs. I/O exists only through
  the blessed `@ttr/std` shim, and only for the surface that shim covers.
- **It is not released.** No tags, no GitHub Releases, nothing published to npm, crates.io,
  or Homebrew. The README's channel table describes the *intent* of the release epic (#143),
  not something you can install. Running from source is the only supported path. See
  [`VERSION_ROADMAP.md`](VERSION_ROADMAP.md).
- **It is not a typechecker.** `tsc` is still your typechecker. `ttr` consumes annotations;
  it does not verify your program's types are internally consistent.
- **It is not silent about what it cannot do.** Every gap is a thrown error with a stable
  message, catalogued in [`DIALECT.md`](DIALECT.md). It never emits `Any`, never
  emits a commented-out stub, and never guesses.

## The claims that are load-bearing

These are the three things that would make the project pointless if they were false, so
they are the three to check hardest.

1. **The output is idiomatic Rust with real ownership.** Option A, decided and built: a
   read-only parameter borrows (`&T`), a mutated one is `&mut T`, an owned one moves; a
   read-only method is `&self` and a mutating one is `&mut self`, which forces the caller's
   binding to be `mut`. `Rc<RefCell<T>>` exists as a local fallback for the rare in-dialect
   shape that genuinely needs shared mutability — it is the exception, not the strategy.
2. **Correctness is judged by a real toolchain, not by string matching.** Tier 1 runs
   `cargo check` on the emitted Rust. Tier 2 runs the TypeScript under Bun *and* the Rust
   under `cargo run` and compares stdout. The old golden-`.rs` approach was retired
   precisely because it let invalid Rust (bare `let` at module scope) pass as green.
3. **Anything outside the dialect fails loud.** Two error classes, and the distinction is
   real: `DialectError` means *fix your input* (permanent — `any`, `unknown`, decorators,
   `declare`, Proxy/Reflect, an unrecognized `"use …"` directive, assignment to a `readonly`
   field). `UnsupportedError` means *in the dialect, not built yet*. As of the last census
   there are **7** permanent sites and **363** deferral sites.

## Per-feature state

"Shipped" below means: lowered, and pinned by a fixture or spec that compiles and — where
it is a complete program — behaves differentially.

| Area | State | The honest limit |
|---|---|---|
| Variables, primitives, operators | Shipped | `number` is `f64` by default; see the numeric divergence below. |
| Control flow | Shipped | `if`/`while`/C-`for`/`for…of`/`switch`, `break`/`continue`. An integer `switch` becomes a literal-pattern `match` and a counting `for` becomes a range — both *preferring*, falling back to the guarded desugar. Or-patterns, labeled jumps, and downward/non-unit-step ranges are not built. |
| Functions, arrows, closures | Shipped | Top-level `const f = () => …` normalizes to a free `fn`; closures and callbacks lower with capture analysis. |
| Classes | Shipped | Fields, constructors (including implicit and partial), methods with inferred receiver mutability, `extends` via composition + trait, generics via monomorphization with interface bounds. **`static` and computed-name fields and methods are not built** — both are fail-loud deferrals. Cross-class same-name method resolution is name-based and can over-`?`; `cargo` backstops it. |
| Interfaces | Shipped | Usage-directed dual lowering — a struct-shaped interface becomes a `struct`, a behavioral one becomes a trait. |
| Enums | Shipped | Including string enums. |
| Errors | Shipped | `throw` → `Result` with `?` propagation over a whole-program fixpoint; `try`/`catch`/`finally` via a `Result`-returning IIFE closure; custom error classes; the `AppError` enum with `instanceof` catch discrimination. `return`/`break`/`continue` *inside* a `try` is not built — the closure would swallow the jump. |
| `async` / `await` | Shipped, with two holes | `async fn` on tokio, `#[tokio::main]` when the script awaits, fallible async composing with `?`. Un-awaited async calls lower to `tokio::spawn`. Timers and `.then` are not built. Two known defects: a user-defined `async function main()` emits a bare `async fn main()` with no attribute (#163), and `Promise.all` emits a `join!` tuple bound to a `Vec` instead of rejecting (#161). |
| Generators | Shipped | Including bidirectional generators. `async function*` is a deferral, not a permanent rejection. |
| Nullability | Shipped | `null ≡ undefined` collapse to one `Option<T>`. Coercion is always explicit — no silent `None → T::default()`. **Only single-level optional chaining (`a?.b`) is built**; `a?.b?.c`, `a?.[i]`, `a?.()` are not. A `T \| null \| undefined` union compiles but warns, because its collapsed print and `===` may diverge from JS. |
| Arrays, strings, library methods | Mostly shipped, with known holes | Tracked by #157. A 2026-08-07 probe pass found five real gaps: array `includes`/`indexOf`/`lastIndexOf` have no lowering and miscompile (#158); an `Option<T>` — what `find` and `Map.get` return — cannot be printed or concatenated (#159); string `lastIndexOf(x, from)` is unrouted (#160); `Promise.all` emits a tuple bound to a `Vec` (#161); and unrouted *global* functions emit verbatim (#162). The rest of the row list is **unverified in both directions** — #138 is re-checking it. |
| Records / `Map` / `Set` | Shipped | `Record<string, V>` → `HashMap`. `f64` is not `Hash`/`Eq`, so numeric keys are out; struct keys are blocked on the same problem (#21). |
| Modules | Shipped | A multi-file program is one Rust crate, resolved transitively through `./`-relative imports with a cycle-terminating visited set. Bare and package imports are refused. `@ttr/std` is the only modeled non-relative import. |
| `@ttr/std` shim | Shipped | JSON (`parseJson<T>`, `stringifyJson`, and the opt-in `JsonValue` boundary), a seeded RNG, a seeded clock, and the I/O surface: fs, env, process, stdin, async fs, and text-only HTTP GET/POST. Expanding beyond text-only HTTP is #75; CLI argument-parsing ergonomics past raw `args(): string[]` is #76. |
| RegExp | Shipped | Series 101. |
| Date & time | Shipped | Series 102, via the seeded clock so the differential oracle is stable. |
| `ttr facade` | Shipped | Series 122. Generates a types-only `.d.ts` and a method table from a crate's rustdoc JSON. Requires **nightly** rustdoc-json — opt-in, gated by `ensureToolchain("facade")`. |
| Plugins | Partial | The plugin system and the macro archetype exist (`packages/plugin-leftpad`, `crates/ttr-plugin-leftpad`). The **mirror** archetype — a plugin whose truth lives on the Rust side — is designed but not built: it needs a Rust-authoritative oracle mode first (#127), which blocks the other five deltas and the first real client (#118). |
| Dynamic values | **Not built** | The recursive `JsonValue`-style model is #59, and its Gate 1 is not passed. Untyped `JSON.parse`, `flat(Infinity)`, jagged literals, and `flatMap` with a `U \| U[]` callback all depend on it and stay fail-loud. |
| Toolchain policy | Shipped | MSRV `1.85`, inherited workspace-wide. `ensureToolchain(role)` is the single fail-loud gate on every cargo-spawning path, with consent-gated `rustup` install and a `--pin-toolchain` emit option. |

## Deliberate divergences from TypeScript

These are **accepted** and translated — not rejected — and their runtime meaning
intentionally differs from JS. Each is pinned by a fixture so a refactor cannot silently
flip it. The full statement is in [`DIALECT.md`](DIALECT.md#semantic-divergences-from-typescript).

- **Object `===` is structural, not identity.** JS compares object identity; the dialect
  derives `PartialEq`, so equal fields mean equal. A moved, cloned, or literal-rebuilt
  struct has no stable identity to observe. Identity is restored only under `"use rc"` and
  `"use arena"`, where an instance has a stable heap home.
- **A provably-integer `number` may specialize to `i64`.** Within [−2⁵³, 2⁵³] this is
  bit-identical to `f64`, so ordinary code is unaffected. Beyond 2⁵³ the `i64` form stays
  exact where JS drifts, and beyond `i64::MAX` it wraps where JS goes to `Infinity`. The
  bar is *integrality*, not a range proof, and the pass is preferring — anything not
  provably integral stays `f64`. There are no runtime panics from this.
- **A source `null` prints as `undefined`**, because both collapse to one `Option::None`
  and `undefined` is the canonical print spelling.
- **`JsonValue` navigation:** an absent key or out-of-range index yields `Null` (so chains
  are safe), but a coercion mismatch or navigating into a non-container is **fail-loud**,
  where JS would quietly hand back `undefined`/`NaN`. Guard with `.isNumber()` / `.isArray()`.
- **`stringifyJson` `undefined`-omission** recovers provenance from the *declared* field
  type, since `T | null` and `T | undefined` collapse to one `Option`. A both-nullable
  field whose key is omitted from the literal serializes as `null` here and is absent in
  JS — "null wins" never silently drops data.

## Performance

Measured against a shared corpus, Node vs Bun vs `ttr` (`bun run bench`, corpus in
`benchmarks/corpus/`, report at `benchmarks/.build/report.md`).

- **Wins:** recursion, sort, sieve, `loopsum` (steady 1.5× / e2e 3.1× vs Bun), `arraypipe`
  (2.9× / 4.3×), `strbuild` (1.6× e2e), `splitscan` (1.7× / 1.6×).
- **Resident memory:** 1.4–14 MB vs 30–105 MB.
- **Startup:** 4.2 ms vs Bun 12.2 ms vs Node 97 ms.
- **The one loss:** `strsearch` is **slower than Bun** (e2e 0.6×, steady 0.3×) while still
  beating Node. JSC out-searches Rust's `str::find` on short needles with a common first
  byte. Tracked as #133; the candidate fix (`memchr::memmem`) adds a dependency to every
  emitted crate, so it is not obviously worth it.

One caveat on all of the above: these are microbenchmarks chosen partly *because* they were
losses. A corpus win is not a claim about your program.

## Known-bad output

Three reproducible codegen bugs are open and `plan-next`. They produce Rust that does not
compile — loud, not silent — but they are real:

- **#98** — a `switch` with a `return` in every case over an enum emits a non-exhaustive
  `match` whose tail type-errors (E0308).
- **#99** — `String(x)` over an enum or literal union emits invalid `String(x)` (E0423).
- **#100** — an adapter chain (`X.map(cb).reduce(…)`) fails when the adapter-result element
  type is unresolved, across the `Copy` / non-`Copy` split.

## Test and build state

Verified in a clean worktree on 2026-08-06:

| Gate | Result |
|---|---|
| `bun run typecheck` | **Passes** — `tsc --noEmit` clean over the compiler and the benchmarks. |
| `bun run lint` | **Passes** — biome, 286 files, no findings. |
| `bun run test` | **1513 pass, 4 todo, 1 fail** across 1518 tests in 160 spec files (345 s). The single failure is `01_variables/01_primitives` timing out at 5 s — the *first* fixture on a **cold cargo `target/`**, which pays for building the oracle's dependency graph. Re-running that file warm: **75 pass, 0 fail.** It is a cold-start artifact, not a regression. |

**On running the oracle suite locally.** Each fixture compiles and runs a real Rust crate,
so the suite is expensive and cold-start-sensitive. CI does not run it per PR for that
reason: `ci.yml` gates PRs with lint/typecheck/`cargo test`, and `oracle.yml` runs the
differential suite sharded 8 ways on a `v*` tag or manual dispatch. Warm the `target/`
before trusting a red local run.

## See also

- [`DIALECT.md`](DIALECT.md) — the accepted subset, rejection by rejection. Authoritative.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the compiler is built, and why.
- [`VERSION_ROADMAP.md`](VERSION_ROADMAP.md) — the state of the release effort.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how work is tracked and how a change ships.
- **GitHub Issues** — the backlog, and the only place a design or an implementation-plan lives.
