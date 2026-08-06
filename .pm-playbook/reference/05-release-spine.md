<!-- Generated from PLAYBOOK.md §5. Do not edit; edit the playbook and rebuild. -->
<!-- Part of the pm-playbook doctrine. Full document: ../PLAYBOOK.md · Map: ../AGENT.md -->

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
