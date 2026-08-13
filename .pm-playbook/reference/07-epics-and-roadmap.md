<!-- Generated from PLAYBOOK.md §7. Do not edit; edit the playbook and rebuild. -->
<!-- Part of the pm-playbook doctrine. Full document: ../PLAYBOOK.md · Map: ../AGENT.md -->

## 7. Epics & the roadmap view

### 7.1 Epics decompose via native sub-issues

An **`epic`** is an umbrella issue and a **top-level container that MAY span releases** — don't
force it to be atomic; its children ship incrementally, each carrying **its own milestone**.

- **Children are linked as GitHub *native sub-issues*** (`Parent issue` / `Sub-issues progress`;
  `gh api repos/OWNER/REPO/issues/N/sub_issues`, POST needs the child's REST `id`, not its
  number). **Not** task-list checkboxes (secondary, drift-prone) and **not** a Project field.
- **Standalone issues** (bug fixes, one-offs with no epic parent) are top-level too.

**An epic never carries gates of its own** (PM012). An epic spans releases while its children ship
incrementally, so a gate on an epic would be approving a design for work that has not been
decomposed yet. Gates belong to work items, one level down.

That gives the tree **exactly three levels, and there is no fourth**: an epic holds work items, a
work item holds gates, and a gate holds nothing (PM105). The cap is not an implementation limit —
it is what keeps "where does this live?" answerable without reading the whole tree.

Epic body shape (skeleton in `.github/ISSUE_TEMPLATE/epic.md`):

1. **`> ## ✅ Decisions locked (YYYY-MM-DD)`** — a blockquoted block of settled decisions at the
   top, each with a ✅ and a one-line rationale; supersedes stale discussion below it.
2. **Summary** — what it delivers, with a **release-blocking** flag if applicable.
3. **Current state (ground truth)** — where the code actually is *right now*.
4. **Children** — linked as native sub-issues (the "Sub-issues progress" bar rolls them up).
5. **Upstream / downstream** — relationships to other epics.

### 7.2 The roadmap is derived, EPIC-PRIMARY

The roadmap (e.g. a website `/roadmap` page) is **computed from the two axes + native sub-issue
structure**, never maintained by hand. Epics are the top-level unit; standalone issues sit
alongside.

**The buckets are computed, not filtered — and that is a change from earlier versions of this
model.** When the rungs were labels, each bucket was a one-line GitHub filter. They are derived from
gate state now (§2), and a bucket like "past design" is a property of a work item computed from its
*children*, which no issue search or Project filter can express. So the roadmap generator computes
them, from `pm-playbook ladder --json`:

| Bucket | Derivation |
|---|---|
| **Shipped** | closed + released (compact release cards; closed epics with children) |
| **Active** | milestone == the cycle in flight (§5.3) — this is what *scheduled* means now |
| **Committed** | has a milestone, but not the current one |
| **Labs** | `experiment` |
| **Ideas** | rung is `idea` — no gate 1 and no milestone |

**Gates are structure, not roadmap content: exclude them.** A three-item milestone whose gates all
rendered would show as twelve rows and read as four times the work.

Scope-filter out non-core `surface:*` labels (§6.1) so the core roadmap stays about the core.
