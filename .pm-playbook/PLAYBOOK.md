# Roadmap Playbook — the ForgeDB project-management model, generalized

The canonical, portable version of the project-management approach worked out on **ForgeDB**.
Any repo can adopt it. It is a *system*, not a board: GitHub **Issues** are the backlog, a small
**label** vocabulary and **milestones** are the only two axes that organize them, and a
**documentation discipline** keeps every claim honest.

> **The rule:** code + git history is *ground truth*. Every other artifact — a board card, a
> label, a roadmap doc, an RFC, a memory note — is a *claim* about ground truth and must point
> back to it. When a claim disagrees with the code, the claim is wrong.

---

## 1. The two-axis core (the whole model)

**All work is GitHub Issues, organized by exactly two orthogonal axes — and nothing else
decomposes work:**

| Axis | Mechanism | Answers |
|---|---|---|
| **When** | **Milestone** = a version release (the *release spine*, §5) | *Is this scheduled, and for which release?* |
| **What kind / maturity** | **Labels** (§3) | *What is this, and how committed are we?* |

Plus one structural mechanism and one hard rule:

- **Epics decompose via GitHub *native sub-issues*** (§7) — the real `Parent issue` /
  `Sub-issues progress` link, **not** task-list checkboxes and **not** a Project field.
- **The Project board is a *view* over issues, never a second source of truth** (§8).

**There are no `Priority`, `Size`, or `Workstream`/`Area` custom fields.** Earlier versions of
this model (and the ForgeDB board itself, until 2026-07-30) carried them; they were **deleted**.
They created a parallel decomposition scheme — a second source of truth that drifts — and tempted
work to be sliced by a guessed number instead of by *when it ships* and *what it is*. If you are
migrating a board that has them, **remove the fields and any view that depends on them** (§8).

Why so spartan: two axes you can read off an issue at a glance, with mechanical rules between
them, beat a rich field matrix nobody keeps current. Everything downstream — the roadmap page,
the changelog, "what do I do next" — is *derived* from these two axes, not tracked separately.

---

## 2. The commitment ladder (the maturity gradient)

The labels encode one idea: work is ranked by *distance from shipped*. This **commitment ladder**
is the spine of the "what/maturity" axis:

```
  speculative       committed          scheduled           shipping             shipped
  ───────────       ─────────          ─────────           ────────             ───────
  label: idea   →   label: plan-next → milestone assigned → merged / closed    → GitHub Release
  (needs an RFC)    (unscheduled)      (drop plan-next)     (into the milestone)  (roadmap flips)
```

| Rung | Means | Promotion gate → next rung |
|---|---|---|
| **`idea`** | Speculative. Not committed. | **Gate 1:** an accepted **design-doc** (`rfc` issue — §9). |
| **`plan-next`** | Committed, but not yet scheduled to a version. | Assign a **milestone** (and **drop `plan-next`** — §3.2). |
| **milestone** | Scheduled into a specific release. | **Gate 2:** a reviewed **implementation-plan** → start work. |
| **In flight** | Being built (**Gate 3:** BDD specs RED → GREEN — §9). | Merge; the issue **closes into** its milestone. |
| **Closed-in-milestone** | Done in code, but roadmap reads *"pending release"*. | **Tag the GitHub Release** for the milestone. |
| **Released** | Shipped reality. | — |

Copy this framing into every milestone description:

> *"Issues close into this milestone until it is tagged; on the roadmap they read as 'pending
> release' until the vX.Y.Z GitHub Release exists."*

**Why it matters:** "done" is ambiguous. The ladder splits it into *code-complete* (issue closed)
and *shipped* (release tagged), so the roadmap never over-promises. (`experiment` is **not** a rung
on this ladder — it is off-spine entirely; see §4.)

---

## 3. Labels — the "what / maturity" axis

Labels are **self-documenting**: each label's *description* is the process. The bootstrap script
writes these descriptions for you.

### 3.1 The taxonomy (portable verbatim)

| Label | Color | Description (this text is the process) |
|---|---|---|
| `idea` | `#c5def5` | Speculative feature idea; needs a design note before implementation. |
| `plan-next` | `#0e8a16` | Committed but not yet scheduled to a version milestone (milestone = scheduled). |
| `rfc` | `#5319e7` | Request for comment: design captured as an issue (proposals no longer committed to the repo). |
| `experiment` | `#a2eeef` | A spike to measure; deliverable is a decision, not a shippable artifact. Never milestoned (§4). |
| `epic` | `#6f42c1` | Umbrella tracking issue; decomposes via native sub-issues. |
| `tech-debt` | `#fbca04` | Known gap or stub in shipped code. |
| `perf` | `#d93f0b` | Performance cost / triage item. |
| `config` | `#1d76db` | Configurable-runtime-behavior work. |
| `legacy-audit` | `#5319e7` | Legacy audit: prune dead / product-misaligned code. |
| `release-gate` | `#b60205` | Blocks the tag: this milestone cannot be released until it is closed (§5.2). |

Plus GitHub's stock labels (`bug`, `documentation`, `enhancement`, `good first issue`, `help
wanted`, `question`, `duplicate`, `invalid`, `wontfix`) and the **`surface:*`** delivery labels
(§6).

### 3.2 Label invariants (the integrity rules)

These mutual-exclusions keep the two axes clean and make every derived view trivial to filter.
**Enforce them on every issue:**

- **`plan-next` ⊕ milestone.** `plan-next` means *committed but unscheduled*. The moment you
  assign a milestone the item is scheduled — **drop `plan-next`.** They must never coexist.
- **`idea` ⊕ `plan-next`.** Speculative and committed are opposites. Pick one.
- **`experiment` ⊕ {`idea`, `plan-next`, milestone}.** A spike you've committed to running is no
  longer merely speculative, isn't feature work in a queue, and never rides the spine (§4).
- **`release-gate` ⇒ milestone, and `release-gate` ⊕ `idea`/`plan-next`/`experiment`.** A gate
  blocks a *specific* tag, so it is meaningless without the milestone it blocks — and it is by
  definition committed, so it can never be speculative or unscheduled. **An open `release-gate`
  on a milestone means that milestone cannot be tagged**, regardless of whether every feature on
  it is closed (§5.2).

A consequence worth naming: because `plan-next` never has a milestone, "everything committed but
unscheduled" is *exactly* the `plan-next` filter — no compound query needed. Likewise
`--label release-gate --state open` is the complete "can we tag?" query.

---

## 4. Experiments never ride the release spine

**Doctrine (locked on ForgeDB 2026-07-30).** A milestone ships **features / fixes / perf** —
things that produce a binary a user installs. An **`experiment` is a spike to *measure*; its
deliverable is a *decision*, not a shippable artifact.** Therefore:

- An `experiment` issue is **never** placed on a `v*` milestone. Experiments run as an
  **unscheduled research track**, parallel to the spine.
- The experiment's *measured conclusion* may **commit new feature work** — and **that** feature,
  not the spike, is what gets a milestone.
- **Never anchor a milestone's theme on an experiment's hoped-for outcome.** You cannot schedule
  a feature whose existence the experiment has not yet decided. (Real error this corrected: a
  storage-model experiment was proposed as a release *anchor* — wrong; it *feeds* the release, it
  isn't *on* it.)

**The discipline test:** if an issue's primary output is a **measurement / evaluation / verdict**,
it's an `experiment` (off-spine). If it's **shippable code that ships regardless of any
measurement**, it's a feature / `perf` / `config` item (on-spine).

**Experiment method must be fair.** Since the deliverable is a decision, the measurement has to be
apples-to-apples (e.g. match durability/transaction semantics across anything you benchmark) — a
verdict from an unfair comparison is worse than none.

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
reclose, rotating a credential before it expires. Left as ordinary `tech-debt`, they are
indistinguishable from work you could defer — and they are the exact opposite.

**`release-gate` names them.** An open `release-gate` issue on a milestone means that milestone
**cannot be tagged**, even if every feature on it is closed. It makes "are we releasable?" a
query (`--label release-gate --state open`) instead of a memory, and it gives the tag workflow
something mechanical to check.

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

**Derive the cycle in flight; never configure it.** It is the lowest open core milestone by
version order. No constant to update, nothing that can drift from the actual spine, and it
advances on its own when a milestone closes.

That derivation has exactly one prerequisite, and it is worth stating because it is easy to skip:
**closing the milestone must be part of the release ritual**, alongside publishing and tagging. A
milestone left open after its tag freezes the gate and starts blocking legitimate next-cycle work
— a loud, self-announcing failure rather than a silent one, which is the right direction to fail
in. `release-check` returning clean and the milestone closing are the same moment.

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

Two rules make the choice legible once it is made:

1. **Write it in `CONTRIBUTING.md`**, with the exact command if work merges locally. When the
   choice is merge commits, say that `--no-ff` is required: a branch that is merely ahead
   fast-forwards otherwise, and the branch boundary vanishes exactly as a rebase would have
   erased it.
2. **Say whether closing keywords work.** GitHub honours `Closes #<n>` only for PRs targeting the
   *default* branch. Under §5.2's hold-the-gap-off-trunk model, every PR into the integration
   branch therefore leaves its issue **open** however the body is written, and it must be closed
   by hand. Teams adopting an integration branch discover this by finding a milestone full of
   merged work that still reads as unfinished.

---

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
alongside. Forward **status buckets are derived** from state + labels + milestone — and the label
invariants (§3.2) make each bucket a one-line filter:

| Bucket | Derivation (filter) |
|---|---|
| **Shipped** | closed + released (compact release cards; closed epics with children) |
| **Active** | scheduled (has a milestone) and/or in flight |
| **Planned** | `plan-next` (committed, unscheduled — and by invariant, milestone-free) |
| **Labs** | `experiment` or `rfc` |
| **Ideas** | `idea` |

Scope-filter out non-core `surface:*` labels (§6.1) so the core roadmap stays about the core.

---

## 8. The board is a view

The **backlog lives in Issues.** The Project board adds **saved views** — that's its only job.
With Priority/Size/Area gone, views are driven by the two axes (labels + milestone) and Status,
and thanks to the invariants they're trivial filters:

| View | Layout | Filter / grouping | Answers |
|---|---|---|---|
| **Everything** | Table | *(none)* | The full backlog. |
| **Release spine** | Board/Table | *group by Milestone* | "What's scheduled, by version?" |
| **Epics** | Table | `label:epic` | The epic-primary top level. |
| **Planned** | Table | `label:plan-next` | Committed, not yet scheduled. |
| **Labs** | Table | `label:experiment,rfc` | The research track (off-spine). |
| **Ideas** | Table | `label:idea` | Speculative backlog. |
| **Surface Board** *(multi-artifact repos)* | Board | *group by `surface:*` label* | Work by shippable surface. |
| **Execution** | Board | *group by Status* | Kanban of in-flight work. |

`Status` (Todo / In Progress / Done) is GitHub's native execution field — kept as a light
in-flight indicator, **not** a decomposition axis. The filtered views are scriptable (§ bootstrap
script); the *grouped* boards (by Milestone / Surface / Status) need a one-time group-by in the UI.

---

## 9. The design → plan → spec doctrine

> **Nothing gets coded until two artifacts exist, in series: a *design-doc*, then an
> *implementation-plan*. Both live as issues, never as committed files.**

Design and planning are **two distinct deliverables**. Doing them *in series before any code* is
what surfaces gotchas while they're cheap and makes the coding fast and unambiguous. Three gates:

- **Gate 1 — design-doc (WHAT & WHY).** An **`rfc` issue**: problem, desired behavior, solution
  *shape*, alternatives, and explicit **non-goals/limits**. Solution-shaped, not code-shaped.
  Catches **conceptual** gotchas. **Accepted →** drop `idea`, add `plan-next`.
- **Gate 2 — implementation-plan (HOW).** Written after the design is accepted and the item is
  scheduled, *before* code: files to touch, build order, dependencies/blockers, interfaces, and
  **the BDD scenarios to write**. Catches **execution** gotchas. Lives on the issue.
- **Gate 3 — BDD spec-first, RED → GREEN.** Write the scenarios as failing specs (**RED**),
  implement to **GREEN**, refactor under green. The specs *are* the acceptance criteria, so "done"
  is unambiguous and regression-proof.

**Why it works:** each stage's output is the next's input, so nothing is re-derived. Design kills
conceptual surprises; the plan kills execution surprises; RED locks intent as executable truth
before implementation exists.

**No `has-design` / `needs-design` / effort labels.** State is **derived from ground truth**: does
an accepted design-doc exist (past Gate 1)? an implementation-plan on the issue (Gate 2)? passing
specs (Gate 3, read from CI)? A status label is a claim a human must remember to update; the
**artifact's existence is the signal**. And **effort labels are banned** — effort isn't reliably
knowable, and a guess mis-steers scoping.

**Where design lives:** the design-doc is the `rfc` issue — **never** a committed `proposal-*.md`.
The only design docs in the tree are **durable architecture references for *shipped* features**
(`ARCHITECTURE.md`). When a feature ships, fold its durable design into `ARCHITECTURE.md` and
**close the `rfc`**.

### 9.1 Reopening an accepted gate — purge the body FIRST

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

**Why this is a hard rule and not a nicety.** A superseded design in the body does not read as
superseded — it reads as **the accepted design**, because that is what a body *is*. Everything
downstream trusts it: the next planning pass, an agent picking the issue up cold, a reviewer
checking whether the implementation matches. The correction is invariably in a comment, and
top-down readers never reach it. The failure is silent and it compounds: a plan written against a
withdrawn design looks exactly like a plan written against the live one.

Stashing the old body to a scratch file while you work is fine and often useful. **Delete the
stash when the new gate is accepted and the new body is written** — a lingering copy of a
withdrawn design is the same hazard one directory over.

The body stays a placeholder for the whole redo. It is repopulated only at acceptance, from the
accepted outcome — never patched incrementally as thinking evolves, which just recreates the
half-superseded state the purge exists to prevent.

### 9.2 Reconcile sources at every gate boundary, both directions

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

## 10. Documentation discipline

- **Design docs live as `rfc` issues, not files** (§9). Filing one is a small workflow: a dedup
  check against existing issues, the body template, and the epic cross-link.
- **Two roadmap docs**, both deferring to Issues as authoritative:
  - **`VERSION_ROADMAP.md`** — the *honest state* of the current release effort: situation →
    scope (locked) → complete → still deferred.
  - **`WHAT_IT_IS.md`** — an "is / isn't" account: per-feature guarantees *and* honest limits,
    with a standing *"verify maturity claims against the code"* and *"where the README
    over-promises, this doc wins."*
- **`CONTRIBUTING.md`** states the two-axis model, the label ladder + invariants, the design→plan→
  spec doctrine, and the RFC-as-issue rule. It's where a newcomer learns the system.

---

## 11. Operating disciplines

Standing rules that keep Issues the single, always-current source of truth:

- **Backlog lives in Issues — no markdown backlog.** No `TASKS.md` / `TODO.md` shadow list. Ask
  "what's next" with `gh issue list --state open` (filter by label / milestone), not a file.
  - **A reconciled local mirror is not a shadow backlog.** `pull` materializes Issues to
    `.pm-playbook/backlog/` so agents can read and edit them without a round trip per question.
    That is allowed, and the distinction is precise: **a second copy is a shadow backlog when it
    can disagree with Issues indefinitely.** This one cannot. It is gitignored rather than
    committed, so it is never a reviewable artifact competing with the issue; `pull` overwrites it
    from GitHub; and `push` refuses outright the moment both sides have moved, rather than merging
    or picking a winner. A `TASKS.md` has none of those properties — nothing overwrites it and
    nothing refuses on its behalf, so it drifts silently and forever. **If you find yourself
    hand-maintaining a file the tooling does not reconcile, that is the forbidden thing**,
    regardless of where it lives.
- **Auto-file issues for new work.** When you commit to a piece of work, `gh issue create` first
  (`tech-debt` for grounded gaps, `idea` for speculative features), *then* implement — don't wait
  to be asked.
- **Re-check the issue list each session.** State changes out-of-band; `gh issue list` at the
  start of relevant work so you're not acting on a stale view.
- **Proactively cross-link docs ↔ issues.** When new issues/epics give a home to claims scattered
  in docs, add the pointers **both directions** without waiting for permission — this is the
  *propagate* half of keeping sources aligned (run `sync-sources` at task boundaries).
- **Reconcile sources at every gate boundary, both directions** (§9.2). Task boundaries are the
  floor; gates are the ones that must never be skipped, because a gate's input is the previous
  gate's output and a stale claim there is built on rather than caught.
- **Keep the release-gate ledger current as you go** (§5.2). When a change touches an
  independently versioned asset, set that asset's row in the same pass — not at tag time.
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
7. Backfill: label the existing backlog along the ladder, assign milestones, and **enforce the
   invariants** (§3.2) — a `plan-next`+milestone collision is the #1 drift smell. Find every
   violation at once with `npx @hoodiecollin/pm-playbook check --all-states`.
8. Convert epic checklists to **native sub-issues** (§7.1).
9. **Wire the gates into CI** so the invariants survive the person who set them up:
   `check` on pull requests, `release-check <vX.Y.Z>` before a tag, and — if you keep an
   integration branch (§5.3) — `scope-check <pr>` on PRs targeting it.

---

## 13. Anti-patterns this model exists to prevent

- **A parallel decomposition scheme** (Priority/Size/Workstream fields, a labels convention, a
  Project field) → there is **one** model: milestone + labels + native sub-issues. A second axis is
  a second source of truth that drifts.
- **`plan-next` + a milestone on the same issue** (or `idea` + `plan-next`) → violates the
  invariants (§3.2); the item's commitment state becomes ambiguous.
- **An experiment on the release spine** → experiments produce decisions, not artifacts; they feed
  the spine, never ride it (§4). Never anchor a release theme on a spike's hoped-for result.
- **Time/effort estimates** driving scope; **effort labels** → effort isn't reliably knowable.
- **Demand/usage justifications** → prioritize on engineering merit (§11).
- **Coding before designing** → design-doc then implementation-plan then BDD RED→GREEN (§9).
- **Stale status-labels** (`has-design`/`needs-design`) → state is *derived*, not stickered.
- **Doc drift** → design lives as `rfc` issues; only shipped-feature architecture is committed.
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
- **A release obligation filed as ordinary `tech-debt`** → it reads as deferrable when it is the
  opposite; label it `release-gate` so "can we tag?" is a query, not a memory (§5.2).
- **A version-named integration branch, or one per upcoming version** → the publish gap is defined
  against a single registry and only one cycle can be in flight; a version in the branch name also
  encodes the schedule a second time, competing with the milestone (§5.3). One integration branch,
  version-agnostic, gated by `scope-check`.
- **Roadmap over-promising** → `WHAT_IT_IS.md` states limits and cedes authority to the code.
