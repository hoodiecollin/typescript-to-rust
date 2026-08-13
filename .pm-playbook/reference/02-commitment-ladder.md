<!-- Generated from PLAYBOOK.md §2. Do not edit; edit the playbook and rebuild. -->
<!-- Part of the pm-playbook doctrine. Full document: ../PLAYBOOK.md · Map: ../AGENT.md -->

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
