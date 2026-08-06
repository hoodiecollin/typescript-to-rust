# Work series — a frozen archive

**This directory no longer receives new work.** `_archive/` holds the numbered series
folders from the pre-2026-08 workflow, kept as the historical record of how each shipped
change was designed and spec'd. Nothing here is a live document, and nothing new should be
added.

## Where the workflow went

Design and planning moved onto GitHub Issues, per §9 of the
[pm-playbook](../../.pm-playbook/PLAYBOOK.md) doctrine this repo adopted. The three gates
are unchanged in substance — what changed is where the first two live.

| Old step | Now |
|---|---|
| `docs/work/<NNN>/design.md` | **Gate 1** — the design, on the issue (an `rfc` issue for a new proposal, or the design section of the issue that tracks the work) |
| `docs/work/<NNN>/specs.md` | **Gate 2** — the implementation-plan, on the same issue: files to touch, build order, blockers, interfaces, and **the BDD scenarios to write** |
| `research.md` / `scratchpad.md` | Issue comments, or a local scratch file that is never committed |
| Mock → RED specs → GREEN | **Gate 3**, unchanged. This is code discipline and it stays exactly as it was |
| Archive the folder | Close the issue into its milestone |

The full statement of the gates is in
[`.pm-playbook/reference/09-design-plan-spec.md`](../../.pm-playbook/reference/09-design-plan-spec.md);
the repo-specific version, including the two scope carve-outs for pure refactors and
pre-rule code, is in [`.agents/AGENTS.md`](../../.agents/AGENTS.md).

## Why it moved

A `design.md` in the tree is invisible to `gh issue list`. The series number and the issue
number were two independent identifiers for one piece of work, and keeping them in sync was
manual: an issue said "design doc: `docs/work/026-…/design.md` (complete — no design step
needed)" and the *only* thing making that true was someone remembering to update it.

The sharper failure is the one §9.1 names. When a design is superseded, the correction
lands in a comment or a status banner — and a banner at the top of a document does not stop
the document from reading as the accepted design, because that is what a document *is*.
Several of the series migrated out of here carried exactly such banners. On an issue, the
body is purged and replaced with an explicit withdrawal placeholder before the redo starts,
so there is no window in which a stale design reads as live.

## The active series at the time of the move

Each was migrated verbatim into the issue that tracks it, and its folder deleted — git
history holds the revisions.

| Series | Now |
|---|---|
| `026-rust-ast-printer` | #25 |
| `027-tslib-runtime-crate` | #126 |
| `029-library-method-catalog` | #51 |
| `120-public-release` | #104 |
| `121-plugin-archetypes` | #118 |

Settled architecture still lives in [`../plan.md`](../plan.md),
[`../architecture.md`](../architecture.md) and [`../dialect.md`](../dialect.md) — those are
durable references for shipped behavior, which §9 keeps in the tree.
