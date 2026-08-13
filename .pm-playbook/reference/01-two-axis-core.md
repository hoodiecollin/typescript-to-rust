<!-- Generated from PLAYBOOK.md §1. Do not edit; edit the playbook and rebuild. -->
<!-- Part of the pm-playbook doctrine. Full document: ../PLAYBOOK.md · Map: ../AGENT.md -->

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
