# Roadmap Playbook — the ForgeDB project-management model, generalized

The canonical, portable version of the project-management approach worked out on **ForgeDB**.
Any repo can adopt it. It is a *system*, not a board: GitHub **Issues** are the backlog, a small
**label** vocabulary and **milestones** are the only two axes that organize them, and a
**documentation discipline** keeps every claim honest.

> **The rule:** code + git history is *ground truth*. Every other artifact — a board card, a
> label, a roadmap doc, a design gate, a memory note — is a *claim* about ground truth and must point
> back to it. When a claim disagrees with the code, the claim is wrong.

---

## 1. The two-axis core (the whole model)

**All work is GitHub Issues, organized by exactly two orthogonal axes — and nothing else
decomposes work:**

| Axis | Mechanism | Answers |
|---|---|---|
| **When** | **Milestone** = a version release (the *release spine*, §5) | *Are we committed to this, and for which release?* |
| **What kind** | **Labels** (§3) | *What kind of work is this?* |

Plus two structural mechanisms and one hard rule:

- **Epics decompose via GitHub *native sub-issues*** (§7) — the real `Parent issue` /
  `Sub-issues progress` link, **not** task-list checkboxes and **not** a Project field.
- **Work items decompose into *gates*, also native sub-issues** (§9). The tree is exactly three
  levels deep — epic → work item → gate — and nothing extends it.
- **The Project board is a *view* over issues, never a second source of truth** (§8).

#### A milestone means COMMITTED. *Focus* means scheduled.

This is the one piece of vocabulary worth getting right before anything else, because everything
downstream reads it.

Assigning a milestone says **we are committed to shipping this, in that release**. It does not say
work starts now — §5's spine is a forward queue of open milestones (`v0.4.0 → v0.7.0`), so parking
something three releases out is a real and useful thing to say.

What means *scheduled* is **focus**: the milestone being **the cycle in flight** (§5.3), which is
derived and advances on its own at every release. So "committed but unscheduled" is not a state
anybody has to track — it is simply a milestone that is not the current one.

Earlier versions of this model made the milestone mean *scheduled* and used a `plan-next` label for
*committed but unscheduled*. That label was the model's single most common source of drift, because
it had to be removed by hand at exactly the moment someone was busy doing something else.

**There are no `Priority`, `Size`, or `Workstream`/`Area` custom fields.** Earlier versions of
this model (and the ForgeDB board itself, until 2026-07-30) carried them; they were **deleted**.
They created a parallel decomposition scheme — a second source of truth that drifts — and tempted
work to be sliced by a guessed number instead of by *when it ships* and *what it is*. If you are
migrating a board that has them, **remove the fields and any view that depends on them** (§8).

Why so spartan: two axes you can read off an issue at a glance, with mechanical rules between
them, beat a rich field matrix nobody keeps current. Everything downstream — the roadmap page,
the changelog, "what do I do next" — is *derived* from these two axes, not tracked separately.

---

## 2. The commitment ladder — derived, never labelled

Work is ranked by *distance from shipped*. That ranking is **computed from structure**: from
whether the item has a milestone, and from which of its gates (§9) exist and are closed.

**Nothing on this ladder is a label, and that is the whole point.** A status label is a claim a
human has to remember to update; the artifact's existence is a fact. Deriving the rung removes the
drift rather than detecting it — there is no second copy to disagree with the first.

### One rule generates every rung

> **Walk the work item's gates in order. The first gate that is not closed decides the answer:
> absent means `<verb>-next`, open means `<verb>-pending`. All gates closed means the work item
> should close.**

Each work type supplies only its verbs, so the whole ladder is one table:

| Type | gate 1 | gate 2 | gate 3 | Before any gate exists |
|---|---|---|---|---|
| `improvement` | design | plan | impl | `idea` (no milestone) · `design-next` (milestone) |
| `bugfix` | diagnose | fix | — | `triage-next` (no milestone) · `diagnose-next` (milestone) |
| `experiment` | research | evaluate | — | `research-next` — an experiment with no gates is *not started* |

So an `improvement` runs `idea → design-next → design-pending → plan-next → plan-pending →
impl-next → impl-pending → closed`, and the rung is a query rather than a reading exercise. Ask for
it with `pm-playbook ladder`.

Two states sit past the last gate and are worth naming separately:

| Rung | Means | What moves it on |
|---|---|---|
| **`impl-pending`** *(or `fix-pending`)* | In flight — being built. | Close the last gate; the PR closes both it and the work item. |
| **Closed-in-milestone** | Done in code, but the roadmap reads *"pending release"*. | **Tag the GitHub Release** for the milestone. |
| **Released** | Shipped reality. | — |

Copy this framing into every milestone description:

> *"Issues close into this milestone until it is tagged; on the roadmap they read as 'pending
> release' until the vX.Y.Z GitHub Release exists."*

**Why the last two rungs stay distinct:** "done" is ambiguous. Splitting *code-complete* (issue
closed) from *shipped* (release tagged) is what keeps the roadmap from over-promising. Nothing an
issue carries can prove a tag exists, so derivation honestly stops at closed-in-milestone.

**One caution.** Milestone progress now counts **gates cleared, not work shipped** — nine of twelve
gates closed with no work item closed renders as 75% while nothing is shippable. That is intended:
it is a genuine measure of progress through the work. It is not a measure of what a user can
install, and §5's release spine remains the only thing that answers that.

---

## 3. Labels — the "what" axis

Labels are **self-documenting**: each label's *description* is the process. The bootstrap script
writes these descriptions for you.

### 3.1 The taxonomy (portable verbatim)

**Every work item carries exactly one of three type labels.** The type decides which gates it
takes, and therefore what its ladder rungs are called.

| Label | Color | Description (this text is the process) |
|---|---|---|
| `improvement` | `#0e8a16` | Work that makes the product better: features, refactors, performance, debt. Three gates: design → plan → impl. |
| `bugfix` | `#d73a4a` | A defect in behavior that already exists. Two gates: diagnose → fix. |
| `experiment` | `#a2eeef` | Work whose deliverable is a finding, not a shippable artifact. Two gates: research → evaluate. Never milestoned (§4). |

Then one modifier, one container, one release marker:

| Label | Color | Description |
|---|---|---|
| `hotfix` | `#b60205` | A bugfix in released behavior that cannot wait: bounded, warranted, on its own patch milestone (§5.6). Never alone — always with `bugfix`. |
| `epic` | `#6f42c1` | Umbrella tracking issue; decomposes via native sub-issues. Not a work type, and never carries gates of its own. |
| `release-gate` | `#b60205` | Blocks the tag: this milestone cannot be released until it is closed (§5.2). |

And **seven gate labels**, one per gate per type — `improvement:gate-1..3`, `bugfix:gate-1..2`,
`experiment:gate-1..2`. Their descriptions are in §9, because the description *is* the gate.

**Why the gate labels are type-prefixed** rather than a shared `gate-1`/`gate-2`/`gate-3` set: §3.1
makes the description the process, and `experiment:gate-2` ("the verdict…") and
`improvement:gate-2` ("the implementation plan…") describe genuinely different work. A shared label
could only carry one of those descriptions, so it would have to carry none.

#### What is deliberately absent

**No descriptor labels.** There is no `tech-debt`, `perf`, `config` or `legacy-audit`. All four
described *flavour*, which is what the body is for — and with one mandatory type label, a second
label saying "…and it is a perf one" re-creates the parallel-decomposition drift §13 exists to
prevent, on the axis most likely to be left stale.

**No maturity labels.** `idea` and `plan-next` are derived rungs now (§2), not labels. `rfc` is
gone entirely: the concept it named is gate 1, and it never described how it was used anyway —
there was no wider audience to request comment from.

**No stock GitHub labels.** `bug`, `documentation`, `enhancement`, `good first issue`, `help
wanted`, `question`, `duplicate`, `invalid` and `wontfix` are all removed on adoption. `bug` and the
two enhancement-shaped ones are merged onto their successors; the rest have GitHub-native
replacements — "closed as not planned" says what `wontfix` said, in the place a reader looks.

**No priority, severity, size, or effort.** §1's no-extra-fields rule, unchanged. Effort labels in
particular are banned: effort is not reliably knowable and a guess mis-steers scoping.

The **`surface:*`** delivery labels (§6) are the one open-ended set, because they name a repo's
actual shippable artifacts.

### 3.2 Label invariants (the integrity rules)

These keep the two axes clean and the derived views trivial. **Enforce them on every issue** —
`pm-playbook check` does, and each rule id below is what it reports.

- **Exactly one type label per work item** (PM010). Not zero, not two. An epic is a container
  rather than work, a gate takes its type from its own label, and a `release-gate` is a release
  *obligation* rather than work with a design→plan→impl arc, so none of the three needs one. A
  `release-gate` may carry a type anyway; it is simply not required to, and PM013 never asks one
  for a gate set it could not fill.
- **`experiment` ⊕ milestone** (PM003). A spike feeds the spine; it never rides it (§4).
- **`release-gate` ⇒ milestone** (PM004), and **`release-gate` ⊕ `experiment`** (PM005). A gate
  blocks a *specific* tag, so it is meaningless without the milestone it blocks — and it is
  committed by definition, which a spike can never be. **An open `release-gate` on a milestone
  means that milestone cannot be tagged**, regardless of whether every feature on it is closed
  (§5.2).
- **`hotfix` ⇒ `bugfix` + a milestone, and `hotfix` ⊕ {`experiment`, `epic`}** (PM014). A hotfix is
  a *form* of bugfix, not a fourth type (§5.6).
- **A patch milestone holds one hotfix, its gates, and any `release-gate` — no other work** (PM015).
  A `release-gate` is a release obligation rather than work, so it was never what "nothing else"
  excluded; §5.6 says where a patch's asset ledger lives.

The structural rules live with the structures they govern: gate parentage and completeness in §9,
epic decomposition in §7.1.

---

## 4. Experiments never ride the release spine

**A milestone ships things a user installs.** An `experiment`'s deliverable is a **finding**, not a
shippable artifact. So:

- An `experiment` is **never** placed on a `v*` milestone. Experiments run as an **unscheduled
  research track**, parallel to the spine.
- The finding may **commit new work** — and *that* work, not the spike, gets a milestone.
- **Never anchor a milestone's theme on an experiment's hoped-for outcome.** You cannot schedule a
  feature whose existence the experiment has not yet decided. (The real error this corrected: a
  storage-model experiment proposed as a release *anchor* — wrong; it *feeds* the release, it is
  not *on* it.)

**The discipline test:** if the primary output is a measurement, evaluation or verdict, it is an
`experiment`. If it is shippable code that ships regardless of any measurement, it is an
`improvement`.

### 4.1 The research lifecycle

An experiment takes two gates, and each has a job the other cannot do.

**Gate 1 — research (the charter).** Written *before* any work, and it must state:

- **The question, phrased so that "no" is a real possible answer.** A question that can only come
  back yes is not research, it is a plan wearing a costume.
- **The decision it informs.** An experiment whose answer changes nothing is not worth running.
- **The method, and what "fair" means for it.** The measurement has to be apples-to-apples — match
  durability and transaction semantics across anything you benchmark — because a verdict from an
  unfair comparison is worse than no verdict.
- **The scope bound**: how far this goes before it stops and reports. Expressed in *work* — files,
  cases, candidate libraries — never in time units, which §13 forbids.
- **The disposal of any code produced.**

**Gate 2 — evaluate (the verdict).** What was done, the answer, its **limits**, and exactly one
disposition: it **commits** work (link the issues filed), it **kills** it (link what was closed as
not planned), or it is **inconclusive** (say what would decide it). A verdict is required to close
the experiment, because the verdict *is* the deliverable.

Stating the limits is not politeness. A finding used beyond what it establishes is how a fair
measurement turns into a wrong decision two releases later.

### 4.2 POC code never merges

Proof-of-concept code lives on **`spike/<issue>-<slug>`** and that branch is **deleted at verdict**.

It may be as ugly as it needs to be, and it **must not be reviewed as production code** — review
pressure on a spike is how a spike quietly becomes a feature nobody designed.

If the code turns out to be worth keeping, that is a verdict that *commits work*, and the work takes
its own gates. Nothing is lost: the spike branch is still in the reflog, and rewriting it under a
real design is cheaper than living with an undesigned one.

**This gives the ladder an on-ramp:** experiment → verdict → a new work item's gate 1.

---

## 5. Milestones = the release spine (the "when" axis)

- **A milestone is a version** (`v0.3.0`, `v1.0.0`), never a theme or a sprint.
- **Assigning a milestone == "scheduled."** It is the *only* signal that something is scheduled.
- **Keep a forward spine of open milestones.** ForgeDB runs `v0.4.0 → v0.7.0` open ahead of the
  current release so scheduled work has a home. **1.0 is a horizon**, not yet a milestone, until
  its contents are real.
- Each milestone gets a **descriptive body** stating what ships and the "pending release until
  tagged" semantics (§2).
- **Closed ≠ shipped.** An issue closes *into* a milestone when its code merges; the roadmap keeps
  reading "pending release" until you cut the **GitHub Release** tag.

### 5.1 Release mechanics (portable principles)

- **Conventional commits → a generated changelog** (ForgeDB uses `git-cliff` → `CHANGELOG.md`).
  One source, two surfaces: the GitHub Release body *and* the website changelog render from it.
- **The changelog and roadmap scope-filter out non-core surfaces** (`website`, extension,
  packaging) so only core `v*` work headlines — mirrors the surface-exclusion rule in §6.
- **For published-artifact products, dry-run the publish before tagging** (e.g. an outside-repo
  install/build, or `cargo publish --dry-run`). Green in-tree ≠ an installed user can build.
- **Beware the closed-vs-released race.** A page that reads "Next" from the live Releases API will
  show a just-tagged version as *Next* until the Release actually publishes (build lag) — another
  reason "closed" and "released" are distinct rungs. Trigger roadmap refreshes on **Release
  completion**, not tag push.

### 5.2 Release readiness — the publish gap and the releasable-trunk property

**The property: the default branch must stay releasable.** Not "green" — *releasable*. Every test
can pass in-tree while the branch is still something you could not actually ship.

This matters for a specific class of product: one whose **built or generated output depends on
artifacts the project itself publishes** (a code generator whose emitted code links published
runtime crates; a library whose examples pin its own package; a plugin host and its SDK). For
those, there is a failure mode with no in-repo symptom:

> **The publish gap.** Work lands that makes the built output require a *newly published* API.
> In-tree everything resolves by path and passes. An installed user, resolving from the registry,
> cannot build at all. **CI is green and the branch is unshippable.**

Nothing in an ordinary test suite catches this, because the thing that is broken is *the
relationship between the repo and the registry*, and the repo can't see it. The only proof is an
**outside-repo reclose**: from a clean directory, with the *published* tool, run the real user
path — install → scaffold → generate → build — and confirm every dependency resolves from the
registry. Green in-tree has never proven this and never will.

#### Two ways to hold the property — pick one and write it down

The gap opens when publishing lags the work. There are exactly two honest ways to prevent trunk
from carrying it:

1. **Publish eagerly.** The moment work requires a new published API, publish it *before* the
   dependent pin lands. No gap ever exists on any branch. Cost: many intermediate versions, all
   permanent, most of which nobody ever resolves.
2. **Hold the gap off trunk.** Batch the publish at the release, and keep the gap on an
   integration branch so the default branch only ever holds released-and-resolvable state. Cost:
   a second long-lived branch and a real merge discipline (below).

Either is defensible; **choosing neither is not**. "We'll remember to publish before tagging" is
not a mechanism — it is the thing that fails. Whichever you pick, state it in `CONTRIBUTING.md`
so it survives the person who chose it.

#### If you hold the gap off trunk

- **`main` holds released state.** After a release it equals the tag. It is always installable
  from source.
- **`develop` (or equivalent) is where core work integrates.** It may knowingly carry a publish
  gap; that is its job.
- **The release sequence is ordered and the order is the whole point:** publish the artifacts →
  *then* merge `develop` → `main` → *then* tag. Publishing after the merge reintroduces the
  window you built the branch to eliminate.
- **The outside-repo reclose is a required check on `main`**, not on `develop`. Requiring it on
  the integration branch would make it permanently red for a whole cycle, and a check that is
  always red is a check nobody reads.

#### Which branch does non-core surface work target?

Not a surface question — a **coupling** question. §6.1 governs *milestones and changelogs* by
surface; branch targeting is governed by something different:

> **Does this change depend on, describe, or demonstrate behavior that is not released yet?**
>
> - **No** → straight to `main`. Typo fixes, styling, SEO, analytics, dependency bumps, broken
>   links, corrections to already-shipped documentation. These deploy continuously and should not
>   wait on a release they have nothing to do with.
> - **Yes** → `develop`, **in the same change as the feature**. Documentation for an unreleased
>   feature, examples using an unreleased API, screenshots of unshipped UI, a changelog entry
>   describing behavior nobody can run.

Getting this backwards produces **documentation that ships ahead of the feature it documents** —
a public page describing an API that does not exist yet, which is worse than no page at all: it
generates support load, and it makes the docs a liar in exactly the moment someone is trusting
them. Pair feature docs with the feature, always.

Note this is a *finer* rule than §6.1, not a contradiction. A `surface:website` issue still never
rides a core `v*` milestone; but a website change that documents unreleased core still waits for
that core to ship. One rule is about *where the work is tracked*, the other about *when it
becomes visible*.

#### `release-gate` — the rung between "closed" and "released"

§2's ladder ends `… → closed-into-milestone → released`. That gap is where release obligations
live, and they are not features: publishing artifacts, reconciling a version line, proving a
reclose, rotating a credential before it expires. Left as an ordinary `improvement`, they are
indistinguishable from work you could defer — and they are the exact opposite.

**`release-gate` names them.** An open `release-gate` issue on a milestone means that milestone
**cannot be tagged**, even if every feature on it is closed. It makes "are we releasable?" a
query (`--label release-gate --state open`) instead of a memory, and it gives the tag workflow
something mechanical to check.

**"Something to check" is not the same as something that blocks** — wiring the query somewhere it
can actually fail the tag is its own decision, and §5.5 is about making it deliberately. A gate
reported beside the release rather than in front of it is a notification.

File one the moment you *knowingly* defer a release obligation — the deferral is precisely when
it is most likely to be forgotten, because everything still works locally.

#### The release-gate issue MUST carry a versioned-asset ledger

A release-gate issue that only lists the obligations someone happened to notice is a checklist of
*remembered* work. The obligations you miss are, by construction, the ones nobody wrote down.

**So the gate issue's body carries a table of EVERY independently versioned asset in the
project** — every published package, every crate, every extension, every separately released
binary — with a default row of **"no change"**. Not the ones you touched. All of them. The table
is created when the milestone opens, before any work lands.

| Asset | Released | Bump needed | Why |
|---|---|---|---|
| `pkg-core` | 1.4.2 | **minor** | #123 added an additive API |
| `pkg-cli` | 0.9.0 | no change | |
| `vscode-ext` | 0.1.0 | no change | |

**As work lands, the row is updated in the same pass that lands it** — that is the whole
mechanism. Deciding "does this need a bump?" while the change is in front of you is reliable;
reconstructing it at tag time from a diff is not.

**Why the default row must exist rather than be implied.** An absent row and a "no change" row
look identical at tag time, but they mean opposite things: one is *"verified untouched"*, the
other is *"never considered"*. Only the explicit table can distinguish them, and the whole point
of the gate is to answer "are we releasable?" mechanically.

**Include assets you do not think of as products.** Internal packages that consumers never name
still resolve from a registry, and the failure they produce is the quiet one: the version
*exists*, so nothing errors, and the release ships stale source behind a correct-looking version
number. A publish dry-run does not catch this. The ledger is the only thing that does.

### 5.3 One integration branch, not one per version

Once `develop` exists, the natural next thought is a second one: `v0.5-develop` alongside
`v0.4-develop`, so next-cycle work has somewhere to go. **Don't.** There is exactly one
integration branch, and its name never contains a version.

**Two reasons, and the first is decisive for anyone who publishes anything.** The artifact
registry — npm, crates.io, PyPI, a container tag — is a single global namespace with one version
line per package. The publish gap is defined *relative to what is currently published*, so two
cycle branches carrying unpublished changes cannot both be measured: whichever publishes first
silently redefines the other's gap. The property §5.2 protects is inherently singular, because
the registry is.

**The second reason applies even to products that publish nothing.** §1 says there are exactly
two axes and nothing else decomposes work — the milestone is *when*. A version-named branch
encodes the schedule a second time, in a place that is harder to query and harder to correct, and
the two copies will disagree. That is the parallel-decomposition anti-pattern with merge conflicts
attached.

**Keep the branch version-agnostic** and it becomes self-advancing: `develop` means "the cycle in
flight," so the moment a release is tagged it *becomes* the next cycle with no rename, no new
branch, and no workflow edit.

#### Keeping next-cycle work off the integration branch

The gate reads the milestone, not the branch name — the schedule already lives on the issue, so
the check consults it rather than duplicating it:

> **A pull request targeting the integration branch may not close an issue milestoned later than
> the cycle in flight.**

Note the shape: a **deny-list on future milestones**, not an allow-list on the current one. That
distinction is what makes it usable without escape hatches. Untracked chores, CI fixes, and typo
PRs pass, and correctly so — work with no issue cannot be next-cycle work, because next-cycle work
is *defined* by carrying that milestone. The only thing the rule can fire on is the thing it exists
to catch.

**Derive the cycle in flight; never configure it.** It is the lowest open core milestone **whose
release line has not already shipped** — where a line is `major.minor`, so `v1.2.0` and `v1.2.1`
share one, and a closed milestone on the line is what marks it shipped. No constant to update,
nothing that can drift from the actual spine, and it advances on its own when a milestone closes.

The line clause is not a refinement; without it the gate inverts. **A patch on a released version
opens a milestone that sorts *below* the cycle** — `v1.2.1` while `v1.3.0` is in flight — so a plain
"lowest open" reading names the patch as the cycle and then fails every legitimate PR on the
integration branch, for as long as the patch milestone stays open. The check that exists to keep
next-cycle work out ends up blocking this-cycle work instead, and the only workaround is to stop
tracking patches.

Note that both halves rest on **one** prerequisite, which is worth stating because it is easy to
skip: **closing the milestone must be part of the release ritual**, alongside publishing and
tagging. It is what advances the cycle, and it is also the evidence a line has shipped — the line
clause reads exactly the same signal, for a second question.

So a milestone left open after its tag still freezes the gate and still starts blocking legitimate
next-cycle work. The line clause does not rescue it, deliberately: nothing on that line is closed,
so there is nothing to say it shipped. That is a loud, self-announcing failure rather than a silent
one, which is the right direction to fail in. `release-check` returning clean and the milestone
closing are the same moment.

`pm-playbook scope-check` implements this as **PM008**. Wire it on pull requests targeting the
integration branch.

#### Where next-cycle work lives meanwhile

On its own branch off the integration branch, unmerged, carrying its real milestone. Rebase it
after the release merge and it lands normally. This is strictly cheaper than a second integration
branch: you pay the merge cost once at the end instead of forward-porting every fix continuously.

Two second long-lived branches *are* legitimate, and neither is a second cycle line:

- **A maintenance line cut off a tag** (`release/v0.4.x`) when a patch is needed after the cycle
  has moved on. It branches *backward* from released state, so it carries no publish gap at all.
  Cut it when a patch actually materializes, not pre-emptively.
- **A track that cannot merge into the current cycle** — a format break, a major rewrite. Name it
  for the work (`format-v2`), never for a version, precisely so nobody reads it as a release line.

### 5.4 How branches land — decide it, then make the settings say it

Everything above is about *which* branch work targets. It is silent on *how* the work lands, and
that silence is not free: squash, rebase and merge-commit produce three different histories, and a
repo that has never chosen drifts into all three.

**Pick one and enforce it in the repository settings, not in prose.** Disable the methods you did
not pick. A written convention the merge button contradicts loses to the button every time — and
the reverse fails too: a setting nobody wrote down gets *worked around* by whoever meets it,
because a bare refusal reads as an obstacle rather than as a decision.

That is not hypothetical. It is what a settings/prose/history disagreement looks like from inside:

- the settings allowed rebase only,
- every branch in the history had landed as a local `--no-ff` merge commit,
- and `CONTRIBUTING.md` listed all three methods, naming as "default" the one the settings refused.

Three sources, three answers, and each contributor followed whichever they met first.

Three rules make the choice legible once it is made:

1. **Write it in `CONTRIBUTING.md`**, with the exact command if work merges locally. When the
   choice is merge commits, say that `--no-ff` is required: a branch that is merely ahead
   fast-forwards otherwise, and the branch boundary vanishes exactly as a rebase would have
   erased it.
2. **Say whether closing keywords work.** GitHub honours `Closes #<n>` only for PRs targeting the
   *default* branch. Under §5.2's hold-the-gap-off-trunk model, every PR into the integration
   branch therefore leaves its issue **open** however the body is written, and it must be closed
   by hand. Teams adopting an integration branch discover this by finding a milestone full of
   merged work that still reads as unfinished.
3. **Name the mechanics for *each direction* of the trunk↔integration sync, because they are not
   symmetric.** Integration → trunk **is** the release, and it is a merge commit: that boundary is
   the record of what shipped together, which is rule 1. Trunk → integration is only a **sync**,
   and it should be a **rebase**.

   A back-merge in that direction adds a commit whose entire payload is already on trunk. Do it
   every release and the integration branch fills with content-free `Merge trunk into integration`
   commits — noise that buries the real work, and worse, makes `trunk..integration` a liar: it
   lists commits that changed nothing, so the one query that should answer "what is unreleased?"
   stops meaning that.

   Two operational notes, both of which surprise people the first time:

   - Rebasing a *pushed* integration branch rewinds the ref, so it needs `--force-with-lease`.
     **Check the branch protections before adopting this**: if the integration branch is protected
     against non-fast-forward pushes, the rule cannot be applied there without a bypass — resolve
     that deliberately rather than discovering it mid-release. (Protecting only the default branch
     is the common setup, and leaves the integration branch free.)
   - `git rebase` drops merge commits by default. If the integration branch's only commits since
     the last release *are* prior back-merges, it collapses to exactly trunk — the correct outcome,
     though it looks alarming. Confirm `git diff trunk integration` is empty before force-pushing,
     so you know what was dropped carried nothing.

   This does not contradict rule 1. Rule 1 governs how a **branch of work lands**; this governs a
   **sync between two long-lived branches**. A repo can, and usually should, disable rebase merging
   for pull requests while still rebasing the integration branch onto trunk locally.

### 5.5 Enforcement points — a rule needs a place where it can fail

Everything in §5 defines rules: the milestone cannot be tagged while a `release-gate` is open, the
ledger's rows must be current, the trunk must stay releasable. Each is stated as an obligation.
**None of that says where the obligation is checked**, and a rule with no enforcement point is
enforced by memory at the exact moment memory is worst — mid-release, under pressure, by whoever
is holding the tag.

Naming the enforcement point is a separate act from writing the rule, and it is the one that gets
skipped, because the rule feels finished once it is written down.

#### A report is not a gate

The failure is easy to miss because the output *looks* like enforcement. A step lists the open
`release-gate` issues; the log shows them; everyone reads it. But if the step cannot fail the
thing it guards, it is a notification, and it will be scrolled past on the day it matters.

Two shapes produce this, and both are things a careful person does on purpose:

- **The step is deliberately non-failing.** A check that runs on every push to trunk *must not*
  fail on an open gate — mid-cycle gates are normal, and a job that is red for a whole cycle stops
  being read (the same argument §5.2 makes for keeping the reclose off the integration branch).
  So it is written `if: always()`, correctly for where it sits. What is missing is a *second*
  invocation at the tag, where an open gate is not normal at all.
- **The check runs beside the thing it guards, not in front of it.** On GitHub, two workflows
  triggered by the same event are independent: a `release-gate` check triggered by a tag push
  **cannot** block a release workflow triggered by the same tag push. It runs in parallel while
  artifacts build and publish. This is the trap to watch for, because "a workflow that runs on the
  tag" is the obvious reading of "a tag gate" and it is wrong.

So: **when you wire a gate, state what it is capable of failing.** If the answer is "nothing," it
is a report — keep it, label it as one, and put the gate somewhere else.

#### Put the check where the irreversible step is

Most CI accumulates on pull requests, because that is where checks are cheap to add and cheap to
re-run. But a PR can be redone; a merge can be reverted. **A published version cannot be
unpublished, and a consumed tag cannot be recalled.** Registries refuse re-uploads of a version
that already exists, so an incorrect release is corrected by *burning a version*, never by undoing
one.

Checks placed only on PRs are therefore concentrated where mistakes are recoverable and absent
where they are not. Ask of each gate: *what is the last moment this could still fail usefully?*
That is where it belongs. For a release, the honest options are:

1. **Fold the check into the release tool's own pre-release hook**, so it runs inside the pipeline
   it guards rather than beside it. Best when the tool supports it.
2. **Make it a required status check** via branch/tag protection rules, so the platform enforces
   ordering instead of your workflow graph.
3. **Accept parallel-and-loud** — the check races the release but fails visibly, and the release is
   reviewed before anything is announced. Legitimate, but it is a *convention* about announcement,
   not a mechanism, so write down which one you chose and why.

Choosing (3) unknowingly is the failure. Choosing (3) deliberately is fine.

#### A continuously-true claim needs a continuously-run check

"Trunk is releasable" is not a property of a commit. It is a property of the **relationship**
between the repo and everything outside it — the registry, the runner's default toolchain, the
advisory database, an expiring credential. All of those change with **no commit from you**.

A check triggered only by `push` therefore confirms the claim against evidence that may predate
the change, and it can sit green for an entire cycle on a run whose conclusion has expired. That
is the same stale-evidence failure as the ledger's absent row in §5.2, one level up: the badge
does not distinguish *verified now* from *verified once*.

**Add a `schedule:` to any check that validates state you do not control.** The reclose, the
advisory scan, and the credential-expiry check are all in this class. A push trigger answers "did
*we* break it"; only a schedule answers "is it *still* true."

#### Where a generator writes half your pipeline, the seam is unowned

Release tooling that generates CI (cargo-dist, goreleaser, changesets, and friends) usually ships a
`--check` that keeps *its* file honest. Nothing keeps yours honest, and the two are not
independent: the moment you add a custom job that consumes what the generated jobs produce, you
have a **compatibility constraint spanning a file that updates itself and a file that does not**.

That seam has the worst possible properties. It is exercised only during a real release, it sits
downstream of the irreversible step, and it is invisible to the generator's own check. When you add
a custom job, **record the coupling in a comment at the coupling point** — not in a design doc —
so the next person to bump a version knows what it must stay compatible with.

#### Fail-closed needs a resume path, or it is only fail-stuck

Publish steps should fail closed: a release that reports success with a channel missing is worse
than one that stops. But fail-closed is only half a design. The other half is what happens *next*,
and it is usually never specified, because the failure is assumed to be all-or-nothing.

It often is not. A publish that uploads several artifacts can fail partway, and registries reject
re-uploading what already landed — so the naive retry fails on exactly the files that succeeded,
and the recovery path written for "nothing was published" does not cover "some of it was."

**Make the retry idempotent rather than making the failure impossible.** Then say plainly what
idempotence costs: a step that tolerates already-present artifacts can no longer distinguish
*resuming* from *re-running against a version that already shipped*, so the gate deciding when it
may run at all is what keeps that safe, and it stays strict.

---

### 5.6 Hotfixes — the bounded exception, with a warrant

A **hotfix** is a `bugfix` that also carries the `hotfix` label. It takes the **same two gates** —
the bugfix path is already short, so there is no separate sequence to learn. What differs is
**eligibility, the milestone, and the branch**.

#### Eligibility — three tests, all of which must hold

1. **It is a defect in *released* behavior.** Not a missing feature, and not a regression that
   exists only on the integration branch. If an installed user of a published version cannot reach
   it, it is not a hotfix.
2. **Waiting for the next scheduled release is unacceptable, and the issue says why concretely** —
   data loss, a security hole, a broken install path, wrong output users act on. **The test is what
   damage accrues, never how long the wait is.**
3. **The fix is bounded, checkably:** no public API change, no schema change, no config surface, no
   dependency bumps, no new capability — and it is expressible as **one regression test that fails
   before and passes after**.

Failing any one means the work takes the normal path.

**Urgent but unbounded is not a hotfix.** That is a reason to cut the cycle short and ship what is
on the integration branch, or to accept the damage until the next release. Treating an unbounded
fix as a hotfix is how a patch release quietly becomes a minor release nobody designed.

#### The warrant lives in gate 1

Gate 1 (diagnose) carries the reproduction and the root cause as always, plus **the warrant**: why
it cannot wait, and what the fix will not touch. Gate 2 (fix) is spec-first, and the failing
regression test **is** the reproduction from the warrant — which is what mechanically proves
eligibility test 3 rather than asserting it.

#### The patch milestone

A hotfix gets **its own `vX.Y.Z` milestone**, opened when the warrant is accepted, and it is never
folded into the cycle in flight.

**One hotfix, one milestone.** A patch milestone that accumulates "while we're in there" work has
lost the boundedness that made it cheap, which is why this is an invariant (PM015) and not a habit.

**"Nothing else" means no other *work*.** A `release-gate` may — and for the ledger below, must —
sit on a patch milestone. It is a release obligation, not something anyone could defer, which is
the whole reason §5.2 gave it its own label. PM015 exempts it for the same reason PM010 and PM013
do.

Two things this does *not* waive:

- **The §5.2 asset ledger applies, and it lives in the same place it always does** — a `release-gate`
  issue on the patch milestone. §5.2 describes the ledger being created "when the milestone opens",
  which for a patch is the moment the warrant is accepted and the milestone is cut, not some earlier
  planning step. A one-row table still gets the issue: the ledger's value is the **"no change"** rows
  that prove an asset was considered, and a patch is where the temptation to skip that is strongest
  because exactly one thing usually moved.
- **`release-check` is unchanged.** A patch milestone is an ordinary core milestone for gating.

> Do not improvise the ledger into the fix gate's body. It works once and teaches the next person to
> improvise somewhere else, and it puts the ledger where no query can find it.

And note the interaction with §5.3: a patch milestone sorts *below* the cycle in flight, which is
why the cycle is derived as "the lowest open core milestone **on an unreleased line**". Without
that clause a hotfix would freeze the scope gate for its whole window.

#### Branch topology

This path assumes the integration-branch model (§5.2, option 2), where `main` holds released state
— which is what makes it simple:

> The fix **branches off `main`**, lands on `main`, is **tagged there**, and is then **merged
> forward** into the integration branch.

No maintenance line is needed in the common case; §5.3's `release/vX.Y.x` is only required when
patching a version *older* than the latest release.

**Forward-porting is part of the hotfix.** The issue does not close until the fix exists on both
branches — otherwise the next release silently regresses the bug, and it regresses it in exactly
the code someone just proved was urgent.

## 6. Surfaces — the delivery axis (`surface:*` labels)

A **Surface** designates a *distinct, independently shippable product surface* — a face of the
product a user touches (core lib, IDE extension, marketing site), one that may have its **own
release cadence and tag namespace**. Modeled as **labels**, only when a repo **ships more than one
artifact**; a single-artifact repo has one implicit surface (`core`) and needs no labels.

> **Why "surface," not "channel":** *"release channel"* already means a **stability stream**
> (stable / beta / nightly / canary) — an orthogonal concept that must stay separable (you can
> ship a beta *of* the extension). A Surface is a shippable *face*, not a maturity tier. And
> **"workstream" is retired** — it conflated the surface axis with subsystem decomposition.

| Surface label | Color | Covers |
|---|---|---|
| `surface:core` *(often implicit/default)* | `#1d76db` | The primary product line (core `v*` releases). |
| `surface:ide-extension` | `#007ACC` | Editor extension + language server (ships on its **own** `ext-v*` / `vscode-v*` tag line). |
| `surface:website` | `#1d76db` | Marketing + docs site (usually continuously deployed, no version tag). |
| `surface:cli` / `surface:sdk` | `#1d76db` | Any other independently shipped user-facing artifact. |

> **`ci` is *not* a surface** — CI/build tooling ships nothing to a user. It's just a labeled
> concern (`ci`), not a delivery surface. The test is "is a user touching this thing?"

### 6.1 The surface-exclusion rule (load-bearing)

**Never put a non-core `surface:*` issue on a core `v*` milestone.** A `surface:website` or
`surface:ide-extension` issue milestoned onto `v0.5.0` would read as *"done — awaiting v0.5.0"*
even though it already shipped on its own line, and it would never appear in the core changelog.
Non-core surfaces:

- ship on their **own release line / tag namespace** (or deploy continuously);
- are **excluded from the core roadmap and changelog** by a scope filter on their `surface:*`
  label;
- get their **own milestones** in their own namespace if they version at all (e.g. `ext-v0.1.0`).

The **Surface Board** view groups by these labels.

---

## 7. Epics & the roadmap view

### 7.1 Epics decompose via native sub-issues

An **`epic`** is an umbrella issue and a **top-level container that MAY span releases** — don't
force it to be atomic; its children ship incrementally, each carrying **its own milestone**.

- **Children are linked as GitHub *native sub-issues*** (`Parent issue` / `Sub-issues progress`;
  `gh api repos/OWNER/REPO/issues/N/sub_issues`, POST needs the child's REST `id`, not its
  number). **Not** task-list checkboxes (secondary, drift-prone) and **not** a Project field.
- **Standalone issues** (bug fixes, one-offs with no epic parent) are top-level too.

**An epic never carries gates of its own** (PM012). An epic spans releases while its children ship
incrementally, so a gate on an epic would be approving a design for work that has not been
decomposed yet. Gates belong to work items, one level down.

That gives the tree **exactly three levels, and there is no fourth**: an epic holds work items, a
work item holds gates, and a gate holds nothing (PM105). The cap is not an implementation limit —
it is what keeps "where does this live?" answerable without reading the whole tree.

Epic body shape (skeleton in `.github/ISSUE_TEMPLATE/epic.md`):

1. **`> ## ✅ Decisions locked (YYYY-MM-DD)`** — a blockquoted block of settled decisions at the
   top, each with a ✅ and a one-line rationale; supersedes stale discussion below it.
2. **Summary** — what it delivers, with a **release-blocking** flag if applicable.
3. **Current state (ground truth)** — where the code actually is *right now*.
4. **Children** — linked as native sub-issues (the "Sub-issues progress" bar rolls them up).
5. **Upstream / downstream** — relationships to other epics.

### 7.2 The roadmap is derived, EPIC-PRIMARY

The roadmap (e.g. a website `/roadmap` page) is **computed from the two axes + native sub-issue
structure**, never maintained by hand. Epics are the top-level unit; standalone issues sit
alongside.

**The buckets are computed, not filtered — and that is a change from earlier versions of this
model.** When the rungs were labels, each bucket was a one-line GitHub filter. They are derived from
gate state now (§2), and a bucket like "past design" is a property of a work item computed from its
*children*, which no issue search or Project filter can express. So the roadmap generator computes
them, from `pm-playbook ladder --json`:

| Bucket | Derivation |
|---|---|
| **Shipped** | closed + released (compact release cards; closed epics with children) |
| **Active** | milestone == the cycle in flight (§5.3) — this is what *scheduled* means now |
| **Committed** | has a milestone, but not the current one |
| **Labs** | `experiment` |
| **Ideas** | rung is `idea` — no gate 1 and no milestone |

**Gates are structure, not roadmap content: exclude them.** A three-item milestone whose gates all
rendered would show as twelve rows and read as four times the work.

Scope-filter out non-core `surface:*` labels (§6.1) so the core roadmap stays about the core.

---

## 8. The board is a view

The **backlog lives in Issues.** The Project board adds **saved views** — that's its only job.

**The board answers "what is being worked on", not "what stage is each item at".** That split is
forced rather than chosen: the ladder rung is computed from an item's children (§2), and a Project
filter cannot reach across the parent/sub-issue relation. What a filter *can* see is the gates
themselves, where the stage genuinely is a label — so the execution views are gate views.

| View | Layout | Filter / grouping | Answers |
|---|---|---|---|
| **Everything** | Table | *(none)* | The full backlog, gates included. |
| **Work items** | Table | *exclude every gate label* | The backlog as work, one row per item. |
| **Release spine** | Board | *group by Milestone*, gates excluded | "What are we committed to, by version?" |
| **Epics** | Table | `label:epic` | The epic-primary top level. |
| **Open gates** | Table | *any gate label* + `is:open` | Everything actively in progress, at its stage. |
| **Labs** | Table | `label:experiment` | The research track (off-spine). |
| **Hotfixes** | Table | `label:hotfix` | The patch line (§5.6). |
| **Release gates** | Table | `label:release-gate is:open` | "Can we tag?" (§5.2) |
| **Surface Board** *(multi-artifact repos)* | Board | *group by `surface:*` label* | Work by shippable surface. |
| **Execution** | Board | *group by Status* | Kanban, if you want one. |

Every work-item view **excludes gates**, for the same reason §7.2 does.

For the rung itself, use **`pm-playbook ladder`** — that is the query the board cannot be.

`Status` (Todo / In Progress / Done) is GitHub's native execution field — kept as a light in-flight
indicator, **not** a decomposition axis, and largely redundant now that an open gate says the same
thing more precisely. The filtered views are scriptable (`pm-playbook bootstrap`); the *grouped*
boards need a one-time group-by in the UI.

---

## 9. Gates — the work item's decomposition

> **Nothing gets coded until the gates before it are closed. Each gate is its own sub-issue, so
> "what stage is this at?" is a fact about the tree rather than a reading exercise.**

A work item's body holds **the business, project or product need**, and stays as non-technical as it
can. The technical work lives in the gates beneath it. That is one artifact per issue, which is what
makes any of them trustworthy: an issue holding the need *and* the design *and* the plan *and* the
spec list is never in a state where a reader can rely on the whole body.

### 9.1 The gate sets

Each gate is a **native sub-issue** of its work item, labelled `{type}:gate-{n}`. **A closed gate
means approved.** Closing the last gate closes the work item, and the PR that lands the work should
close both.

**`improvement` — three gates**

| Gate | Label | Is |
|---|---|---|
| 1 | `improvement:gate-1` | **design (WHAT & WHY).** Problem, desired behavior, solution *shape*, alternatives, explicit non-goals. Solution-shaped, never code-shaped. Catches **conceptual** gotchas. |
| 2 | `improvement:gate-2` | **plan (HOW).** Files to touch, build order, dependencies and blockers, interfaces, and **the BDD scenarios to write**. Catches **execution** gotchas. |
| 3 | `improvement:gate-3` | **impl.** Write the scenarios as failing specs (**RED**), implement to **GREEN**, refactor under green. The specs *are* the acceptance criteria. |

**`bugfix` — two gates**

| Gate | Label | Is |
|---|---|---|
| 1 | `bugfix:gate-1` | **diagnose.** Reproduction, root cause cited to a file and line, blast radius. For a hotfix, also the warrant (§5.6). |
| 2 | `bugfix:gate-2` | **fix**, spec-first: the regression test fails before and passes after. |

**`experiment` — two gates**: research (the charter) and evaluate (the verdict). Both are specified
in §4.1, because for an experiment the gates *are* the lifecycle.

**Why it works:** each gate's output is the next one's input, so nothing is re-derived. Design kills
conceptual surprises; the plan kills execution surprises; RED locks intent as executable truth
before any implementation exists.

**Gate contents are unchanged from earlier versions of this model.** What a design or an
implementation plan should say is the same. Only where it lives moved — out of a body section that
nothing could query, into an issue that everything can.

### 9.2 Gates carry their parent's milestone

A gate is milestoned identically to its work item (PM011). Two things fall out of that, and both
were reasons to choose it:

- **`scope-check` keeps working with no special cases** (§5.3). A gate is an ordinary milestoned
  issue to PM008, so a PR closing one is gated exactly like a PR closing anything else.
- **Milestone progress reflects gate completion**, which is what makes the cycle legible mid-flight
  rather than binary. §2 states the caveat that comes with it.

The invariant matters in the direction people forget: **moving a work item to a different milestone
must move its gates too**, or the gates are stranded on the old one and every milestone-scoped query
silently under-reports.

### 9.3 Gates materialize lazily, as a complete set

**Gates are created by the tool, never by hand**, and always as a whole set — never one at a time.

| Type | Trigger |
|---|---|
| `improvement`, `bugfix` | **Mechanical**: the work item is milestoned *and* that milestone is the cycle in flight. Cycle rollover is therefore the moment the next batch of work gets its gates, all at once. |
| `experiment` | **By decision**: when work on it starts. An experiment never carries a milestone, so the mechanical trigger can never fire for it — an experiment with no gates means *not started*. |

**This asymmetry is deliberate and has to be documented as such**, or "why didn't my gates appear?"
becomes a recurring question with no answer in the docs.

```
pm-playbook materialize --yes                 # the cycle in flight
pm-playbook materialize --issue 42 --yes      # an experiment, by decision
```

**Why tool-only creation is load-bearing.** If a human could file a gate, "gate absent" would mean
either *not materialized yet* or *nobody wrote it*, and nothing could tell the two apart. That is
exactly the failure §5.2 describes for the asset ledger, where an absent row and a "no change" row
look identical and mean opposite things. Tool-only creation is what makes absence *mean* something,
and therefore what makes the completeness rule below worth having.

Two mechanisms close it, and §5.5 constrains both:

- **The command is idempotent and resumable.** Creating N sub-issues can fail partway, which is
  §5.5's "fail-closed needs a resume path" case exactly. Re-running materializes only what is
  missing, and *adopts* a gate that was created but never linked rather than making a second one.
- **The completeness rule needs a schedule, not only a push trigger.** "Every focused work item has
  its full gate set" (PM013) is a **continuously-true claim whose truth changes with no commit from
  anyone** — closing a milestone advances the cycle and instantly makes a new milestone's items
  non-compliant. §5.5 names this class directly: a push trigger answers *did we break it*; only a
  schedule answers *is it still true*. Wire `check` on a `schedule:` as well as on pull requests.

### 9.4 No status labels — state is the structure

There is no `has-design`, no `needs-design`, and no effort label. **State is derived from ground
truth**: does gate 1 exist, and is it closed? Is there a gate 2? Are the specs passing (read from
CI)? A status label is a claim a human must remember to update; **the artifact's existence is the
signal**.

Effort labels are banned outright — effort is not reliably knowable, and a guess mis-steers scoping.

### 9.5 Where design lives

The design is **the gate-1 issue** — never a committed `proposal-*.md`. The only design documents in
the tree are **durable architecture references for *shipped* features** (`ARCHITECTURE.md`). When a
feature ships, fold its durable design into `ARCHITECTURE.md`; the gate issue is already closed and
stays as the record of how the decision was reached.

### 9.6 A body states current truth only — purge as you amend

**The general rule, of which reopening a gate is one instance:**

> **An amendment replaces. The thing being superseded comes out in the same edit that puts the
> replacement in.** Not struck through, not annotated "see below", not left in place with a
> correction underneath.

**Why this is a hard rule and not a nicety.** A superseded paragraph does not read as superseded —
it reads as current, because that is what a body *is*. Everything downstream trusts it: the next
planning pass, an agent picking the issue up cold, a reviewer checking whether the implementation
matches. The correction is invariably in a comment, and top-down readers never reach it. The failure
is silent and it compounds, and it costs every parallel agent separately, because each one loads the
whole body and pays for the dead half.

Two shapes recur. **Superseded content accumulates**: a claim is disproved, a constraint turns out
to be an assumption, a number gets corrected — the correction lands in a new paragraph and the
original stays, so every later reader has to work out which half is live. And **justification
outgrows substance**: rationale gets written at the length it took to think rather than the length
it takes to convey, until the artifact stops being reviewable by a human and stops being usable by
an agent. **Rationale is proportionate to the decision it supports.**

This is about the **body**, which is the only surface that reads as current by default. Comments
remain the discussion record; nothing here deletes history.

#### Every body opens with a plain-English summary

**The first section of every work item and every epic is `### In plain English`** — two or three
sentences on what this is, for a reader who has never seen it. Structured content follows it;
rationale follows that.

The heading is **identical everywhere** rather than tuned per type, because it is read by tooling as
well as by people, and a per-type heading would push a type-to-heading table into every consumer and
break the moment a type is added. It is checked by **PM017**, on presence and position only — no
mechanism can tell a live paragraph from a dead one, and a length threshold measures the symptom
least correlated with the defect.

**Gates and `release-gate` issues are exempt from the slot**, though not from the purge rule above:
their bodies are seeded with mandated structure that already serves the purpose. An **epic is not
exempt** — it is read by the same tooling its children are.

#### Reopening an accepted gate

Gates get reopened. New information lands, a constraint turns out to be an artifact of an
assumption, an implementation reveals the design was solving the wrong problem. Redoing a gate is
healthy; what is not healthy is what the issue body says while you redo it.

**The moment you decide to redo an accepted gate, the issue body is purged — before any new
thinking happens.** What replaces it is a placeholder and nothing else:

```markdown
> **Gate 1 is being redone (reopened YYYY-MM-DD).** The previously accepted design has been
> withdrawn and this body intentionally holds no design content. Do not plan against anything
> here. The live discussion is in the comments.
```

Stashing the old body to a scratch file while you work is fine and often useful. **Delete the
stash when the new gate is accepted and the new body is written** — a lingering copy of a
withdrawn design is the same hazard one directory over.

The body stays a placeholder for the whole redo. It is repopulated only at acceptance, from the
accepted outcome — never patched incrementally as thinking evolves, which just recreates the
half-superseded state the purge exists to prevent.

### 9.7 Reconcile sources at every gate boundary, both directions

Gates are exactly where stale claims do their damage: each gate's output is the next gate's input,
so a bad input is not caught, it is *built on*. **Run a source reconciliation before and after
every gate** — not only around "non-trivial" work, and not only around implementation.

- **Before a gate (verify):** enumerate every claim source touching the work — issue bodies and
  comments, design/architecture docs, agent memory, code comments, the release-gate ledger — and
  check each against ground truth (the code, history, actual runtime state). Fix or delete what
  has drifted *first*, so the gate is built on verified state.
- **After a gate (propagate):** push the accepted outcome outward — issue body, docs, memory,
  cross-linked issues — so the next gate and the next session start aligned.

This is deliberately expensive. It is worth it: the cost of a reconciliation pass is bounded and
paid once, while the cost of planning against a stale claim is unbounded and discovered late.

---

### 9.8 Parallel agents — what they must be given, and what they may conclude

Point several agents at several issues at once and each reads only its own. It then confidently
proposes something that breaks, duplicates, or contradicts what a sibling issue already decided.
That is not a discipline failure. §1 bans a third decomposition axis and epics give hierarchy only,
so there is nowhere in the model to record that two issues constrain each other — **the agent is not
failing to look; there is nothing to look at.**

**Context is pushed, never fetched.** A rule telling agents to read their siblings first fails under
exactly the conditions that motivate it: an agent optimising its own narrow task skips a
discretionary read. So the fan-out step assembles the neighbourhood and puts it in the brief. An
agent is *given* its context.

**The neighbourhood is derived, never recorded.** From explicit `#N` references in either direction,
the epic parent and its other children, a shared surface, and a shared milestone. Nothing about a
relation is stored anywhere, so nothing can drift — the same argument §8 makes for the board. A
`related-to` label would be a third axis in disguise, needing its own invariant to stay honest and
decaying exactly like the `Priority`/`Size` fields §1 exists to ban.

**Breadth is complete; depth is rationed.** The neighbourhood arrives as two layers:

- **A roster naming every neighbour, never truncated.** This is the property that cannot be traded
  for size. An agent that does not know a neighbour exists is the failure being fixed, so anything
  not expanded is still listed, with an explicit count and the command that expands it.
- **Depth for the closest ring only**, composed of each neighbour's own §9.6 summary rather than its
  raw body. An excerpt says what a neighbour *contains*; a summary says what it is. Closed issues
  are roster-only — closed work is reference, not context.

**What a parallel agent may conclude.** An agent that can see the edge of its neighbourhood but not
all of it may produce **gate 1 material**: a design that states what it would disturb across that
neighbourhood. It may **not** jump to implementation across a neighbourhood it cannot fully see.
Two agents proposing conflicting designs for genuinely coupled issues is the expected outcome, and
declaring blast radius is what surfaces the conflict for a human — it does not resolve it, and it is
not meant to.

**The code map is written onto the issue at gate 2.** Entry points, call paths, files that must
change — each cited by path, and carrying the commit it was derived at. The next agent reads the map
instead of rediscovering it. A map is a **claim** about ground truth (§1) and therefore rots, so
§9.7's before-gate verify pass re-checks it. A stale map that reads as current is the §9.6 failure
in a new location.

**Relations neither issue's own summary can carry** — "these two must ship together" — belong on the
**epic**. That is the model's existing home for a relation between issues, with one owner and a body
rather than an append-only log.

## 10. Documentation discipline

- **Design docs live as gate-1 issues, not files** (§9). Filing work is a small workflow: a dedup
  check against existing issues, the work item's body (the *need*, non-technical), the epic
  cross-link — then `materialize` when it reaches the cycle in flight.
- **Two roadmap docs**, both deferring to Issues as authoritative:
  - **`VERSION_ROADMAP.md`** — the *honest state* of the current release effort: situation →
    scope (locked) → complete → still deferred.
  - **`WHAT_IT_IS.md`** — an "is / isn't" account: per-feature guarantees *and* honest limits,
    with a standing *"verify maturity claims against the code"* and *"where the README
    over-promises, this doc wins."*
- **`CONTRIBUTING.md`** states the two-axis model, the three work types and their invariants, the
  gate doctrine, and which of §5.2's two publish strategies this repo chose. It's where a newcomer
  learns the system.

---

## 11. Operating disciplines

Standing rules that keep Issues the single, always-current source of truth:

- **Backlog lives in Issues — no markdown backlog.** No `TASKS.md` / `TODO.md` shadow list. Ask
  "what's next" with `gh issue list --state open` (filter by label / milestone), not a file.
  - **Read the mirror, not one API call per question.** `pull` materializes Issues to
    `.pm-playbook/backlog/` — every body, comment, label, milestone and parent link as ordinary
    files. **When the mirror exists, it is where an agent reads the backlog**: "what is left in
    this release" and "what did we decide on #42" become a `grep` over local files instead of a
    round trip each, and reading twelve issue bodies over the API is twelve of them. `check
    --no-remote` lints the same mirror with the same issue-level rules.

    Three properties bound its use. It is **gitignored and machine-local**, so a fresh clone has no
    mirror and its absence means "not pulled here yet," never "no issues." It **goes stale** the
    moment anyone else moves an issue — `pull` again when it matters. And **reading is local while
    writing is not**: edit-then-`push`, which refuses outright when both sides moved, or go through
    `gh` directly. Never hand-edit a file and assume GitHub knows.
  - **A reconciled local mirror is not a shadow backlog.** The distinction is precise: **a second
    copy is a shadow backlog when it can disagree with Issues indefinitely.** This one cannot. It
    is gitignored rather than committed, so it is never a reviewable artifact competing with the
    issue; `pull` overwrites it from GitHub; and `push` refuses outright the moment both sides have
    moved, rather than merging or picking a winner. A `TASKS.md` has none of those properties —
    nothing overwrites it and nothing refuses on its behalf, so it drifts silently and forever.
    **If you find yourself hand-maintaining a file the tooling does not reconcile, that is the
    forbidden thing**, regardless of where it lives.
- **Auto-file issues for new work.** When you commit to a piece of work, `gh issue create` first —
  with exactly one type label, and a body that states the *need* rather than the solution — *then*
  implement. Don't wait to be asked. Leave it unmilestoned if it is speculative; that is what
  `idea` means now (§2), and it is derived rather than stuck on.
- **Never hand-create a gate.** `pm-playbook materialize` owns them (§9.3). Filing one by hand
  destroys the only thing that makes an absent gate meaningful.
- **Re-check the issue list each session.** State changes out-of-band; `gh issue list` at the
  start of relevant work so you're not acting on a stale view.
- **Proactively cross-link docs ↔ issues.** When new issues/epics give a home to claims scattered
  in docs, add the pointers **both directions** without waiting for permission — this is the
  *propagate* half of keeping sources aligned (run `sync-sources` at task boundaries).
- **Reconcile sources at every gate boundary, both directions** (§9.7). Task boundaries are the
  floor; gates are the ones that must never be skipped, because a gate's input is the previous
  gate's output and a stale claim there is built on rather than caught.
- **Keep the release-gate ledger current as you go** (§5.2). When a change touches an
  independently versioned asset, set that asset's row in the same pass — not at tag time.
- **When you write a rule, name where it fails** (§5.5). A rule stated in `CONTRIBUTING.md` with no
  enforcement point is enforced by whoever remembers it, under the most pressure, at the least
  recoverable step. Before calling a gate wired, say out loud what it is capable of failing — and
  if the honest answer is "nothing," it is a report, which is fine as long as it is labeled one and
  the gate lives somewhere else.
- **Prioritize on engineering merit, not demand.** Never justify building or deferring on "demand,"
  "usage," or "when users want it" — for a pre-launch product those signals *don't exist*, so
  leaning on them smuggles in data you don't have. Justify on **scope, risk, foundational
  sequencing** (does X unblock Y), **identity fit**, and the legitimate YAGNI test: *does generated
  code / another crate actually link this?* (an in-codebase-consumer question, never a market one).

---

## 12. Adopting this in a new repo — checklist

1. **Adopt locally.** `npx @hoodiecollin/pm-playbook init` — vendors this doctrine into `.pm-playbook/`,
   copies the issue templates, and wires the agent instruction files so the model reaches whatever
   harness your team uses. Add `--detect` to also write `CLAUDE.md`, `.cursorrules`, and friends.
   **Commit what it writes**: agents read it from the repo, so it must not be gitignored.
2. **Provision GitHub.** `npx @hoodiecollin/pm-playbook bootstrap --repo <owner>/<name> --project <N>` — the
   labels (with descriptions), a starter milestone, and the scriptable filtered views. Idempotent.
3. In the UI, set the **group-by** on the Release-spine / Surface / Execution boards (grouping
   isn't scriptable).
4. **If migrating an existing board: delete the `Priority`, `Size`, and `Workstream`/`Area`
   fields and every view that filters or groups by them**.
5. Define this product's **`surface:*`** labels — only if it ships more than one artifact
   (`bootstrap --surfaces "core,website"`).
6. Seed `VERSION_ROADMAP.md` + `WHAT_IT_IS.md` (§10) and put the two-axis model + doctrine into
   `CONTRIBUTING.md`.
6b. **If the product publishes artifacts its own built output depends on** (§5.2): decide *now*
   whether you publish eagerly or hold the gap off trunk, write the answer and the branch a PR
   targets into `CONTRIBUTING.md`, and wire the outside-repo reclose as a required check on the
   default branch. A repo that publishes nothing can skip this entirely.
6c. **Pick how branches land** (§5.4) — merge commit, squash, or rebase. Disable the other two in
   the repository settings so the merge button and `CONTRIBUTING.md` cannot disagree, and record
   the choice, the exact local command if work merges locally, and whether closing keywords reach
   your issues.
7. Backfill: give every existing issue **exactly one type label**, assign milestones to what you
   are committed to, and **enforce the invariants** (§3.2). Find every violation at once with
   `npx @hoodiecollin/pm-playbook check --all-states` — PM010 enumerates what is still untyped.
8. Convert epic checklists to **native sub-issues** (§7.1).
8b. **Materialize gates for the cycle in flight**: `npx @hoodiecollin/pm-playbook materialize --yes`.
   PM013 tells you when this is owed, and it is owed again at every cycle rollover — which is why
   step 9b's `schedule:` matters more than it looks.
9. **Wire the gates into CI** so the invariants survive the person who set them up:
   `check` on pull requests, `release-check <vX.Y.Z>` before a tag, and — if you keep an
   integration branch (§5.3) — `scope-check <pr>` on PRs targeting it.
9b. **For each gate you just wired, name what it can fail** (§5.5) — "before a tag" in step 9 is
   doing more work than it looks. A `release-check` job triggered by the same tag push as your
   release workflow runs *beside* it and blocks nothing; it needs a pre-release hook, a required
   status check, or a written acknowledgement that it is parallel-and-loud. Also give a
   `schedule:` to every check validating state you do not control (the reclose, advisories,
   credential expiry) — those go stale with no commit from you, and a push-triggered badge cannot
   tell *verified now* from *verified once*.

---

## 13. Anti-patterns this model exists to prevent

- **A parallel decomposition scheme** (Priority/Size/Workstream fields, a labels convention, a
  Project field) → there is **one** model: milestone + labels + native sub-issues. A second axis is
  a second source of truth that drifts.
- **A maturity label beside a derived state** → if the ladder rung is both computed and stickered,
  the two can disagree, which is a drift surface that simply does not exist when only one of them
  is real (§2).
- **Two type labels, or none** → the type decides the gate set, so an ambiguous type makes "is this
  item complete?" unanswerable (PM010).
- **An experiment on the release spine** → experiments produce decisions, not artifacts; they feed
  the spine, never ride it (§4). Never anchor a release theme on a spike's hoped-for result.
- **Time/effort estimates** driving scope; **effort labels** → effort isn't reliably knowable.
- **Demand/usage justifications** → prioritize on engineering merit (§11).
- **Coding before designing** → design-doc then implementation-plan then BDD RED→GREEN (§9).
- **Stale status-labels** (`has-design`/`needs-design`) → state is *derived*, not stickered.
- **Doc drift** → design lives as gate-1 issues; only shipped-feature architecture is committed.
- **A hand-created gate** → it destroys the meaning of an absent gate, which is the only thing that
  makes gate-set completeness checkable (§9.3).
- **A hotfix that grows** → "while we're in there" work on a patch milestone turns a patch release
  into a minor release nobody designed. Urgent-but-unbounded is not a hotfix (§5.6).
- **A hotfix that never forward-ports** → the next release silently regresses a bug someone just
  argued was urgent (§5.6).
- **"Done" ambiguity** → closed-into-milestone vs released are distinct rungs.
- **Board as shadow backlog** → Issues are the backlog; the board is only a view.
- **Non-core surface work on a core milestone** → it reads "done, awaiting vX" but ships on its
  own line and never hits the core changelog (§6.1).
- **A green default branch that cannot actually be released** → the publish gap (§5.2). In-tree
  tests cannot see it; only an outside-repo reclose can. Publish eagerly or hold the gap off
  trunk — "we'll remember before tagging" is not a mechanism.
- **Documentation that ships ahead of the feature it documents** → docs for unreleased behavior
  belong on the integration branch *with the feature*, not merged to trunk because "it's only
  docs" (§5.2).
- **A release obligation filed as an ordinary `improvement`** → it reads as deferrable when it is
  the opposite; label it `release-gate` so "can we tag?" is a query, not a memory (§5.2).
- **A gate that reports instead of failing** → a step that runs `if: always()`, or a workflow that
  races the release rather than preceding it, enforces nothing while looking like it does. State
  what each gate can fail; if the answer is "nothing," it is a report (§5.5).
- **Checks only on pull requests, none on the tag** → they are concentrated where mistakes are
  recoverable and absent where they are not. A version cannot be unpublished (§5.5).
- **A readiness check with no `schedule:`** → "trunk is releasable" depends on the registry, the
  runner default, and the advisory database, none of which produce a commit. Push-triggered, the
  badge can sit green all cycle on expired evidence (§5.5).
- **A fail-closed publish with no idempotent retry** → correct until it fails *partway*, at which
  point the recovery path written for "nothing shipped" fails on what already did (§5.5).
- **A version-named integration branch, or one per upcoming version** → the publish gap is defined
  against a single registry and only one cycle can be in flight; a version in the branch name also
  encodes the schedule a second time, competing with the milestone (§5.3). One integration branch,
  version-agnostic, gated by `scope-check`.
- **Back-merging trunk into the integration branch** → every release leaves a content-free merge
  commit behind, until `trunk..integration` lists commits that changed nothing and stops answering
  "what is unreleased?". Sync that direction by rebase (§5.4 rule 3); the merge commit belongs to
  the other direction, where it records what shipped.
- **Roadmap over-promising** → `WHAT_IT_IS.md` states limits and cedes authority to the code.
