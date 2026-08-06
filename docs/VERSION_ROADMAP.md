# Version roadmap

**GitHub Issues are authoritative.** This document is the honest *state* of the release
effort — what is real, what is not, and what is deliberately not on the spine. It is not
a schedule and it is not the backlog. Where it disagrees with the tracker, the tracker
wins and this file should be corrected.

Last reconciled against the code and the tracker: **2026-08-06**.

## Situation

`ttr` has **never been released**. There are no git tags, no GitHub Releases, and no
published package on any channel — npm, crates.io, Homebrew, or GitHub Releases binaries.
Running from source (`bun run ttr <file.ts>`) is the only supported path today, and the
README says so.

Three milestones exist — `v0.1.0`, `v0.2.0`, `v0.3.0` — and **all three are empty**. No
issue is assigned to any of them.

That is deliberate, and it is the single most important thing on this page: **no milestone
has locked scope.** The milestones are containers waiting for a scope decision, not
commitments that have been made and not met. What *is* committed is carried by the
`plan-next` label, which means exactly "committed, not yet scheduled."

The repository itself is public. That much of the release epic (#104 W8) is done.

## What v0.1.0 is meant to be

The shape of the first release is designed and tracked as **epic #104 — public
open-source release**, decomposed into nine sub-issues, W1–W9. That epic is the candidate
scope for `v0.1.0`; it has not been assigned to the milestone, because assigning a
milestone is a scheduling decision.

| | Workstream | State |
|---|---|---|
| #105 | W1 — license + attribution | Initial pass landed: `LICENSE-MIT`, `LICENSE-APACHE`, `NOTICE`, and the dual-license statement in the README are all in the tree. Open for the attribution sweep. |
| #106 | W2 — package hygiene + emitter path→version | **Not started.** Every workspace package is still `private: true`, and `packages/compiler` has no `name` at all. Nothing is publishable as it stands. |
| #107 | W3 — distribution channels + release tooling | **Not started.** The README's channel table (`bunx @ttr/cli`, Homebrew, crates.io, Releases binaries) describes W3's *output*, not anything that exists. |
| #108 | W4 — CI/CD + branch protection | Partly real: `ci.yml` (lint · typecheck · cargo test, per-PR), `oracle.yml` (the sharded cargo-backed differential suite, on `v*` or manual), and `playbook.yml` (backlog invariants) all run. Branch protection and the release pipeline are open. |
| #109 | W5 — README overhaul | Partly real — the README has been rewritten once. Open for the pre-release pass. |
| #110 | W6 — docs website | Scaffolded (`apps/website`, Next.js). **Nothing is live**: `website.yml` is deliberately manual-dispatch-only, because the project is being released as source rather than product-ized. |
| #111 | W7 — community-health files + templates | Issue templates exist (`epic`, `idea`, `rfc`, `implementation-plan`, `release-gate`). `CONTRIBUTING.md` now exists. Code of conduct, security policy and PR template are open. |
| #112 | W8 — curate + secret-scrub + open the repo | **The repo is public.** The curation and scrub work that preceded it is done. |
| #113 | W9 — cut v0.1.0 + announce | Blocked on the rest. This is the issue that turns a milestone into a tag. |

**Before v0.1.0 can be tagged, W2 and W3 are the load-bearing gaps** — the compiler
package is not currently publishable under any name, so no distribution channel can work.

## Complete — in the code, not yet released

These shipped and are covered by the oracle suite. They are not "coming"; they are here,
in an unreleased tree.

- **The whole pipeline.** parse (oxc) → default-deny dialect validation → symbol/scope
  resolution → typed HIR → ownership and mutation analysis → Rust emission → rustfmt.
  One IR, not two.
- **The Option A memory model** — idiomatic ownership (`T` / `&T` / `&mut T`, real moves),
  with `Rc<RefCell<T>>` as a local fallback rather than the strategy. This was the central
  technical bet and it is settled.
- **The oracle.** Tier 1 compiles the emitted Rust with `cargo check`; tier 2 runs both
  the TypeScript (Bun) and the Rust (`cargo run`) and compares stdout. String-matching
  against golden `.rs` files was retired — it let invalid Rust pass.
- **The accepted dialect**, catalogued fail-loud rejection by fail-loud rejection in
  [`DIALECT.md`](DIALECT.md): classes with inheritance and generics, interfaces
  with usage-directed dual lowering, enums, generators, `async`/`await` on tokio, the
  `AppError` enum with `instanceof` catch discrimination, modules, closures and callbacks,
  destructuring, unions, regex, dates, and the `@ttr/std` shim for I/O and JSON.
- **`ttr facade`** (series 122) — generates a types-only `.d.ts` plus a method table from
  a Rust crate's rustdoc JSON. This is the first piece of the mirror-plugin archetype and
  it shipped ahead of the rest of it.
- **An explicit toolchain policy** (series 123) — MSRV `1.85`, inherited workspace-wide,
  with `ensureToolchain(role)` as the single fail-loud gate on every cargo-spawning path.
- **Benchmark-driven codegen wins** (#86 and children). All three original corpus losses
  are now wins end to end: `loopsum`, `arraypipe`, and `strbuild`. `ttr` also wins on
  resident memory (1.4–14 MB vs 30–105 MB) and startup (4.2 ms vs Bun 12.2 ms, Node 97 ms).

## Still deferred

Committed but unscheduled — everything below carries `plan-next` or `idea` and no
milestone.

| | What | Why it is not scheduled |
|---|---|---|
| #2 | Graduate the fail-loud deferral backlog | An epic, not a unit. Its remaining children are individually dialect-shape decisions. |
| #51 | The 029 library-method catalog | Its row list has gone stale — #138 re-verifies every row against the shipped lowering before anything is planned against it. #139 (variadic `Math.min`/`max`) is the one row that is unambiguously absent. |
| #59 | The dynamic/recursive value model (`JsonValue`) | Gate 1 is not passed. It is a deliberate hole in the dialect's static premise, and the design has to say exactly how large that hole is. #134 is that design. |
| #86 | Benchmark-driven codegen performance | One corpus residual left: #133, `strsearch` short-needle throughput. |
| #98, #99, #100 | Three known codegen bugs | Real, reproducible, and `plan-next`: a non-exhaustive `match` tail over an enum (E0308), `String(x)` over an enum emitting invalid Rust (E0423), and adapter-chain element types going unresolved. |
| #118 | Plugin archetypes — mirror vs macro | D1 (a Rust-authoritative oracle mode) blocks the other five. Without it there is no way to test a mirror plugin at all. |
| #79, #138 | Two verify-then-triage sweeps | Both exist because a list that says "not done" about things that are done is worse than no list: it aims effort at work that does not exist while hiding the work that does. |

## Not on the release spine

These feed the spine; they never ride it.

- **The `experiment` lane.** A spike's deliverable is a decision, not a feature. It gets
  no milestone, by invariant.
- **#61 — migrate `TypeOracle` to the tsgo v7 native checker.** Externally blocked: there
  is no v7 compiler API yet.
- **#25 — the Rust-AST + pretty-printer rewrite.** A structural improvement to how Rust is
  produced. Real, `idea`, and not a user-visible feature.
- **#91 — the boundary-boxed `Numeric` hybrid.** Filed so the sound shape is decided
  before it is ever built. Every number in the benchmark corpus is statically provable, so
  nothing today needs it.
- **The docs website.** Scaffolded and deliberately undeployed. It is not a v0.1.0 gate.

## See also

- [`WHAT_IT_IS.md`](WHAT_IT_IS.md) — per-feature guarantees and honest limits.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — the two-axis model, the ladder, and the gates.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the compiler is built, and why.
