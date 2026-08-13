<!-- Generated from PLAYBOOK.md §8. Do not edit; edit the playbook and rebuild. -->
<!-- Part of the pm-playbook doctrine. Full document: ../PLAYBOOK.md · Map: ../AGENT.md -->

## 8. The board is a view

The **backlog lives in Issues.** The Project board adds **saved views** — that's its only job.

**The board answers "what is being worked on", not "what stage is each item at".** That split is
forced rather than chosen: the ladder rung is computed from an item's children (§2), and a Project
filter cannot reach across the parent/sub-issue relation. What a filter *can* see is the gates
themselves, where the stage genuinely is a label — so the execution views are gate views.

| View | Layout | Filter / grouping | Answers |
|---|---|---|---|
| **Everything** | Table | *(none)* | The full backlog, gates included. |
| **Work items** | Table | *exclude every gate label* | The backlog as work, one row per item. |
| **Release spine** | Board | *group by Milestone*, gates excluded | "What are we committed to, by version?" |
| **Epics** | Table | `label:epic` | The epic-primary top level. |
| **Open gates** | Table | *any gate label* + `is:open` | Everything actively in progress, at its stage. |
| **Labs** | Table | `label:experiment` | The research track (off-spine). |
| **Hotfixes** | Table | `label:hotfix` | The patch line (§5.6). |
| **Release gates** | Table | `label:release-gate is:open` | "Can we tag?" (§5.2) |
| **Surface Board** *(multi-artifact repos)* | Board | *group by `surface:*` label* | Work by shippable surface. |
| **Execution** | Board | *group by Status* | Kanban, if you want one. |

Every work-item view **excludes gates**, for the same reason §7.2 does.

For the rung itself, use **`pm-playbook ladder`** — that is the query the board cannot be.

`Status` (Todo / In Progress / Done) is GitHub's native execution field — kept as a light in-flight
indicator, **not** a decomposition axis, and largely redundant now that an open gate says the same
thing more precisely. The filtered views are scriptable (`pm-playbook bootstrap`); the *grouped*
boards need a one-time group-by in the UI.
