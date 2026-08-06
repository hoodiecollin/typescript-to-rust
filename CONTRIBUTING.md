# Contributing to `ttr`

Contributions are welcome. This document is the system: how work is tracked, how a
change gets designed and shipped, and what has to be green before a PR.

Two things carry more weight here than in most projects, so they are stated first:

1. **The oracle is a real `cargo` toolchain.** Emitted Rust is judged by whether it
   compiles and runs, never by string-matching against a golden `.rs` file. You need
   Rust installed ([rustup](https://rustup.rs)) to run the tests at all.
2. **Anything touching the accepted dialect surface or the memory model needs a
   decision before it needs code.** See [Dialect-shape work](#dialect-shape-work).

## Where the backlog lives

**GitHub Issues, and only GitHub Issues.** There is no `TODO.md`, no roadmap file that
schedules work, and `docs/plan.md`'s "Status" section is a *historical* log, not a
to-do list.

```bash
gh issue list                     # the whole backlog
gh issue list --label epic        # the big themes
gh issue list --label plan-next   # committed, not yet scheduled to a version
gh issue list --label idea        # speculative — needs a design first
gh issue list --label rfc         # designs awaiting acceptance
gh issue view <n>                 # the design and the plan live in the issue body
```

## The two axes

Work is organized by exactly two things. This repo follows the
[pm-playbook](.pm-playbook/PLAYBOOK.md) doctrine, vendored at `.pm-playbook/`, which is
authoritative wherever this file is less specific.

- **Milestone = *when*.** A version (`v0.1.0`, `v0.2.0`, `v0.3.0`). Assigning one means
  the work is *scheduled*. This is the release spine.
- **Labels = *what kind*, and *how committed*.**

There are **no Priority, Size, Workstream, or status fields**, and adding one is not an
improvement to propose — a third axis is how a tracker stops describing reality. In
particular, the labels `has-design`, `needs-design`, `needs-user-input`,
`deferral-graduation` and the old per-area tags **were deleted from this repo**. Design
state is *derived* from whether an accepted design exists on the issue; a label that has
to be applied by hand is one that gets forgotten on exactly the issue that needed it.
Subsystem grouping is not a label either — it is the epic an issue is a sub-issue of.

### The commitment ladder

```
idea  →  plan-next  →  milestone assigned  →  closed  →  GitHub Release
        (committed,      (scheduled;         (merged)
       not scheduled)  plan-next dropped)
```

| Label | Means |
|---|---|
| `idea` | Speculative. Not committed. Needs a design before anything else. |
| `plan-next` | Committed, not yet scheduled to a version. |
| `rfc` | A design awaiting acceptance. **Design docs are issues, never committed files.** |
| `epic` | A theme. Decomposes into **native sub-issues** — see below. |
| `experiment` | A timeboxed spike whose deliverable is a *decision*, not a feature. |
| `tech-debt`, `perf`, `bug`, `documentation` | What kind of work it is. |
| `release-gate` | Blocks tagging its milestone. Always has a milestone. |

### Invariants

Violating one of these is a bug, not a style preference. `bunx @hoodiecollin/pm-playbook check`
enforces them and must exit 0 before you open a PR.

- `plan-next` and a milestone never coexist — assigning a milestone means dropping `plan-next`.
- `idea` and `plan-next` never coexist.
- `experiment` never carries `idea`, `plan-next`, or a milestone. A spike feeds the release
  spine; it never rides it.
- `release-gate` always has a milestone and never carries `idea` / `plan-next` / `experiment`.
  An open `release-gate` means its milestone **cannot be tagged**.
- **An epic decomposes via native sub-issues** — the GitHub Sub-issues panel — never via a
  checkbox list in the body, and never via a Project field. A checklist is a second,
  hand-maintained copy of the panel, and the two drift.

```bash
# link an existing issue as a child of an epic
id=$(gh api repos/hoodiecollin/typescript-to-rust/issues/<child> --jq .id)
gh api repos/hoodiecollin/typescript-to-rust/issues/<epic>/sub_issues -F sub_issue_id=$id
```

## Design → plan → spec

Every change goes through three gates, in series. The full statement is in
[`.pm-playbook/reference/09-design-plan-spec.md`](.pm-playbook/reference/09-design-plan-spec.md);
this is the repo-shaped version.

### Gate 1 — design (WHAT and WHY)

Problem, desired behavior, the *shape* of the solution, the alternatives considered, and
explicit non-goals.

**It lives on the issue.** A new proposal is an `rfc` issue; work already tracked by an
issue gets a design section in that issue's body. It is **never** a committed `design.md`
— a document in the tree is invisible to `gh issue list`, and it gives you two
identifiers for one piece of work that someone has to keep in sync by hand. The
`docs/work/` series folders that used to hold designs are a
[frozen archive](docs/work/README.md).

Accepted → drop `idea`, add `plan-next`.

**If you reopen an accepted gate, purge the issue body first** and replace it with the
withdrawal placeholder. A superseded design left in place does not *read* as superseded —
it reads as *the* design, and the next person plans against it.

### Gate 2 — implementation-plan (HOW)

Files to touch, build order, blockers, interfaces, **and the BDD scenarios you are going
to write**. Same issue, below the design. There is an
[implementation-plan issue template](.github/ISSUE_TEMPLATE/implementation-plan.md).

### Gate 3 — RED → GREEN

- **Mock** — a mock interface of whatever the real implementation will supersede.
- **RED** — transcribe the planned scenarios into real tests and watch every new one
  **fail** before implementing. A test must exercise the interface, so that it genuinely
  signals when the spec is met. Never fake-green.
- **GREEN** — implement until the specs pass; refactor under green.

Against this compiler, RED and GREEN have concrete meanings:

- **Tier 1 (COMPILES)** — `cargo check` on the emitted Rust must currently fail, or the
  emitter must throw `UnsupportedError`.
- **Tier 2 (BEHAVES)** — the TypeScript run via Bun and the emitted Rust run via
  `cargo run` must currently *differ* (or not run at all).

Use the harness in `packages/compiler/src/harness` (`checkRust`, `runRust`, `formatRust`).
The emitter must always produce a **complete, compilable module**, and must **fail loudly**
(`UnsupportedError`) on anything outside the dialect — never silently emit `Any` or a
commented-out stub.

**Two carve-outs**, both still in force:

- **Pure refactors** — behavior-preserving and already covered by green tests — need
  Gate 1 only. No new specs, no mock/RED step.
- **Pre-rule code** gets characterization specs backfilled GREEN-from-start, labeled
  honestly as such. A truly-RED spec against a working implementation is not possible,
  and pretending otherwise is worse than saying so.

## Dialect-shape work

Many issues that look like mechanical "graduate a fail-loud deferral" work are actually
**dialect-semantics decisions**: how nullability, inheritance, error enums, module
boundaries, or the numeric model map onto Rust.

For anything touching the accepted dialect surface or the memory model:

1. Do the investigation and draft the design **options, with tradeoffs**, then
2. **stop and get a decision from the maintainer** before writing the final design or any
   implementation.

Do not silently pick a direction and build it. A wrong guess here ripples through the
validator, the HIR and the emitter, and is expensive to unwind. Purely mechanical slices —
no new dialect surface, no semantics choice — go straight through the three gates.

This is a standing rule about a *kind of work*, not a per-issue flag. It used to be carried
by a `needs-user-input` label; the label is gone precisely because it depended on someone
remembering to attach it.

## Running things

Everything runs from the repo root. Never `cd` into a package.

```bash
bun install
bun run ttr <file.ts> [--fmt|--emit|--check|--run]   # compile a file to Rust
bun run test          # compiler tests (cargo-backed) — the oracle
bun run test:changed  # only the suites affected by your diff
bun run typecheck     # tsc --noEmit over the compiler and benchmarks
bun run rust:test     # cargo test over the workspace crates
bun run lint          # biome
bun run bench         # Node vs Bun vs ttr over the shared corpus
```

**The one gate before a PR:**

```bash
bun run check                       # lint + typecheck + rust:test + test
bunx @hoodiecollin/pm-playbook check   # the issue-tracker invariants
```

CI runs the same things: `ci.yml` owns lint/typecheck/unit tests per PR, `oracle.yml`
runs the cargo-backed differential suite on `v*`, and `playbook.yml` gates the backlog.

## Code conventions

- **No barrel files.** No re-export-only modules — they hide the dependency graph and
  rot. Default to a flat `<module-name>.ts`; promote to `<name>/index.ts` only when one
  file gets too large, and then `index.ts` must hold real functionality. Importing a
  folder's siblings directly (`./harness/cargo`) is preferred over a barrel.
- **Fail loud.** Outside the dialect is `DialectError` (permanent — fix the input) or
  `UnsupportedError` (a deferral — not built yet). The error *message string* is the
  stable anchor that `docs/dialect.md` quotes; line numbers drift, messages don't.
- **The emitter is pure and total.** Analysis and rejection happen in lowering. The
  emitter carries exactly one defensive throw, and it is an invariant guard, not a
  feature boundary.
- **Keep `ts-primitives` minimal.** `Rc<RefCell<T>>` is a local last resort, not the
  strategy. The memory model is decided: idiomatic borrows (`docs/plan.md`).

## Where to read next

| Document | What it is |
|---|---|
| [`docs/dialect.md`](docs/dialect.md) | The accepted TypeScript subset and its Rust mapping — authoritative |
| [`docs/architecture.md`](docs/architecture.md) | Pipeline, oracle harness, emitter invariants |
| [`docs/plan.md`](docs/plan.md) | Goal, memory-model decision, and the shipped-work log |
| [`WHAT_IT_IS.md`](WHAT_IT_IS.md) | Per-feature guarantees *and* honest limits |
| [`VERSION_ROADMAP.md`](VERSION_ROADMAP.md) | The honest state of the current release effort |
| [`.agents/AGENTS.md`](.agents/AGENTS.md) | The same rules, condensed for coding agents |

## License

By contributing you agree that your contribution is dual-licensed under
[Apache-2.0](LICENSE-APACHE) and [MIT](LICENSE-MIT), at the user's option, per the
statement in the README.
