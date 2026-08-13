<!-- Generated from PLAYBOOK.md §11. Do not edit; edit the playbook and rebuild. -->
<!-- Part of the pm-playbook doctrine. Full document: ../PLAYBOOK.md · Map: ../AGENT.md -->

## 11. Operating disciplines

Standing rules that keep Issues the single, always-current source of truth:

- **Backlog lives in Issues — no markdown backlog.** No `TASKS.md` / `TODO.md` shadow list. Ask
  "what's next" with `gh issue list --state open` (filter by label / milestone), not a file.
  - **Read the mirror, not one API call per question.** `pull` materializes Issues to
    `.pm-playbook/backlog/` — every body, comment, label, milestone and parent link as ordinary
    files. **When the mirror exists, it is where an agent reads the backlog**: "what is left in
    this release" and "what did we decide on #42" become a `grep` over local files instead of a
    round trip each, and reading twelve issue bodies over the API is twelve of them. `check
    --no-remote` lints the same mirror with the same issue-level rules.

    Three properties bound its use. It is **gitignored and machine-local**, so a fresh clone has no
    mirror and its absence means "not pulled here yet," never "no issues." It **goes stale** the
    moment anyone else moves an issue — `pull` again when it matters. And **reading is local while
    writing is not**: edit-then-`push`, which refuses outright when both sides moved, or go through
    `gh` directly. Never hand-edit a file and assume GitHub knows.
  - **A reconciled local mirror is not a shadow backlog.** The distinction is precise: **a second
    copy is a shadow backlog when it can disagree with Issues indefinitely.** This one cannot. It
    is gitignored rather than committed, so it is never a reviewable artifact competing with the
    issue; `pull` overwrites it from GitHub; and `push` refuses outright the moment both sides have
    moved, rather than merging or picking a winner. A `TASKS.md` has none of those properties —
    nothing overwrites it and nothing refuses on its behalf, so it drifts silently and forever.
    **If you find yourself hand-maintaining a file the tooling does not reconcile, that is the
    forbidden thing**, regardless of where it lives.
- **Auto-file issues for new work.** When you commit to a piece of work, `gh issue create` first —
  with exactly one type label, and a body that states the *need* rather than the solution — *then*
  implement. Don't wait to be asked. Leave it unmilestoned if it is speculative; that is what
  `idea` means now (§2), and it is derived rather than stuck on.
- **Never hand-create a gate.** `pm-playbook materialize` owns them (§9.3). Filing one by hand
  destroys the only thing that makes an absent gate meaningful.
- **Re-check the issue list each session.** State changes out-of-band; `gh issue list` at the
  start of relevant work so you're not acting on a stale view.
- **Proactively cross-link docs ↔ issues.** When new issues/epics give a home to claims scattered
  in docs, add the pointers **both directions** without waiting for permission — this is the
  *propagate* half of keeping sources aligned (run `sync-sources` at task boundaries).
- **Reconcile sources at every gate boundary, both directions** (§9.7). Task boundaries are the
  floor; gates are the ones that must never be skipped, because a gate's input is the previous
  gate's output and a stale claim there is built on rather than caught.
- **Keep the release-gate ledger current as you go** (§5.2). When a change touches an
  independently versioned asset, set that asset's row in the same pass — not at tag time.
- **When you write a rule, name where it fails** (§5.5). A rule stated in `CONTRIBUTING.md` with no
  enforcement point is enforced by whoever remembers it, under the most pressure, at the least
  recoverable step. Before calling a gate wired, say out loud what it is capable of failing — and
  if the honest answer is "nothing," it is a report, which is fine as long as it is labeled one and
  the gate lives somewhere else.
- **Prioritize on engineering merit, not demand.** Never justify building or deferring on "demand,"
  "usage," or "when users want it" — for a pre-launch product those signals *don't exist*, so
  leaning on them smuggles in data you don't have. Justify on **scope, risk, foundational
  sequencing** (does X unblock Y), **identity fit**, and the legitimate YAGNI test: *does generated
  code / another crate actually link this?* (an in-codebase-consumer question, never a market one).
