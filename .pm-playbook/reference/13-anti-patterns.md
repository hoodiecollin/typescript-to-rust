<!-- Generated from PLAYBOOK.md §13. Do not edit; edit the playbook and rebuild. -->
<!-- Part of the pm-playbook doctrine. Full document: ../PLAYBOOK.md · Map: ../AGENT.md -->

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
