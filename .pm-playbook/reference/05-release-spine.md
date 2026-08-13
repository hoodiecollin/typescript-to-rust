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

Two things this does *not* waive:

- **The §5.2 asset ledger applies.** A patch publishes artifacts, so the stale-source-behind-a-
  correct-version failure is exactly as live as it is for a minor.
- **`release-check` is unchanged.** A patch milestone is an ordinary core milestone for gating.

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
