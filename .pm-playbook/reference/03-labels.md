<!-- Generated from PLAYBOOK.md §3. Do not edit; edit the playbook and rebuild. -->
<!-- Part of the pm-playbook doctrine. Full document: ../PLAYBOOK.md · Map: ../AGENT.md -->

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
