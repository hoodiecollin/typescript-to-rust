# pm-playbook — agent router

You are working in a repo that uses the **pm-playbook** model for issue tracking. This file is a
map, not the doctrine. Load only the section you need; `PLAYBOOK.md` in this directory is the
whole thing if you need it end to end.

## Read this much always

**All work is GitHub Issues, organized by exactly two orthogonal axes — and nothing else
decomposes work:**

| Axis | Mechanism | Answers |
|---|---|---|
| **When** | **Milestone** = a version release (the *release spine*) | Are we committed to this, and for which release? |
| **What kind** | **Labels** | What kind of work is this? |

- **A milestone means COMMITTED.** *Focus* — the milestone being the cycle in flight — is what
  means scheduled. There is no label for "committed but unscheduled"; that is just a milestone that
  is not the current one.
- Epics decompose via GitHub **native sub-issues** — not task-list checkboxes, not a Project field.
- **Work items decompose into gates**, also native sub-issues. The tree is exactly three levels:
  epic → work item → gate. Nothing extends it.
- The Project board is a **view** over issues, never a second source of truth.
- There are **no Priority / Size / Workstream fields**. Do not add or propose any.
- Code + git history is **ground truth**. A board card, a label, a roadmap doc, a design gate, a
  memory note — each is a *claim* about ground truth. When a claim disagrees with the code, the
  claim is wrong.

**Three work types. Every work item carries exactly one**, and the type decides its gates:

| Type | Gates |
|---|---|
| `improvement` | design → plan → impl |
| `bugfix` | diagnose → fix (`hotfix` is a bounded, warranted form of this) |
| `experiment` | research → evaluate (never milestoned) |

Each gate is a **sub-issue** labelled `{type}:gate-{n}`. A closed gate means approved. Closing the
last gate closes the work item.

**The commitment ladder is DERIVED from gate state — there are no maturity labels.** Walk the
gates in order; the first one not closed decides: absent → `<verb>-next`, open → `<verb>-pending`.
So an improvement runs `idea → design-next → design-pending → plan-next → plan-pending → impl-next
→ impl-pending → closed-in-milestone → released`. Ask for it with `pm-playbook ladder`; do not try
to filter for it, because no GitHub filter can compute it.

**Invariants — these are hard rules, and `pm-playbook check` fails on them:**

| Rule | Invariant |
|---|---|
| `PM003` | `experiment` ⊕ milestone |
| `PM004` | `release-gate` ⇒ milestone |
| `PM005` | `release-gate` ⊕ `experiment` |
| `PM006` | non-core `surface:*` ⊕ core `v*` milestone |
| `PM008` | a PR to the integration branch never closes work milestoned past the cycle in flight |
| `PM010` | exactly one type label per work item |
| `PM011` | a gate's milestone equals its parent's |
| `PM012` | an `epic` never carries gates |
| `PM013` | a work item on the focused milestone carries its complete gate set |
| `PM014` | `hotfix` ⇒ `bugfix` + milestone, and ⊕ {`experiment`, `epic`} |
| `PM015` | a patch milestone holds one hotfix and its gates, nothing else |
| `PM016` | *(warn)* every gate closed but the work item still open |
| `PM105` | only an `epic` has non-gate sub-issues; only a work item has gates |

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
| **about to write code** — check the gates first | [`reference/09-gates.md`](reference/09-gates.md) |
| writing or moving a design doc or roadmap doc | [`reference/10-documentation.md`](reference/10-documentation.md) |
| deciding what to work on, or justifying a priority | [`reference/11-operating-disciplines.md`](reference/11-operating-disciplines.md) |
| setting this model up on another repo | [`reference/12-adopting.md`](reference/12-adopting.md) |
| reviewing someone's tracking changes | [`reference/13-anti-patterns.md`](reference/13-anti-patterns.md) |

## The five things agents get wrong here

1. **Filing an issue with no type label, or two.** Exactly one of `improvement` / `bugfix` /
   `experiment`, always. The type decides the gate set, so an ambiguous type makes "is this done?"
   unanswerable. This is the most common violation (PM010).
2. **Milestoning an experiment.** A spike's deliverable is a *finding*, not a shippable artifact.
   It feeds the release spine; it never rides it. If its verdict commits work, file *that work* as
   its own issue and milestone that.
3. **Writing code before the gates.** Gate 1 (what and why) then gate 2 (how), in that order, each
   closed before the next opens — then BDD specs RED → GREEN in gate 3.
3b. **Creating a gate by hand.** `pm-playbook materialize` owns them, and it creates a complete set
   at once. A hand-made gate destroys the only thing that makes an *absent* gate meaningful.
4. **Creating a `TODO.md` / `TASKS.md`.** The backlog lives in Issues. Ask "what's next" with
   `gh issue list --state open`, never a file. When you commit to work, `gh issue create` first.
5. **Justifying priority with demand.** Prioritize on engineering merit — scope, risk, foundational
   sequencing, identity fit. For a pre-launch product, "users want it" is data you do not have.
   Never estimate in time units, and never add effort labels.

## Read the local mirror, not one API call per question

If `.pm-playbook/backlog/` exists, **that is where you read the backlog.** `pull` materializes
every issue — body, comments, labels, milestone, parentage — into ordinary files you can grep,
open, and read in bulk. Answering "what is left in this release" or "what did we decide on #42"
from the mirror costs one `grep`; asking GitHub costs a round trip per issue, and reading twelve
issue bodies over the API is twelve of them.

```bash
npx @hoodiecollin/pm-playbook pull        # refresh the mirror (safe to re-run; overwrites from GitHub)
ls .pm-playbook/backlog/                  # no mirror yet? run pull, or query GitHub for a one-off
```

Three things to know before you rely on it:

- **It is gitignored and machine-local.** A fresh clone has no mirror until someone runs `pull`.
  Its absence means "not pulled here yet," never "no issues."
- **It goes stale the moment someone else moves an issue.** `pull` again when it matters; it is
  cheap and idempotent. `check --no-remote` lints the mirror and says so in its output.
- **Reading is local; WRITING is not.** Never hand-edit a file to change an issue's state and
  assume GitHub knows. Edit the mirror and reconcile with `push`, which refuses outright when both
  sides moved rather than picking a winner — or skip the mirror and use `gh` / the CLI directly.
  Creating, closing, labelling and milestoning all go through GitHub.

## Useful queries

```bash
# From the mirror — no network, and greppable in bulk.
rg -l 'label' .pm-playbook/backlog/       # anything, across every body and comment at once
cat .pm-playbook/backlog/standalone/42/body.md
npx @hoodiecollin/pm-playbook check --no-remote     # lint offline, same issue-level rules

# From GitHub — authoritative, one round trip each. Use when the mirror is absent or stale.
gh issue list --state open                        # the backlog (never a markdown file)
gh issue list --label release-gate --state open   # "can we tag?" — any row blocks its milestone
gh issue list --milestone vX.Y.Z --state open     # what is left in this release
gh issue list --label improvement:gate-1 --state open   # every design currently in progress

npx @hoodiecollin/pm-playbook pull                           # refresh the mirror from GitHub
npx @hoodiecollin/pm-playbook push                           # send local mirror edits back (previews first)
npx @hoodiecollin/pm-playbook ladder                         # the rung of every work item — no filter can do this
npx @hoodiecollin/pm-playbook materialize --yes              # gates for the cycle in flight (idempotent)
npx @hoodiecollin/pm-playbook materialize --issue <n> --yes  # an experiment's gates, by decision
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
cycle in flight is *derived* — the lowest open core `v*` milestone whose `major.minor` line has no
closed milestone on it — so read it from the milestones, never from a constant. The line clause is
what stops a patch milestone (`v1.2.1`, opened against a released version) from being mistaken for
the cycle and blocking everything.

**Closing keywords do not reach an issue merged into an integration branch.** GitHub honours
`Closes #<n>` only for PRs targeting the *default* branch, so a PR into `develop` leaves its issue
open however the body is written — close it yourself, and say what you verified.

**Check how this repo lands branches before you merge one.** If the merge button refuses a method,
that is a decision, not an obstacle to route around. Read `CONTRIBUTING.md`; where the choice is
merge commits, `--no-ff` is required, because a branch that is merely ahead fast-forwards and
loses its boundary exactly as a rebase would.
