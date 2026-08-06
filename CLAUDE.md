# typescript-to-rust — agent entry point

## Where to look for "what to do next"

**GitHub Issues are the source of truth for the backlog.** Repo:
`hoodiecollin/typescript-to-rust` (public).

```
gh issue list                       # the whole backlog
gh issue list --label epic          # the big themes
gh issue list --label plan-next     # committed, not yet scheduled to a version
gh issue list --label idea          # speculative — needs a design first
gh issue list --label rfc           # designs awaiting acceptance
gh issue view <n>                   # the design and the plan live in the issue body
```

There is no todo list in the tree. `docs/` holds durable references only.

Labels are the ones in the pm-playbook taxonomy (see the block at the bottom of this
file) and nothing else. **`has-design`, `needs-design`, `needs-user-input`,
`deferral-graduation` and the area tags no longer exist** — they were deleted from the
repo, and the first three are banned by the model: design state is *derived* from whether
an accepted design exists on the issue, not stickered onto it by someone who has to
remember to update the sticker. Subsystem grouping is not a label either; it is the epic
an issue is a sub-issue of.

## Process rule: get Collin's input before designing dialect-shape work

**Many "graduate a fail-loud deferral" items are dialect-shape decisions, not mechanical
work** — how nullability, inheritance, error enums or module boundaries map onto Rust.
For anything touching the accepted dialect surface or the memory model:

1. Do the investigation and draft the design **options**, then
2. **pause and ask Collin** — surface the tradeoffs and get a decision — **before**
   writing the final design or any impl.

Do not silently pick a dialect/semantics direction and build it. A wrong guess here is
expensive to unwind because it ripples through the validator, HIR, and emitter.

This rule used to be carried by a `needs-user-input` label. It is a **standing rule about
a kind of work**, not a per-issue flag, which is why it lives here instead: a label that
must be applied by hand is one that gets forgotten on exactly the issue that needed it.

## The rest

- **Process / workflow (spec-first BDD, oracle-driven TDD, no-barrel-files):**
  `.agents/AGENTS.md`.
- **Architecture, the pass pipeline, and the memory-model decision:**
  `docs/ARCHITECTURE.md`. The accepted input dialect: `docs/DIALECT.md`.
- **Design + implementation-plan:** on the issue (Gates 1 and 2). The numbered
  `docs/work/<NNN>/` series folders this repo used to keep are **deleted** — their
  durable content was distilled into `docs/ARCHITECTURE.md` and git history holds the
  rest. Do not recreate them.
- Run everything from the repo root (`bun run check`, `bun run test`,
  `bun run typecheck`).

<!-- pm-playbook:begin -->
## Project management — pm-playbook v1.1.0

Issue tracking in this repo follows the **pm-playbook** two-axis model. The full doctrine is
vendored at `.pm-playbook/` and is authoritative; this block is only a summary.

**Before you create, label, milestone, or close an issue — read `.pm-playbook/AGENT.md`.**
It is a short router: load only the reference section relevant to what you are doing.

**The two axes, and nothing else, organize work:**
- **Milestone** = *when* (a version release — the release spine). Assigning one means "scheduled."
- **Labels** = *what kind / how committed*. Epics decompose via **native sub-issues**, never
  checkboxes and never a Project field.
- There are **no Priority / Size / Workstream fields**. Do not propose adding any.

**Invariants — violating one is a bug, not a style preference:**
- `plan-next` and a milestone never coexist. Assigning a milestone means dropping `plan-next`.
- `idea` and `plan-next` never coexist.
- `experiment` never carries `idea`, `plan-next`, or a milestone. A spike's deliverable is a
  decision; it feeds the release spine, it never rides it.
- `release-gate` always has a milestone, and never carries `idea` / `plan-next` / `experiment`.
  An open `release-gate` means its milestone **cannot be tagged**.
- A non-core `surface:*` issue never rides a core `v*` milestone.

**Verify before opening a PR** — exit code 0 means compliant:

```bash
npx @hoodiecollin/pm-playbook check
```
<!-- pm-playbook:end -->
