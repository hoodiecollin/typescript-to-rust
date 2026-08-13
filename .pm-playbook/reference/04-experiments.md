<!-- Generated from PLAYBOOK.md §4. Do not edit; edit the playbook and rebuild. -->
<!-- Part of the pm-playbook doctrine. Full document: ../PLAYBOOK.md · Map: ../AGENT.md -->

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
