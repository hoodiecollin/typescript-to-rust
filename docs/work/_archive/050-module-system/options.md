# 050 — Module system — OPTIONS EXPLORATION (2026-07-16)

> **RESOLVED — see `design.md`.** Collin's decisions on all five axes landed
> 2026-07-16; the resolved design is in `design.md` (Decisions section). This doc is
> retained as the **exploration record** only.

**Status (historical):** `needs-design` / `needs-user-input`. This is an **options**
doc, not a settled design. It superseded the recorded baseline in the old `design.md`
(issue #6, 2026-07-07) pending Collin's redecision. Present tradeoffs; pick nothing
unilaterally.

**Framing (Collin, verbatim):** *"the module system in rust is powerful and
expressive. It should be easy to replicate module importing; the real value lies in
creativity beyond that."*

So: **mechanical 1:1 import replication is the trivial floor — assume it works.** The
`design.md` baseline (each TS file → inline `mod name {}` in one crate; `export`→`pub`,
`import { f } from "./x"`→`use crate::x::f;`; single compilation unit) is that floor.
This doc explores what a TS→Rust translator can do **beyond** it by exploiting Rust's
module-system expressiveness — always keeping every idea **fail-loud-honest** (no
silent semantic guess) and **differential-testable** (the emitted program's observable
stdout must match Bun running the same TS).

## Ground truth carried forward (verified 2026-07-16)

These constrain every option below; they are facts about the current tree, not choices.

- **`import` is already partly modeled.** `validate.ts`'s `MODELED` set contains
  `ImportDeclaration` + `ImportSpecifier` (added series 084 for the `@ttr/std`
  std-shim). A `checkStdShimImport` guard rejects any specifier other than
  `"@ttr/std"` and any non-named import form. So the parse gate, the AST shapes, and
  an import-recognition lowering path (`lower.ts` line ~326: `ImportDeclaration` →
  recognition-only, lowers to nothing) **already exist**. The module system *extends*
  this lane to `./`-relative specifiers; it does not add `import` from scratch.
- **`export` is fully fail-loud.** No `ExportNamedDeclaration` / `ExportSpecifier` /
  `ExportDefaultDeclaration` / `ExportAllDeclaration` is in `MODELED`; each rejects as
  generic `Unsupported <NodeType>`. Export support is greenfield.
- **The pipeline is single-`Program`.** `index.ts` reads one file, calls
  `lower(parsed.program, source)` → one `HirModule`, then `emitModule(mod)`. There is
  no resolver, no multi-file graph, no `lowerCrate`. `analyzeModule(program)` and every
  ownership/fallibility/numeric pass are per-`Program`, name-based, per-function.
- **The differential harness emits ONE compilation unit** (`src/lib.rs` / `main.rs`)
  and `cargo`-runs it. This is the single biggest constraint on layout options (axis 2).
- **Map/Set backing is `indexmap`** (series 061): the emitter deep-scans the HIR and
  emits `use indexmap::IndexMap;` / `IndexSet;` / `use std::collections::…` per module.
  Any `mod`-nesting option must reproduce this prelude **per `mod`** (items inside a
  `mod` don't see the parent's `use` prelude).

---

## Axis 1 — Minimal-visibility inference

**The gap TS can't express.** TS visibility is binary: a symbol is `export`ed or it
isn't. Rust has a *lattice*: `priv` ⊂ `pub(self)` ⊂ `pub(super)` ⊂ `pub(in path)` ⊂
`pub(crate)` ⊂ `pub`. A faithful-but-dumb translation collapses this to
`export`→`pub`, `else`→`priv` (the baseline). But we can **infer the tightest
visibility that still compiles** from *actual cross-module usage*, giving the emitted
Rust real encapsulation the TS source never stated.

**Rust mechanism → what it buys.** With the whole resolved module graph in hand, for
each declaration compute its *observed use-set* (which modules reference it):

| Observed use of an `export`ed symbol | Tightest visibility | Beats baseline how |
|---|---|---|
| referenced by no other module (exported but unused across files) | `pub(crate)` (or even `priv` if truly local) | baseline emits `pub`; we seal it |
| referenced only by descendant `mod`s | `pub(self)` / none needed | child mods see ancestors already |
| referenced only by the parent `mod` | `pub(super)` | narrower than `pub(crate)` |
| referenced only within a subtree rooted at `path` | `pub(in crate::path)` | precise sub-tree scoping |
| referenced by the entry / crate-external boundary | `pub(crate)` (single crate) or `pub` (workspace) | as needed |
| a `pub(crate)` widening forced by `private_interfaces` (a private type in an exported signature) | `pub(crate)` | the baseline's MOD8 rule, generalized |

**Tradeoffs.** (+) The output reads like hand-written idiomatic Rust and the compiler
*enforces* the inferred encapsulation — a later hand-edit that over-reaches fails to
compile, a genuine value. (−) It needs a **global, resolved symbol graph** (which the
baseline's `lowerCrate` + global symbol table already build for MOD13-16), so it can't
run in the per-`Program` fast path. (−) Inference bugs surface as *compile errors*
(too tight) not wrong behavior — which is the fail-loud-friendly failure mode, but it
raises the bar on getting reachability right (re-exports, trait impls, generic bounds
all widen the true use-set).

**Fail-loud / differential stance.** Visibility never changes runtime behavior, so
mis-inference can only (a) fail to compile (caught by the harness `cargo check`) or
(b) be *looser* than optimal (harmless). Neither corrupts the differential oracle. This
axis is the **safest** place to be aggressive. MOD8/MOD9 already gesture at it; push to
the full lattice.

**Recommended default:** **infer to `pub(crate)` granularity** (exported+cross-used →
`pub(crate)`; exported+not-cross-used → `pub(crate)` too, conservatively; signature-
reachable private types → `pub(crate)`; purely local → `priv`). Defer the finer
`pub(super)` / `pub(in path)` tiers to a follow-on once a fixture demands them — they
add graph complexity for encapsulation nicety, not correctness.

---

## Axis 2 — File layout vs module tree decoupling

Rust decouples the *module tree* from the *file layout*. Three emission targets:

- **(a) Inline `mod name {}` in one file (the 050 baseline).** Single compilation
  unit; the harness is unchanged (`emitModule` already produces one `lib.rs`). Nesting
  reproduces the prelude per-`mod`. (+) Zero harness change, trivially differential.
  (−) One giant file; doesn't showcase Rust's file-module idiom.
- **(b) Real multi-file cargo project (`src/foo.rs` + `mod foo;`, or `foo/mod.rs`).**
  The module tree maps to real files/dirs mirroring the TS `./util/math.ts` layout.
  (+) Idiomatic; readable; the natural Rust shape. (−) The **harness must emit and
  compile a multi-file crate** — a real change to `harness.ts` (today it writes one
  `.rs` into `.scratch`). Manageable: write N files + a generated `mod` root, one
  `cargo run`. Still ONE compilation unit's *output* to diff (one stdout).
- **(c) Multi-CRATE cargo workspace** when the TS project has natural package
  boundaries (e.g. a monorepo with several `package.json`s, or top-level dir clusters).
  (+) Real crate isolation, `pub` becomes a genuine crate boundary, enables per-crate
  `#[cfg]`. (−) Biggest harness lift (a `[workspace]` `Cargo.toml`, inter-crate path
  deps, one binary crate as entry); crate-graph cycles are **illegal** in Rust (unlike
  intra-crate `mod` cycles), so a TS import cycle spanning package boundaries becomes
  **fail-loud** — a new residual the baseline didn't have.

**Interaction with the differential harness.** The oracle compares **stdout**, so any
of (a)/(b)/(c) is differential-testable as long as exactly one binary is run. The cost
gradient is entirely in *emission + compile orchestration*, not in the oracle. (a) is
free; (b) is a contained harness change; (c) is a project-shape feature.

**Recommended default:** **(b) real multi-file layout, single crate**, with (a) kept
as the no-import fast path (backward-compatible with every current fixture) and (c)
flagged as a *later, opt-in* mode gated on a detected multi-package TS project. (b)
delivers "creativity beyond 1:1" (idiomatic file modules + axis-1 visibility) at
contained harness cost; (c)'s crate-cycle fail-loud and workspace scaffolding are worth
deferring until a real multi-package fixture exists. **Needs Collin's call** — (b) vs
staying at (a) is the load-bearing decision for harness scope.

---

## Axis 3 — Sanctioned facades / `pub use` re-exports

**The ethos tension.** The project has a **no-barrel ethos for its OWN source**
(`.agents/AGENTS.md`, memory: import siblings directly, no re-export barrels). The
baseline honors it by making `export * from` / `export { x } from "./y"` **Forbidden**.
But real TS ecosystems lean *heavily* on `index.ts` barrels — refusing them may reject
a large fraction of real input.

Rust's idiomatic equivalent of a barrel is a **`pub use` facade**: `pub use
self::math::add;` re-exports a child's item at the parent path. It is *not* the
anti-pattern the no-barrel rule targets (that rule is about *authoring* discipline in
our own repo); a *generated* facade translating a *user's* barrel is a faithful
translation of their intent.

**Two positions to surface (this is a genuine dialect-ethos fork for Collin):**

- **Position A — the ONE sanctioned re-export.** A barrel `index.ts` (a file whose body
  is *only* `export … from "./x"` re-exports) → a generated `mod` of `pub use`
  facades. Everything else about the no-barrel ethos (our own source) is untouched.
  (+) Accepts idiomatic TS input; `pub use` is genuinely idiomatic Rust. (+) Enables
  axis-2(c) crate facades (a crate's `lib.rs` *is* a `pub use` facade). (−) A
  renamed/aliased re-export (`export { x as y } from`) needs `pub use … as y;` — fine
  in Rust, so the baseline's "renamed export fail-loud" residual could *lift* here.
- **Position B — stay fail-loud.** Barrels remain Forbidden; force the user to import
  from the concrete module. (+) Preserves the ethos uniformly; simplest resolver
  (no facade module synthesis, no re-export cycle reasoning). (−) Rejects common input.

**Fail-loud / differential stance.** A `pub use` facade has no runtime effect (pure
name routing), so it's differential-safe. The risk is *resolution correctness*: a
facade re-exporting a facade (barrel-of-barrels) needs cycle-aware path resolution, and
a `export *` glob re-export must enumerate the source module's exported set at
translate time (no runtime glob in Rust — `pub use x::*` is static, which actually maps
cleanly). Both stay fail-loud if the enumeration is ambiguous.

**Recommended default:** **Position A, minimally** — accept a *pure* barrel `index.ts`
(re-exports only, `./`-relative sources only) → a `pub use` facade; keep `export
default` Forbidden (no named analog); keep a barrel with *mixed* logic + re-exports
fail-loud (ambiguous). This is the highest-leverage "creativity beyond 1:1" for real
input, but it **directly touches the ethos** so it is explicitly `needs-user-input`.

---

## Axis 4 — `namespace` / nested-module expressiveness

TS `namespace Foo { … }` and directory nesting both map naturally onto Rust's nested
`mod` trees, and Rust's `use` syntax offers ergonomics TS `import` lacks:

- **`namespace Foo { export … }`** → `mod foo { pub … }`; `Foo.bar()` → `foo::bar()`.
  A merged/reopened namespace (`namespace Foo` twice) → items merged into one `mod`
  (Rust `mod` can't reopen, so we coalesce at translate time). A nested namespace →
  nested `mod`. (Note: `namespace` is **not** in `MODELED` today — `TSModuleDeclaration`
  would be a new gate entry; greenfield.)
- **Directory nesting** `./util/math.ts` → `mod util { mod math { … } }` (baseline
  already specifies this) or, under axis-2(b), real `util/math.rs`.
- **`use` aliasing** — `import { f as g }` → `use crate::x::f as g;` (baseline MOD3).
  Grouped imports `use crate::x::{a, b, c};` synthesized from multiple named imports of
  one source — a readability nicety.
- **Glob `use x::*`** — synthesizable from a namespace import `import * as ns` **only**
  if we bind `ns.member` accesses to `member` — but that changes name resolution and
  risks collisions, so the baseline keeps `import * as ns` fail-loud. A *generated*
  glob inside a facade (axis 3) is safe; a *user-facing* namespace import is not.

**Tradeoffs.** (+) `namespace` support widens accepted input meaningfully and maps
cleanly. (−) Namespace *value* merging with declaration merging (TS's namespace+function
merge) has no Rust analog → fail-loud. (−) Glob `use` risks silent name capture, which
is exactly the kind of un-fail-loud footgun to avoid in user code.

**Recommended default:** support **`namespace` → nested `mod`** (coalescing reopened
namespaces) and **grouped/aliased `use`** synthesis; keep **user-facing glob/namespace
imports fail-loud**; allow **generated** globs only inside sanctioned facades (axis 3).

---

## Axis 5 — Encapsulation-driven creativity

Ideas Rust's module system unlocks that have no TS source form. Each kept fail-loud and
differential-honest:

- **`#[cfg(test)] mod tests` for TS test files.** A `*.test.ts` sibling → a
  `#[cfg(test)] mod tests { … }` with `#[test]` fns. (+) Idiomatic; the transpiled
  suite runs under `cargo test`. (−) Needs a test-runner-shape mapping
  (`expect().toBe` → `assert_eq!`) — arguably its own series; flag as *future*, not 050.
- **Prelude-module generation.** Synthesize a `mod prelude { pub use … }` gathering the
  crate's common exports, so generated modules `use crate::prelude::*;`. Reduces `use`
  noise; purely mechanical; differential-neutral. Nice-to-have, not core.
- **Sealed traits via a private module.** An `export interface` that should not be
  externally implementable → a `pub trait` with a `mod private { pub trait Sealed {} }`
  supertrait bound. Real encapsulation TS *cannot* express. Only apply when usage proves
  no cross-module impl is intended (inference, like axis 1) — else it's an over-guess,
  so **default off**, opt-in.
- **Module-private helpers TS would leak.** A helper an `export`ed function closes over
  but the TS file also happens to `export` → axis-1 inference can keep it `priv` if no
  *other* module uses it, tightening beyond the source's stated surface.

**Conditional compilation (`#[cfg(...)]`) — a first-class future theme.** Beyond the
`#[cfg(test)]` test-file idea above, Rust's whole cfg family is a rich future seam the
module tree should leave room for (each its own separately-scoped series, fail-loud
until built): (1) **emit tests INTO the code** — a `*.test.ts` → `#[cfg(test)] mod
tests { … }` with `#[test]` fns run under `cargo test`; (2) **feature-flag conditional
inclusion** — `#[cfg(feature = "…")]`-gated items + a synthesized `[features]` table in
`Cargo.toml`; (3) the general `#[cfg(...)]`/`cfg_attr`/platform/`debug_assertions`
umbrella. Key oracle caveat: cfg changes *what compiles/runs*, so a spec must pin a
specific feature set and test enabled/disabled configs as distinct oracle runs. See
design.md's "Conditional compilation" subsection.

**Recommended default:** ship **prelude-module generation** (safe, mechanical) as an
emission nicety; treat **`#[cfg(test)]` test-file mapping** and **sealed traits** as
*separately-scoped future series* (they need their own fixtures + design), noted here
so the module tree leaves room for them.

---

## Interactions with concurrent campaign series (099, 100)

`docs/work/099-inference-tier/` and `docs/work/100-std-io/` exist as **empty
placeholder dirs** (created 2026-07-16, being designed in parallel). Couplings to
pin down once their designs land:

- **099 (annotation-inference tier) × non-entry modules.** If 099 lets a function omit
  its return annotation and infers the Rust return type, a **non-entry module**'s
  exported fn now has an *inferred* signature. Axis-1 visibility inference and axis-2(b)
  cross-file resolution both read exported **signatures** — so inference must run
  **before** the visibility/resolution passes, and the *inferred* type (not the absent
  annotation) is what gets widened to `pub(crate)` under `private_interfaces`. If 099
  infers a *private* type into a `pub` signature across a module boundary, the
  reachable-type closure (axis 1) must widen it or the crate won't compile — a direct
  ordering dependency. **Flag: 099's inference output must be available to the module
  resolver's global symbol table.**
- **100 (std I/O shim) × an imported module.** If a **non-entry** module imports
  `@ttr/std` (or the future I/O shim), its per-`mod` prelude must carry the shim's
  `use` lines / crate deps, and — critically — I/O side effects at a non-entry module's
  *top level* stay **fail-loud** (the baseline already forbids top-level statements in
  imported modules; import-time I/O has no sound Rust analog). A module that only
  *defines* fns calling shim intrinsics is fine; one that *runs* I/O at load time is
  not. **Flag: the "only the entry runs statements" invariant must survive the I/O
  shim — I/O doesn't earn an exception to it.**

---

## Summary — option axes & recommended defaults (for Collin's call)

The baseline (mechanical `mod`-per-file, `export`→`pub`, `import`→`use crate::…`,
single inline crate) is the **floor**; "creativity beyond 1:1" lives in five axes:

1. **Visibility inference** — infer the tightest Rust visibility from real cross-module
   usage (the `pub`/`pub(crate)`/`pub(super)`/`pub(in path)` lattice TS can't express).
   *Default: infer to `pub(crate)` granularity now; finer tiers later.* Safest axis —
   mis-inference only fails to compile, never corrupts the oracle.
2. **Layout** — inline (a) vs real multi-file crate (b) vs multi-crate workspace (c).
   *Default: (b) real multi-file single crate, (a) kept as the no-import fast path, (c)
   deferred to a detected multi-package project.* This is the **load-bearing harness
   decision** — needs Collin's call.
3. **Barrel facades** — translate a pure `index.ts` barrel to an idiomatic `pub use`
   facade (Position A) vs keep barrels Forbidden (Position B). *Default: Position A,
   minimally (pure re-export barrels only).* **Directly touches the no-barrel ethos —
   explicitly needs-user-input.**
4. **`namespace` / nesting** — `namespace`→nested `mod`, grouped/aliased `use`.
   *Default: support namespaces + `use` ergonomics; keep user-facing glob/namespace
   imports fail-loud.*
5. **Encapsulation creativity** — prelude modules, `#[cfg(test)]` test files, sealed
   traits. *Default: ship prelude generation; scope test-mapping + sealed traits as
   separate future series.*

**Cross-cutting:** 099's inferred signatures must feed the module resolver *before*
visibility/resolution; 100's I/O must not break the "only the entry runs statements"
invariant. **Two decisions are genuinely Collin's:** axis 2 (harness scope: multi-file
or not) and axis 3 (barrel ethos: sanctioned facade or fail-loud). The other three
axes have safe, differential-neutral defaults that can proceed once those two land.
