<!-- Generated from PLAYBOOK.md §13. Do not edit; edit the playbook and rebuild. -->
<!-- Part of the pm-playbook doctrine. Full document: ../PLAYBOOK.md · Map: ../AGENT.md -->

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
