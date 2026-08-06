# TTR Architecture

**Audience:** contributors and anyone reasoning about how `ttr` is put together.

This is the system narrative — how the compiler is built and why it is built that way.
The authoritative statement of *what input it accepts* is [DIALECT.md](./DIALECT.md);
the honest account of *what works and where it stops* is [WHAT_IT_IS.md](./WHAT_IT_IS.md);
`packages/compiler/src/` is ground truth for the pass set.

This document was distilled from the 118 archived design series that produced the
compiler. Those folders are gone — git history holds them, and the decisions worth
keeping are restated here rather than left in 26,000 lines nobody re-reads.

---

## What `ttr` is

`ttr` is a **language-level translator**: it reads a strict, explicitly-enforced subset
of TypeScript and emits idiomatic Rust. It is not a typechecker (`tsc` still is), not a
Node or Bun runtime port, and emphatically not "compile any TypeScript."

**The invariant.** TypeScript's type system is unsound and its GC semantics — shared
mutable aliasing, cycles, dynamic object shapes — have no total mapping onto Rust's
affine ownership. Tractability therefore comes from **restricting the input**, never
from heroics in the backend. Everything outside the accepted dialect is **rejected at
translation time**, loudly, with a stable error message. The compiler never emits `Any`,
never emits a commented-out stub, and never guesses.

That invariant has a specific operational meaning, and it is the property every design
decision below is measured against: **a bug in this compiler should be a refusal or a
`cargo` error, never a wrong value.** Passes are allowed to be imprecise as long as
their imprecision falls on the safe side — the ownership pass may insert a clone that
was not needed, the auto-`Rc` pass may wrap a binding that did not need wrapping. What
no pass may do is produce Rust that compiles and behaves differently from the
TypeScript.

Two error classes carry the refusal, and the distinction is load-bearing because it
tells a user whose problem it is:

- **`DialectError`** — *forbidden.* The construct is outside the dialect and always will
  be: `any`, `unknown`, decorators, `declare`, Proxy/Reflect, an unrecognized `"use …"`
  directive, assignment to a `readonly` field. **Fix your input.** 7 sites.
- **`UnsupportedError`** — *not yet.* In the dialect, not built. **Ours to fix.** 363 sites.

Both live in `src/errors.ts`, dependency-free so any pass can throw either without an
import cycle. The **error message string is the stable anchor** that DIALECT.md quotes;
line numbers drift, messages do not.

---

## Compilation pipeline

```
.ts source
   │
   ▼
oxc-parser (parseSync)      ESTree AST — see "the oxc gotcha" below
   │
   ▼
normalizeArrows             AST → AST: a top-level `const f = () => …`
   │                        becomes a synthetic FunctionDeclaration, so the
   │                        whole pipeline treats it as a plain `fn`
   ▼
validate.ts                 the DEFAULT-DENY gate: any AST node type not in
   │                        MODELED is refused; forbidden types and flags too
   ▼
analyzeModule               builds ModuleAnalysis — the ~73-field shared
   │                        context: symbol/binding types, the fallibility
   │                        fixpoint, mutating methods, async fns, generators,
   │                        struct/class/enum tables, directive scopes
   ▼
lower/ (19 modules)         AST → HIR. The single dialect gate: it consumes
   │                        the analysis once and bakes resolved RustTypes,
   │                        borrow forms, mut-ness and call-site borrows in
   ▼
the refine chain            15 HIR → HIR passes, in a fixed order (below)
   │
   ▼
emitter.ts                  HIR → Rust. Pure and total — no analysis, no
   │                        rejection, zero `default:` cases
   ▼
rustfmt
   │
   ▼
.rs output  ──►  the oracle: cargo check + cargo run
```

There is **one IR**. Early drafts spoke of both an HIR and an MIR; the pipeline lowers
TS-AST → HIR → Rust and maintains no separate MIR.

### The oxc ESTree-vs-types gotcha

`oxc-parser`'s `parseSync` returns an **ESTree** AST at runtime (`Literal` with
`value`/`raw`, ESTree `MemberExpression`, `CallExpression.arguments`), but the bundled
`@oxc-project/types` describes the **Rust-native** oxc AST (`NumericLiteral`,
`StringLiteral`, …). The two disagree for literals and member access. Typing against the
bundled types would lie about the runtime shape, so `src/ast.ts` declares the subset we
actually consume, verified against real parser output. **Extend `ast.ts`, not the
bundled types**, as the dialect grows.

### The lockstep triad

Three accept-sets must move together, and the compiler is structured so that they cannot
silently drift apart:

| Stage | Accept-set | Enforcement |
|---|---|---|
| validate | the `MODELED` node-type set | anything absent → `UnsupportedError` |
| lower | AST `.type` switch hubs | a missing arm falls to a fail-loud default |
| emit | HIR `.kind` switches | **exhaustive, zero `default:` cases** — a missing arm is a *type error* |

Adding a construct to the dialect therefore requires touching all three deliberately.
Emitter totality is what makes the last row a compile-time guarantee rather than a
runtime surprise, and it is the reason the plugin system (below) was designed the way it
was.

---

## The refine chain

Lowering produces a correct-but-unrefined HIR. Fifteen `HirModule → HirModule` passes
then run in a **fixed order**, composed in `lower/index.ts`. The order is not
incidental — several passes are only correct because of what has, or has not, already
run.

| # | Pass | What it does |
|---|---|---|
| 1 | `refinePlugins` | expands opaque plugin nodes into core HIR — **first**, so every later pass sees ordinary HIR |
| 2 | `refineBitwise` | bitwise operand/shift handling |
| 3 | `refineNumerics` | `f64` → `usize` where indexing demands it (*forcing*); `f64` → `i64` for integer switches and counting ranges (*preferring*) |
| 4 | `refineStrings` | a read-only `string` param's `&String` → the idiomatic `&str` |
| 5 | `refineStrAppend` | append → `write!`, killing the O(n²) string build |
| 6 | `refineRc` | `"use rc"` scopes **and** auto-detected escaping aliases → `Rc<RefCell<T>>` |
| 7 | `refineArena` | `"use arena"` scopes → `bumpalo` bump allocation |
| 8 | `refineTaskEscape` | spawn-arg captures → `Arc` / `Arc<Mutex<_>>` handles |
| 9 | `refineOwnership` | CFG + backward liveness → insert `.clone()` at moves that are live-out |
| 10–11 | `fixStringScrutinees`, `fixKeyBorrows` | match-scrutinee and Map/Set key borrow forms, on final param types |
| 12 | `refineIterFusion` | fuse single-use `map`/`filter`/`reduce` into one lazy chain |
| 13 | `refineSplitLazy` | a non-retaining `split` consumer → streaming `str::split`, no `Vec` |
| 14 | `refineDeque` | `Vec` → `VecDeque` where the access pattern warrants it |
| 15 | `refineTransitiveRefMut` | propagate `&mut` through call chains |

Three ordering constraints are worth naming, because each was learned the hard way:

- **Ownership runs after the directive passes, not before.** Once structs became
  movable, a class-typed alias `const b = a` inside a `"use rc"` scope was a move that
  the clone pass would rewrite to `a.clone()` — stomping the `Rc::clone` that `refineRc`
  produces. Running ownership last means it sees the HIR *with the directives' ownership
  model already imposed*, so it only fills the remaining plain-move gaps.
- **Task-escape runs before ownership.** It rewrites shared spawn captures to `arcClone`
  and `lockAccess` nodes; by the time the clone-inserting pass runs, those sites are no
  longer bare movable identifiers, so it leaves them alone instead of adding a spurious
  `.clone()`.
- **Iterator fusion runs last.** It needs final adapter shapes and settled ownership to
  decide whether an intermediate binding is genuinely dead-out.

---

## Ownership: a safe floor and a rising ceiling

Ownership inference is *the* central technical problem of this project, not a footnote —
that is the direct consequence of choosing idiomatic borrows over `Rc<RefCell>`-everything
(see [Design decisions](#design-decisions-and-their-trade-offs)).

`refineOwnership` (`src/ownership.ts`) builds a **CFG** per body and runs **backward
liveness** to fixpoint over it, then inserts `.clone()` at every move site whose
moved-from binding is live-out. Because HIR bodies are structured — the only non-lexical
edges are `break`/`continue`, both lexically scoped to the nearest loop — the CFG is
built by syntax-directed recursion rather than a general goto-solver.

The predecessor used *last textual use* as a proxy for last dynamic use, which is wrong
exactly where control flow bends: a value moved in a loop body but live across the
back-edge looks like a last use. The back-edge is the whole point of the CFG.

**Why this is safe to improve incrementally.** The pass only ever *adds* clones.
Liveness is a *may*-analysis — union at joins, fixpoint over back-edges — so it
over-approximates liveness and errs toward *more* clones, never fewer. Too conservative
costs a needless clone (slower, still correct). Anything it cannot prove stays a bare
move, which `cargo` rejects loudly. **The floor is already safe; each slice raises the
ceiling** by accepting more valid programs and emitting fewer needless clones.

Derives follow the same posture: `structDeriveClause` (`src/derives.ts`) computes an
*eligible* derive set from field types and emits `Clone` and `Debug` only when every
field qualifies. A derive that fails to compile is fail-loud pointing the wrong way — us
breaking a valid program — so derives are **on demand, never speculative**.

### Escaping shared-mutable aliasing

A JS object *is* a shared mutable reference. `const b = a; a.inc(); print(b.n)` has no
Option-A lowering: `const b = a` is a move and the later use is `E0382`.

`src/alias-escape.ts` detects this — a union-find over alias edges among class-typed
bindings, promoting any binding that is both aliased and mutated — and `refineRc`
lowers the promoted set to `Rc<RefCell<T>>` automatically, with no directive.

The risk calculus here is the **inverse** of the usual one: a false positive is cheap
(a binding wrapped that did not need it — slightly slower, still correct), so imprecision
toward *more* `Rc` is fine. The one place auto-`Rc` stops being merely faithful is the
`RefCell` **runtime panic**: `borrow_mut()` panics if a borrow is outstanding, and JS
never panics there. That specific pattern — a borrow held across a re-entrant mutation,
i.e. mutate-during-iteration — stays fail-loud rather than being silently promoted.

---

## Type resolution — the TypeOracle

`src/type-oracle.ts` embeds a real `tsc` checker (the v5.9.3 JS API, loaded via
`createRequire`) behind a **span-based boundary**: every query is `[start, end]` from the
oxc AST, mapped to a `tsc` node. Keeping the surface that narrow is what makes the
eventual migration to the tsgo v7 native checker a swap behind the boundary rather than a
rewrite.

It runs **two programs**, deliberately:

- **The `noLib` program** — no `lib.d.ts`, so only types the source states explicitly are
  resolvable. ~1 ms. This is the fast path and it answers every annotation-derived query.
- **A lazily-built lib-enabled program** — pinned to an explicit `es2022`-ish bundle
  rather than the tsc default, so the inferable surface is deterministic and reviewable.
  Built once, memoized, and only on the **first** query that actually needs inference. A
  fully-annotated module never pays for it.

`receiverTypeOf` (`lower/typing.ts`) is the single answer to "what type is this
receiver," in three tiers, cheapest first: a bare identifier hits the binding table, a
`this.field`/`local.field` hits the struct-field table, and anything else — `getX()`,
`a.b.c`, an index chain — goes to the oracle. **The precedence is the safety property:**
the hand-rolled tiers keep every receiver they already answer byte-for-byte, and the
oracle can only ever turn a `null` into a resolution — it never changes an existing
answer, and its absence (no source threaded) degrades to exactly the prior behavior.

### The re-validation gate

Annotations used to be mandatory, and that rule was a *forcing function*: you could not
accidentally feed the compiler a tuple or an anonymous object because you had to write
the type, and an unmodeled annotation was refused.

Inference relaxes the rule for local bindings and for function/method return types, so
that forcing function had to move somewhere. It moved to the **re-validation gate**: an
inferred `tsc` type is translated through the same `rustTypeOf` mapper that every other
path uses, and **anything outside the modeled surface returns `null`, which restores the
original fail-loud message**. A tuple, a function type, an anonymous object, a wide
union, `any`, `unknown`, `bigint`, `symbol` — each is refused exactly as loudly as a
missing annotation was, and points at the same fix.

**Parameters are a hard boundary, not a deferral.** An un-annotated parameter is
implicit `any` to `tsc`, and `any` is forbidden. There is no sound type to infer.

---

## Package & crate topology

```
packages/
  compiler/          the compiler — TypeScript on Bun (~37k LOC over src/)
    src/lower/       19 cohesive modules; index.ts is real orchestration
    src/harness/     the verification oracle (cargo + rustfmt)
    rust-oracle/     the persistent crate the harness compiles into
    tests/           160 spec files + tests/fixtures/**
  std/               @ttr/std — the TS-side std-shim (real, Bun-runnable TS)
  plugin-leftpad/    the reference plugin's TS half
crates/
  tslib/             the JS-fidelity runtime the emitted code links
  ts-primitives/     minimal runtime (TsAny) — the Option-A last resort
  ttr-plugin-leftpad/  the reference plugin's Rust half
  ttr-facade-fixture*/ fixtures for the facade generator
apps/website/        docs site (scaffolded; deliberately not deployed)
benchmarks/          Node vs Bun vs ttr over one shared corpus
```

`lower.ts` was once a 16,462-line monolith — the widest, most-edited file in the
compiler and the one every dialect series had to reopen. It is now a 19-module
folder-module, and the way it got there is the reusable part: **extraction and cleanup
were kept as two separate epics with two different gates.** Extraction's gate was
**byte-identical emitted Rust across the whole corpus after every commit**, which makes a
16k-line move mechanical, reviewable and reversible — a reviewer can trust "the bytes did
not move" without re-reading the logic. Cleanup inherently changes bytes and needs a human
reading each diff for intent. Fusing them would have forced every mechanical move through
a semantic review and robbed the byte gate of its meaning. `bun run lower:snapshot` /
`lower:verify` still exist and still gate that corpus.

`index.ts` holds real orchestration — `lower()`, `lowerCrate()`, the refine-chain
composition — which is what makes it a legal folder-module under the repo's **no barrel
files** rule rather than a re-export shim.

### Multi-file programs are one crate

A program that imports `./`-relative modules is resolved transitively (`src/crate.ts`,
with a cycle-terminating visited set) and emitted as a **single Rust crate** — one
`cargo run`, one stdout to diff. Visibility is inferred to `pub(crate)` granularity, a
pure re-export barrel becomes a generated `pub use` facade, and a `namespace` becomes a
nested `mod`. Bare and package imports are refused; `@ttr/std` is the only modeled
non-relative specifier.

---

## The three routing lanes

Every JS-semantics divergence has to be absorbed somewhere. There are exactly three
places it may go, and the choice among them is a recurring design decision rather than a
one-off:

1. **Native Rust** — when Rust's semantics already match. `trim()` → `.trim()`.
2. **`tslib`** — a Rust-side runtime crate the emitted code links, carrying the JS
   quirk. `crates/tslib/src/` splits by domain: `string`, `number`, `array`, `json`,
   `regex`, `date`, `rng`, `io`, `http`, `gen`, `truthy`, `ops`. This is where
   `padStart`'s exact semantics, JS number formatting, and UTF-16-vs-`char` indexing
   live.
3. **`@ttr/std`** — a **TS-side** blessed surface the developer imports *instead of* a
   footgun API. It is the dialect's isolation boundary for problems neither other lane
   can rescue: bare `JSON.parse` returns `any`, which is forbidden outright, so
   `parseJson<T>` moves the type to the call site where it can be checked.

The routing principle: **native when the semantics match; `tslib` only when a JS quirk
must be reproduced; never a coercion macro** — type and ownership decisions stay in the
inference passes, never in a macro.

`@ttr/std` is deliberately **real, Bun-runnable TypeScript** (`packages/std/`). That is
what lets the differential oracle execute the shim faithfully on the TS side and compare
against the Rust the compiler emits. A mock would have made the comparison meaningless.

Recognition is **anchored to the reserved import specifier `"@ttr/std"`, never to a name
heuristic** — a user's own `parseJson` imported from anywhere else is not hijacked.

---

## The verification oracle

Correctness is judged by a **real Rust toolchain**, driven from TypeScript so results are
structured and programmable instead of opaque pass/fail.

- **Tier 1 — COMPILES.** Emit Rust, `cargo check` it. As a **library** target, so a
  bare-function snippet with no `main` still verifies.
- **Tier 2 — BEHAVES.** For complete programs, run the TypeScript under Bun and the
  emitted Rust under `cargo run`, and assert the stdouts match. Differential testing.

`harness/cargo.ts` parses `--message-format=json` into typed `RustDiagnostic`s — level,
error code, source spans, rendered text — which is the leverage: a failure is explainable
and can be mapped back to a TS span.

`harness/index.ts` owns one **persistent** `rust-oracle` crate, serialized through a
promise queue (one source file, one writer at a time). Reusing a single crate keeps the
incremental-compile cache warm; it declares an empty `[workspace]` to isolate itself from
the repo workspace.

**Offline-first with an online fallback.** The oracle crate depends on tokio (async
lowering targets it), so it cannot be purely offline. `runCargo` tries `--offline` first
and retries online **only when cargo fails before producing any diagnostic** — the
signature of a cold-cache fetch. A genuine compile error always comes back with
diagnostics, so it never triggers a wasted online retry.

**What was retired, and why it matters.** The original approach asserted emitted Rust by
string-equality against hand-written golden `.rs` files. It was brittle to formatting, it
rejected idiomatic-but-different output, and — as several original fixtures proved — it
let *invalid* Rust (a bare `let` at module scope) masquerade as a passing test. Never
assert emitted Rust by string comparison.

The one exception is `lower:verify`, which diffs emitted bytes across the corpus. That is
not a correctness oracle; it is a **refactor** gate, and it means the opposite thing —
"prove nothing changed," not "prove this is right."

---

## Extension points

### Plugins — recognize and expand, never emit text

The obvious reading of "let plugins add emitter logic" is "let a plugin hand the emitter
a string of Rust." That is a raw-text escape hatch and it is **fatal** to everything
above: the compiler could no longer vouch for what it emits, and would become a
templating engine with a trusted-input assumption. The whole plugin design is the answer
to *how do you get plugin-authored codegen without a text-emit seam?*

> Plugins **recognize** blessed TypeScript shapes and **expand** them into **core HIR** —
> the same HIR the built-in lowerer produces. They never emit text and never introduce an
> emitter case with real logic.

Mechanically: lowering routes an owned shape to a single opaque `{ kind: "plugin", owner,
payload }` HIR variant; `refinePlugins` — first in the refine chain — replaces it with
core HIR from the plugin's `expand(payload)`; the emitter's `"plugin"` case is a
**fail-loud assertion** that a node survived expansion, and emits nothing. The emitter
gains exactly one case, and that case emits nothing, so exhaustiveness survives intact
and every downstream pass treats plugin output exactly like built-in output.

A conforming plugin declares four parts, and is refused at registration if any is
missing: its **owned specifier(s)**, its **`MODELED` contributions plus a rejection
corpus**, its **`recognize`/`expand` pair**, and its **Rust crate plus Cargo-dep
manifest**. Plugins are bilingual from v1 because `expand()` inevitably needs a runtime
to call into, and a half-contract that could not declare its Cargo deps would have been
reworked immediately.

Anything that genuinely needs a Rust construct core HIR cannot express is an **in-tree**
job — a new `hir.ts` variant, emitter case, and `MODELED` entry, reviewed in-tree — not a
plugin.

`@ttr/std` is registered as the first plugin *for recognition*, which is where the
registry generalizes from. Its **lowering** stays special-cased: the fallibility fixpoint,
the `fsAsync`/`http` namespaces and the `JsonValue`/`Writer`/`HttpResponse` type
intrinsics are not a pure expand-to-HIR-call.

### `ttr facade` — reading a Rust crate's real signatures

`ttr facade <crate>` generates a types-only `.d.ts` plus a method table from a crate's
**rustdoc JSON**, which is how a future mirror plugin will learn a crate's true
signatures — fully-qualified paths, per-parameter borrow shapes, resolved error types.

rustdoc JSON was chosen because rustc has already done name resolution, macro expansion
and alias resolution. `syn` was rejected as purely syntactic (it cannot follow `pub use`
re-exports, cannot expand the macros that generate half of candle's API, and cannot
resolve a `Result<T>` alias to its error type); rust-analyzer-as-a-library was rejected as
a massive, also-unstable, Rust-side dependency for a TS-on-Bun tool.

The cost of the choice is rustdoc's **nightly + unstable-format** tax, which is contained
rather than absorbed: nightly is needed by this one subcommand, at facade-generation time
only, never at a consumer's build or run time. The generator pins a `format_version` and
fails loud on mismatch.

### Escape-hatch directives

A leading string-literal directive — the same position JS uses for `"use strict"` —
switches the translation strategy for its lexical scope. The default dialect stays
strict; the directive is an **explicit, opt-in** alternative, and an unrecognized
`"use …"` is a `DialectError` rather than a silent no-op.

- **`"use panic"`** — `throw` becomes `panic!` instead of the `Result`/`?` model, and the
  scope is treated as infallible by the fallibility fixpoint. `try`/`catch` stays rejected
  inside it: `catch` cannot faithfully catch a `panic!`.
- **`"use rc"`** — the scope is lowered under `Rc<RefCell<T>>`. Now largely subsumed by
  automatic promotion (above), which is per-binding rather than per-scope.
- **`"use arena"`** — `bumpalo` bump allocation for the scope.

Under `"use rc"` and `"use arena"`, object `===` recovers JS **identity** semantics
(`Rc::ptr_eq` / allocation identity), because an instance finally has a stable heap home.
Everywhere else it is structural — see [DIALECT.md](./DIALECT.md).

---

## Toolchain policy

Three roles have genuinely different requirements, and conflating them is what made "does
`ttr` need nightly?" ambiguous:

| Role | Who | Requirement |
|---|---|---|
| Emitted crate (MSRV) | a consumer building `ttr`'s output | **stable ≥ 1.85** (edition 2024, set by `ts-primitives`) |
| Harness / oracle | `ttr` verifying its own output | any **stable** cargo ≥ MSRV — never nightly |
| Facade generator | `ttr facade` only, dev-time | **nightly** rustdoc-json — opt-in |

`ensureToolchain(role)` (`src/toolchain.ts`) is the single fail-loud gate every
cargo-spawning path routes through: detect → consent-gated `rustup toolchain install` when
interactive → otherwise fail loud naming the exact command. Configuration precedence is
CLI > env > `ttr.toml` > `rust-toolchain.toml` > default.

---

## Design decisions (and their trade-offs)

- **Idiomatic ownership (Option A) over `Rc<RefCell<T>>`-everything (Option B).** Option B
  is trivial to emit but slow, unidiomatic and refcount-heavy — and it makes the whole
  project pointless, because idiomatic output is the entire reason to target Rust. The
  cost is owned explicitly: **ownership inference becomes the central technical problem**,
  requiring real escape and mutation analysis. `Rc<RefCell<T>>` survives as a local
  fallback for the rare shape that genuinely needs shared mutability.
- **A compile-and-run oracle over golden-file comparison.** Costs real wall-clock — every
  fixture builds and runs a Rust crate, which is why the differential suite is sharded
  8 ways in CI and does not gate PRs. Buys the only guarantee that matters: a passing test
  means the Rust actually builds and produces the right output.
- **Default-deny parsing over allow-and-patch.** Any AST node type not in `MODELED` is
  refused. The cost is that adding a construct requires an explicit accept-set entry; the
  benefit is that a construct nobody has thought about cannot be silently mistranslated —
  which is exactly what happened before the gate existed.
- **Fail-loud in two classes rather than one.** Slightly more machinery than a single
  error type, but a user needs to know whether to change their code or wait for us.
- **Expand-to-HIR plugins over a text-emit seam.** Costs plugin authors expressiveness —
  anything core HIR cannot express has to come in-tree. Buys the property that the
  compiler still vouches for every byte, because every byte still comes from HIR it owns.
- **An open/extensible HIR union was rejected** for the same reason: it would destroy
  compile-time exhaustiveness, turning a missing emitter case from a type error into a
  runtime surprise.
- **Specifier-anchored recognition over name heuristics.** Two plugins may both define
  `parse` without colliding, and a user's own same-named import is never hijacked.
- **Inference behind a re-validation gate rather than mandatory annotations.** Ergonomics
  improve; the narrowness of the accepted surface is preserved by the gate rather than by
  the annotation requirement. Parameters stay a hard boundary because implicit `any` has
  no sound answer.
- **Two `tsc` programs rather than one.** More machinery than a single lib-enabled
  program, but a fully-annotated module — the common case — keeps the ~1 ms path instead
  of paying tens of milliseconds to load `lib.d.ts` it will never consult.
- **Automatic `Rc` promotion over requiring the directive.** The user would otherwise
  discover shared-mutable aliasing as a raw borrow-checker error against *generated* Rust
  rather than against their own TypeScript. The trade is accepting occasional
  over-wrapping, which is cheap; the `RefCell`-panic pattern stays fail-loud because it
  would diverge from the differential oracle.
- **Extraction and cleanup as separate epics with separate gates.** Slower than
  refactoring as you go, and the only way a 16k-line decomposition stays reviewable.
- **No barrel files.** Re-export barrels hide the dependency graph and rot. A folder's
  `index.ts` must hold real functionality; siblings import each other directly.

---

## References

- [DIALECT.md](./DIALECT.md) — the accepted subset and its Rust mapping. Authoritative.
- [WHAT_IT_IS.md](./WHAT_IT_IS.md) — per-feature guarantees and honest limits.
- [VERSION_ROADMAP.md](./VERSION_ROADMAP.md) — the state of the release effort.
- [CONTRIBUTING.md](./CONTRIBUTING.md) — how work is tracked and how a change ships.
- [`../CLAUDE.md`](../CLAUDE.md) / [`../.agents/AGENTS.md`](../.agents/AGENTS.md) — the same rules for coding agents.
