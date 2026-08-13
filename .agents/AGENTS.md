# Custom Rules

## The backlog lives in GitHub Issues

"What to do next" is `gh issue list` on `hoodiecollin/typescript-to-rust`. Nothing in
`docs/` is a todo list — it holds durable references only. The label
taxonomy is the pm-playbook one — see the block at the bottom of the root `CLAUDE.md`.
**The issue body carries the design (Gate 1) and the implementation-plan (Gate 2).**
Whether a design exists is read off the issue, not off a label.

## Get Collin's input before designing dialect-shape work

Many "graduate a fail-loud deferral" issues are **dialect-semantics decisions, not
mechanical work** — how nullability, inheritance, error enums, module boundaries, etc.
map onto Rust. For these: investigate, draft the **options with tradeoffs**, then
**pause and ask Collin for a decision before writing the final design or any
implementation.** A wrong guess ripples through the validator, HIR, and emitter and
is expensive to unwind. Purely mechanical slices (no new dialect surface, no
semantics choice) can proceed straight through the spec-first flow below.

## Development Flow: TDD against the verification oracle

This project uses strict **Test-Driven Development**, but the test oracle is a
**real Rust toolchain**, not hand-written golden strings. Never assert emitted
Rust by string-equality against a `.rs` file (that approach was removed — it was
brittle and shipped invalid Rust). Instead:

1. **RED** — add or enable a fixture (`packages/compiler/tests/fixtures/**`, a
   `.ts` input) or a differential program, and watch it fail:
   - tier 1 (COMPILES): `cargo check` on the emitted Rust must currently fail or
     the emitter must throw `UnsupportedError`;
   - tier 2 (BEHAVES): TS-run-via-Bun and Rust-run output must differ / not run.
2. **GREEN** — implement the emitter/analysis until `cargo` accepts the output
   and (for complete programs) the differential stdout matches.

Use the harness (`src/harness`): `checkRust`, `runRust`, `formatRust`. The
emitter must always produce a **complete, compilable module** and must **fail
loudly** (`UnsupportedError`) on anything outside the dialect — never silently
emit `Any` or commented-out stubs.

## The spec-first workflow (required for every change)

Every change goes through the gates, in series (see `.pm-playbook/reference/09-gates.md`
and `docs/CONTRIBUTING.md`). Gates are **native sub-issues** of the work item, created
by `pm-playbook materialize` as a complete set — **never by hand**. An `improvement`
takes three; a `bugfix` takes two (diagnose → fix). **Closing a gate means accepted.**

1. **Gate 1 — design (WHAT & WHY).** Problem, desired behavior, solution *shape*,
   alternatives, explicit non-goals. **On the gate sub-issue** — never a committed
   `design.md`.
2. **Gate 2 — plan (HOW).** Files to touch, build order, blockers, interfaces, **and
   the BDD scenarios to write**. Also on its gate sub-issue. This is where the old
   `specs.md` content goes.
3. **Gate 3 — RED → GREEN.**
   - **Mock** — a mock interface of what the real impl will supersede.
   - **RED specs** — transcribe the planned scenarios into real BDD tests that call
     the mock; verify every new spec **fails** before implementing. (Tests must
     exercise the interface, so they genuinely signal when the spec is met — never
     fake-green.)
   - **GREEN** — implement until all specs pass; refactor under green.

Two scope carve-outs (decided 2026-07-02, still in force):
- **Pure refactors** (behavior-preserving, covered by existing green tests) need
  Gate 1 **only** — no new specs, no mock/RED steps.
- **Pre-rule code** gets characterization specs backfilled **GREEN-from-start**,
  honestly labeled (a truly-RED spec is impossible against working impl).

**If you reopen an accepted gate, purge the issue body first** and replace it with the
withdrawal placeholder (§9.1). A superseded design left in a body does not read as
superseded — it reads as *the* design, and the next planner builds on it.

## No barrel files

No re-export barrels — they hide the dependency graph and rot. Default to a flat
`<module-name>.ts`. Promote to a folder (`<name>/index.ts`) only when the single
file grows too large, and then `index.ts` must hold **real functionality**, not
re-exports. Outside files may import a folder's siblings directly (e.g.
`./harness/cargo` for types/constants) — that's preferred over a barrel.

## Run everything from the repo root

- `bun run test` — compiler tests (cargo-backed).
- `bun run typecheck` — `tsc --noEmit` on the compiler.
- `bun run rust:test` — `ts-primitives` unit tests.
- `bun run check` — typecheck + rust tests + compiler tests.
- `bun run ttr <file.ts> [--check|--run]` — compile a file to Rust.

## Memory model is decided: Option A (idiomatic borrows)

See `docs/ARCHITECTURE.md`. Emit plain Rust ownership; `Rc<RefCell<T>>` is a last
resort, not the strategy. Keep `ts-primitives` minimal.

<!-- pm-playbook:begin -->
## Project management — pm-playbook v1.2.0

Issue tracking in this repo follows the **pm-playbook** two-axis model. The full doctrine is
vendored at `.pm-playbook/` and is authoritative; this block is only a summary.

**Before you create, label, milestone, or close an issue — read `.pm-playbook/AGENT.md`.**
It is a short router: load only the reference section relevant to what you are doing.

**The two axes, and nothing else, organize work:**
- **Milestone** = *when*. Assigning one means **committed**; being the cycle in flight is what
  means *scheduled*. There is no label for "committed but unscheduled."
- **Labels** = *what kind*. Epics decompose via **native sub-issues**, never checkboxes and never
  a Project field.
- There are **no Priority / Size / Workstream fields**. Do not propose adding any.
- Every work item carries exactly one of `improvement` / `bugfix` / `experiment`, and the type
  decides its gate set. The commitment ladder is **derived** from gate state — ask
  `pm-playbook ladder`, since no filter can compute it.

**Invariants — violating one is a bug, not a style preference:**
- Exactly **one** type label per work item — never zero, never two (PM010).
- `experiment` never carries a milestone. A spike's deliverable is a decision; it feeds the
  release spine, it never rides it (PM003).
- **Never create a gate by hand** — `materialize` owns them, and a hand-made gate destroys the
  meaning of an absent one.
- A gate's milestone equals its parent's (PM011); an `epic` never carries gates (PM012).
- `release-gate` always has a milestone and never carries `experiment` (PM004/PM005).
  An open `release-gate` means its milestone **cannot be tagged**.
- A non-core `surface:*` issue never rides a core `v*` milestone (PM006).

**Verify before opening a PR** — exit code 0 means compliant:

```bash
npx @hoodiecollin/pm-playbook check
```
<!-- pm-playbook:end -->
