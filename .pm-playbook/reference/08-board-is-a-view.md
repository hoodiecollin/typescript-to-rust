<!-- Generated from PLAYBOOK.md §8. Do not edit; edit the playbook and rebuild. -->
<!-- Part of the pm-playbook doctrine. Full document: ../PLAYBOOK.md · Map: ../AGENT.md -->

## 8. The board is a view

The **backlog lives in Issues.** The Project board adds **saved views** — that's its only job.
With Priority/Size/Area gone, views are driven by the two axes (labels + milestone) and Status,
and thanks to the invariants they're trivial filters:

| View | Layout | Filter / grouping | Answers |
|---|---|---|---|
| **Everything** | Table | *(none)* | The full backlog. |
| **Release spine** | Board/Table | *group by Milestone* | "What's scheduled, by version?" |
| **Epics** | Table | `label:epic` | The epic-primary top level. |
| **Planned** | Table | `label:plan-next` | Committed, not yet scheduled. |
| **Labs** | Table | `label:experiment,rfc` | The research track (off-spine). |
| **Ideas** | Table | `label:idea` | Speculative backlog. |
| **Surface Board** *(multi-artifact repos)* | Board | *group by `surface:*` label* | Work by shippable surface. |
| **Execution** | Board | *group by Status* | Kanban of in-flight work. |

`Status` (Todo / In Progress / Done) is GitHub's native execution field — kept as a light
in-flight indicator, **not** a decomposition axis. The filtered views are scriptable (§ bootstrap
script); the *grouped* boards (by Milestone / Surface / Status) need a one-time group-by in the UI.
