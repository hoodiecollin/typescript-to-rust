# typescript-to-rust — agent entry point

## Where to look for "what to do next"

**GitHub Issues are the source of truth for the backlog.** Repo:
`hoodiecollin/typescript-to-rust` (public).

```
gh issue list                       # the whole backlog
gh issue list --label epic          # the big themes
gh issue list --milestone v0.1.0    # what is committed to a release
gh issue list --label improvement:gate-1 --state open   # designs in progress
gh issue view <n>                   # the design and the plan live in the gate sub-issues
bunx @hoodiecollin/pm-playbook ladder   # the derived rung — no filter can compute it
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
## Project management — pm-playbook v2.3.0

Issue tracking in this repo follows the **pm-playbook** two-axis model. The full doctrine is
vendored at `.pm-playbook/` and is authoritative; this block is only a summary.

**Before you create, label, milestone, or close an issue — read `.pm-playbook/AGENT.md`.**
It is a short router: load only the reference section relevant to what you are doing.

**The two axes, and nothing else, organize work:**
- **Milestone** = *when*. Assigning one means **committed**. *Focus* — the milestone being the
  cycle in flight — is what means scheduled. There is no label for "committed but unscheduled."
- **Labels** = *what kind*. Epics decompose via **native sub-issues**, never checkboxes and never
  a Project field.
- There are **no Priority / Size / Workstream fields**. Do not propose adding any.

**Every work item carries exactly one type, and the type decides its gates:**

| Type | Gates |
|---|---|
| `improvement` | design → plan → impl |
| `bugfix` | diagnose → fix (`hotfix` is a bounded form of this) |
| `experiment` | research → evaluate (never milestoned) |

Each gate is a sub-issue labelled `{type}:gate-{n}`. A closed gate means approved. The tree is
exactly three levels: epic → work item → gate.

**The commitment ladder is DERIVED from gate state — there are no maturity labels.** Walk the
gates in order; the first not closed decides the rung. Ask for it with `pm-playbook ladder`; no
GitHub filter can compute it.

**Invariants — violating one is a bug, not a style preference:**
- Exactly **one** type label per work item — never zero, never two (PM010). An `epic`, a gate and
  a `release-gate` are not work items for this purpose and need no type.
- `experiment` never carries a milestone. A spike's deliverable is a finding; it feeds the
  release spine, it never rides it (PM003).
- **Never create a gate by hand** — `pm-playbook materialize` owns them and creates a complete
  set at once. A hand-made gate destroys the meaning of an absent one.
- A gate's milestone equals its parent's (PM011); an `epic` never carries gates (PM012).
- `release-gate` always has a milestone and never carries `experiment`. An open `release-gate`
  means its milestone **cannot be tagged** (PM004/PM005).
- A non-core `surface:*` issue never rides a core `v*` milestone (PM006).

**Read the backlog from the local mirror when it exists.** `.pm-playbook/backlog/` holds every
issue body and comment as files — grep it instead of spending an API round trip per question. It is
gitignored and machine-local, so its absence means "not pulled here yet", never "no issues", and it
goes stale as soon as anyone else moves an issue. Reading is local; **writing is not** — edit and
`push` (it refuses when both sides moved), or use `gh` directly.

```bash
npx @hoodiecollin/pm-playbook pull     # refresh the mirror (idempotent)
npx @hoodiecollin/pm-playbook check    # verify before opening a PR — exit 0 means compliant
```
<!-- pm-playbook:end -->
