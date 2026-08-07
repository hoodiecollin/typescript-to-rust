# Version roadmap

**GitHub Issues are authoritative.** This document is the honest *state* of the release
effort — what is real, what is not, and what is deliberately not on the spine. It is not
a schedule and it is not the backlog. Where it disagrees with the tracker, the tracker
wins and this file should be corrected.

Last reconciled against the code and the tracker: **2026-08-07** — a full revalidation of all
open issues against the code, by probe rather than by reading, followed by a scope
assignment across four milestones.

## Situation

`ttr` has **never been released**. There are no git tags, no GitHub Releases, and no
published package on any channel — npm, crates.io, Homebrew, or GitHub Releases binaries.
Running from source (`bun run ttr <file.ts>`) is the only supported path today, and the
README says so.

The repository itself is public, with history kept. That much of the release effort is done —
which is why the release epic (#143) is about *publishing artifacts*, not about opening the
repo.

Four milestones exist and **all four now hold scope**: `v0.1.0`, `v0.2.0`, `v0.3.0`, and
`v0.4.0`. 42 of the 61 open issues are scheduled. Of the 19 unscheduled, 15 carry `idea` —
"speculative, and not yet scheduled" — and four do not: #126 and #134 are `rfc` designs
awaiting acceptance, #118 is an epic whose children are not yet filed, and #79 is a
`tech-debt` triage item. Nothing carries `plan-next` — there is no committed-but-unscheduled
work left.

The ordering is worth stating plainly, because it is not the obvious one: **correctness and
the dialect come first, publishing comes third.** The artifacts that make `ttr` installable
are not the first tag — they are `v0.3.0`, behind a milestone that closes the fail-loud
hole and graduates the deferral backlog, and behind the docs site.

### The one thing blocking a tag on correctness grounds

**#142 — the method router has no fail-loud fall-through.** When no route matches, the JS
method name is emitted verbatim as a Rust method call, so the failure lands as a `cargo`
error inside generated Rust instead of a clean `UnsupportedError`. It silently miscompiles
array `includes` / `indexOf` / `lastIndexOf` and dynamic-depth `flat(d)` today, and the
surface is unbounded — any unrouted method on a `Vec` or `String` receiver.

This is a `release-gate` on `v0.1.0` because fail-loud is the claim the project is sold on,
in the README, in `WHAT_IT_IS.md`, and in the dialect doctrine. An open `release-gate` means
its milestone cannot be tagged, by invariant. It also blocks honest triage: #79 and #138
both ask "is this row shipped?", and the natural probe — *does it fail loud?* — cannot
currently distinguish "unimplemented" from "implemented".

## What each milestone holds

### `v0.1.0` — correctness and the dialect

Eighteen issues. The theme is *make the thing honest before making it available*: close the
fail-loud hole, fix every reproducible codegen defect, and graduate the three dialect epics
that have real remaining children.

| Issue | Why here |
|---|---|
| **#142** `release-gate` | the fail-loud fall-through — blocks the tag outright |
| **#98** | `switch` with `return` in every case over an enum → non-exhaustive match tail (`E0308`) |
| **#99** | `String(x)` over an enum / literal union emits invalid `String(x)` (`E0423`) |
| **#100** | adapter chain `X.map(cb).reduce(…)` — adapter-result element type unresolved |
| **#163** | `async function main()` emits a bare `async fn main()`, no `#[tokio::main]` (`E0752`) |
| **#2** *(epic)* | graduate the fail-loud deferral backlog — children **#72**, **#74** |
| **#52** *(epic)* | the `@ttr/std` shim as a third routing lane — children **#75**, **#76** |
| **#157** *(epic)* | the library-method catalog — children **#138**, **#158**–**#162** |

Every codegen bug above was confirmed by repro on 2026-08-07: emitted Rust and cargo error
codes match their issue bodies exactly.

The five catalog children under #157 came out of that same pass. The one worth naming is
**#159** — an `Option<T>` cannot be printed or string-concatenated (`E0277`), which means
`find` and `Map.get`, both recorded as *landed*, return a value the dialect's only output
surface rejects. Unwrapping it first works; the coercion path is what is missing.

> **#72, #74, #75 and #76 are dialect-shape decisions**, not mechanical work. Per
> `CLAUDE.md`, they need Collin's input on the tradeoffs *before* a design is written —
> scheduling them does not exempt them from that gate.

### `v0.2.0` — the docs site

One issue, **#156**. Built and currently undeployed on purpose. It sits ahead of the
publishing work deliberately: there is more value in documentation that describes a narrow,
honest dialect than in a package that installs and then surprises people.

### `v0.3.0` — publishable artifacts

Thirteen issues: epic **#143** and its twelve native sub-issues. **Nothing is installable
today** — no package is publishable under any name, so no distribution channel can work.
That single fact orders the epic.

| | Issue | Why |
|---|---|---|
| 1 | #144 — publishable as `@ttr/cli` | `packages/compiler` is named `compiler`, has no `version`, is `private`, and has no `bin` |
| 2 | #145 — emitted crates resolve deps from crates.io | emitted Rust `use`s `tslib`; today it resolves by machine-local `path` and cannot work off this machine |
| 3 | #146 — publish the runtime crates | **reserve the names first** — the one deadline that is not ours |
| 4 | #147 — publish `@ttr/cli` + `@ttr/std` to npm | the channel the README already advertises |
| 5 | #148 — standalone binaries + Homebrew | removes the Bun prerequisite, not the Rust one |
| 6 | #149 — changesets + tag-driven release workflow | makes cutting a release a tag, not a checklist |
| 7 | #150 — `ttr doctor` | every channel still needs a local Rust toolchain |
| 8 | #151 — macOS in CI + branch protection | `ci.yml` is ubuntu-only; `main` is unprotected on a public repo |
| 9 | #152 — user-facing templates + CoC/SECURITY/PR | the five templates that exist are maintainer process ones |
| 10 | #153 — README accuracy + licensing residuals | the install table advertises four channels that do not exist |
| 11 | #154 — newcomer on-ramp | `good first issue` label exists, 0 issues carry it; Discussions disabled |
| 12 | #155 — cut the first release + announce | gated on the rest |

**Items 1–4 are the critical path, in order.** The rest can proceed in parallel.

> **The previous release epic (#104) and its nine `W1`–`W9` children are closed.** A
> "workstream" is not a unit this model has — `.pm-playbook/AGENT.md` is explicit that there
> are no Priority / Size / Workstream fields. It was also carrying a lot of drift: four of
> the nine workstreams were substantially done while tracked as untouched. #143 re-files
> only the work a 2026-08-07 revalidation confirmed is actually left.

### `v0.4.0` — performance residuals

Three issues: epic **#86** and its two open children, **#133** (`strsearch` short-needle
throughput) and **#91** (the boundary-boxed `Numeric` hybrid). Everything else under #86 has
shipped — see below.

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

## Still unscheduled

19 issues carry `idea` and no milestone. The ones worth naming:

| | What | Why it is not scheduled |
|---|---|---|
| #59 | The dynamic/recursive value model (`JsonValue`) | Gate 1 is not passed. It is a deliberate hole in the dialect's static premise, and the design has to say exactly how large that hole is. #134 is that design; #135–#137 are its dependents. |
| #118 | Plugin archetypes — mirror vs macro | D1 (#127, a Rust-authoritative oracle mode) blocks the other five. Without it there is no way to test a mirror plugin at all. |
| #79 | Verify-then-triage the "not covered" language surface | It exists because a list that says "not done" about things that are done is worse than no list: it aims effort at work that does not exist while hiding the work that does. A partial pass on 2026-08-07 confirmed the premise — of 22 rows probed, roughly half were already shipped. It should wait on #142, which restores the probe method it depends on. Its catalog counterpart, #138, is now scheduled under #157. |

## Not on the release spine

These feed the spine; they never ride it.

- **The `experiment` lane.** A spike's deliverable is a decision, not a feature. It gets
  no milestone, by invariant.
- **#61 — migrate `TypeOracle` to the tsgo v7 native checker.** Externally blocked: there
  is no v7 compiler API yet.
- **#25 — the Rust-AST + pretty-printer rewrite.** A structural improvement to how Rust is
  produced. Real, `idea`, and not a user-visible feature.

## See also

- [`WHAT_IT_IS.md`](WHAT_IT_IS.md) — per-feature guarantees and honest limits.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — the two-axis model, the ladder, and the gates.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the compiler is built, and why.
