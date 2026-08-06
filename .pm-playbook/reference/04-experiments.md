<!-- Generated from PLAYBOOK.md §4. Do not edit; edit the playbook and rebuild. -->
<!-- Part of the pm-playbook doctrine. Full document: ../PLAYBOOK.md · Map: ../AGENT.md -->

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
