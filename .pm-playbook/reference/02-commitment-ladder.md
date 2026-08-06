<!-- Generated from PLAYBOOK.md §2. Do not edit; edit the playbook and rebuild. -->
<!-- Part of the pm-playbook doctrine. Full document: ../PLAYBOOK.md · Map: ../AGENT.md -->

## 2. The commitment ladder (the maturity gradient)

The labels encode one idea: work is ranked by *distance from shipped*. This **commitment ladder**
is the spine of the "what/maturity" axis:

```
  speculative       committed          scheduled           shipping             shipped
  ───────────       ─────────          ─────────           ────────             ───────
  label: idea   →   label: plan-next → milestone assigned → merged / closed    → GitHub Release
  (needs an RFC)    (unscheduled)      (drop plan-next)     (into the milestone)  (roadmap flips)
```

| Rung | Means | Promotion gate → next rung |
|---|---|---|
| **`idea`** | Speculative. Not committed. | **Gate 1:** an accepted **design-doc** (`rfc` issue — §9). |
| **`plan-next`** | Committed, but not yet scheduled to a version. | Assign a **milestone** (and **drop `plan-next`** — §3.2). |
| **milestone** | Scheduled into a specific release. | **Gate 2:** a reviewed **implementation-plan** → start work. |
| **In flight** | Being built (**Gate 3:** BDD specs RED → GREEN — §9). | Merge; the issue **closes into** its milestone. |
| **Closed-in-milestone** | Done in code, but roadmap reads *"pending release"*. | **Tag the GitHub Release** for the milestone. |
| **Released** | Shipped reality. | — |

Copy this framing into every milestone description:

> *"Issues close into this milestone until it is tagged; on the roadmap they read as 'pending
> release' until the vX.Y.Z GitHub Release exists."*

**Why it matters:** "done" is ambiguous. The ladder splits it into *code-complete* (issue closed)
and *shipped* (release tagged), so the roadmap never over-promises. (`experiment` is **not** a rung
on this ladder — it is off-spine entirely; see §4.)
