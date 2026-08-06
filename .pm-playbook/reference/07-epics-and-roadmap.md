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
alongside. Forward **status buckets are derived** from state + labels + milestone — and the label
invariants (§3.2) make each bucket a one-line filter:

| Bucket | Derivation (filter) |
|---|---|
| **Shipped** | closed + released (compact release cards; closed epics with children) |
| **Active** | scheduled (has a milestone) and/or in flight |
| **Planned** | `plan-next` (committed, unscheduled — and by invariant, milestone-free) |
| **Labs** | `experiment` or `rfc` |
| **Ideas** | `idea` |

Scope-filter out non-core `surface:*` labels (§6.1) so the core roadmap stays about the core.
