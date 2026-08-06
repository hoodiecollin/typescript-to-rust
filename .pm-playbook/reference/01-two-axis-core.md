<!-- Generated from PLAYBOOK.md §1. Do not edit; edit the playbook and rebuild. -->
<!-- Part of the pm-playbook doctrine. Full document: ../PLAYBOOK.md · Map: ../AGENT.md -->

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
