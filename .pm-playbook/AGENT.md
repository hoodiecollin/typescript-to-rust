# pm-playbook — agent router

You are working in a repo that uses the **pm-playbook** model for issue tracking. This file is a
map, not the doctrine. Load only the section you need; `PLAYBOOK.md` in this directory is the
whole thing if you need it end to end.

## Read this much always

**All work is GitHub Issues, organized by exactly two orthogonal axes — and nothing else
decomposes work:**

| Axis | Mechanism | Answers |
|---|---|---|
| **When** | **Milestone** = a version release (the *release spine*) | Is this scheduled, and for which release? |
| **What kind / maturity** | **Labels** | What is this, and how committed are we? |

- Epics decompose via GitHub **native sub-issues** — not task-list checkboxes, not a Project field.
- The Project board is a **view** over issues, never a second source of truth.
- There are **no Priority / Size / Workstream fields**. Do not add or propose any.
- Code + git history is **ground truth**. A board card, a label, a roadmap doc, an RFC, a memory
  note — each is a *claim* about ground truth. When a claim disagrees with the code, the claim is
  wrong.

**The commitment ladder** (distance from shipped):

```
idea  →  plan-next  →  milestone assigned  →  merged/closed  →  GitHub Release
(speculative) (committed,   (scheduled;        (into the        (shipped;
              unscheduled)   drop plan-next)    milestone)       roadmap flips)
```

**Invariants — these are hard rules, and `pm-playbook check` fails on them:**

| Rule | Invariant |
|---|---|
| `PM001` | `plan-next` ⊕ milestone — assigning a milestone means dropping `plan-next` |
| `PM002` | `idea` ⊕ `plan-next` |
| `PM003` | `experiment` ⊕ {`idea`, `plan-next`, milestone} |
| `PM004` | `release-gate` ⇒ milestone |
| `PM005` | `release-gate` ⊕ {`idea`, `plan-next`, `experiment`} |
| `PM006` | non-core `surface:*` ⊕ core `v*` milestone |
| `PM008` | a PR to the integration branch never closes work milestoned past the cycle in flight |

Verify your work with `npx @hoodiecollin/pm-playbook check` before you finish. `--json` gives you the
violations with an executable fix on each.

## Read this when you are about to…

| If you are… | Read |
|---|---|
| deciding what axis something belongs on, or tempted to add a field | [`reference/01-two-axis-core.md`](reference/01-two-axis-core.md) |
| promoting work along the ladder, or asking whether something is "done" | [`reference/02-commitment-ladder.md`](reference/02-commitment-ladder.md) |
| choosing labels, or unsure what a label means | [`reference/03-labels.md`](reference/03-labels.md) |
| filing or milestoning a spike / benchmark / evaluation | [`reference/04-experiments.md`](reference/04-experiments.md) |
| scheduling into a version, preparing to tag, or **choosing a branch to target** | [`reference/05-release-spine.md`](reference/05-release-spine.md) |
| touching a repo that ships more than one artifact | [`reference/06-surfaces.md`](reference/06-surfaces.md) |
| creating an epic, or building anything that reads the roadmap | [`reference/07-epics-and-roadmap.md`](reference/07-epics-and-roadmap.md) |
| changing the Project board or its views | [`reference/08-board-is-a-view.md`](reference/08-board-is-a-view.md) |
| **about to write code** — check the gates first | [`reference/09-design-plan-spec.md`](reference/09-design-plan-spec.md) |
| writing or moving a design doc, roadmap doc, or RFC | [`reference/10-documentation.md`](reference/10-documentation.md) |
| deciding what to work on, or justifying a priority | [`reference/11-operating-disciplines.md`](reference/11-operating-disciplines.md) |
| setting this model up on another repo | [`reference/12-adopting.md`](reference/12-adopting.md) |
| reviewing someone's tracking changes | [`reference/13-anti-patterns.md`](reference/13-anti-patterns.md) |

## The five things agents get wrong here

1. **Leaving `plan-next` on when you assign a milestone.** The milestone *is* the schedule signal.
   Drop the label in the same action. This is the single most common violation.
2. **Milestoning an experiment.** A spike's deliverable is a *decision*, not a shippable artifact.
   It feeds the release spine; it never rides it. If its conclusion commits feature work, file
   *that feature* as its own issue and milestone that.
3. **Writing code before the gates.** Nothing gets coded until a design-doc (`rfc` issue: what and
   why) and then an implementation-plan (how) exist, in that order — then BDD specs RED → GREEN.
4. **Creating a `TODO.md` / `TASKS.md`.** The backlog lives in Issues. Ask "what's next" with
   `gh issue list --state open`, never a file. When you commit to work, `gh issue create` first.
5. **Justifying priority with demand.** Prioritize on engineering merit — scope, risk, foundational
   sequencing, identity fit. For a pre-launch product, "users want it" is data you do not have.
   Never estimate in time units, and never add effort labels.

## Useful queries

```bash
gh issue list --state open                        # the backlog (never a markdown file)
gh issue list --label plan-next                   # committed but unscheduled (milestone-free by invariant)
gh issue list --label release-gate --state open   # "can we tag?" — any row blocks its milestone
gh issue list --milestone vX.Y.Z --state open     # what is left in this release

npx @hoodiecollin/pm-playbook check --json                   # every violation, each with a fix
npx @hoodiecollin/pm-playbook release-check vX.Y.Z           # exit 1 if the milestone is gated or incomplete
npx @hoodiecollin/pm-playbook scope-check <pr>               # exit 1 if a PR lands next-cycle work on develop
```

## If this repo has an integration branch

There is exactly **one** integration branch, and its name never contains a version — `develop`
means "the cycle in flight," so it becomes the next cycle at tag time with no rename. Never create
`v0.5-develop` alongside `v0.4-develop`.

Work milestoned **past the cycle in flight** does not go on it. Put it on its own branch off the
integration branch, unmerged, carrying its real milestone; rebase after the release merge. The
cycle in flight is *derived* — the lowest open core `v*` milestone — so read it from the
milestones, never from a constant.
