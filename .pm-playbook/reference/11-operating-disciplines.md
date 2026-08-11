<!-- Generated from PLAYBOOK.md §11. Do not edit; edit the playbook and rebuild. -->
<!-- Part of the pm-playbook doctrine. Full document: ../PLAYBOOK.md · Map: ../AGENT.md -->

## 11. Operating disciplines

Standing rules that keep Issues the single, always-current source of truth:

- **Backlog lives in Issues — no markdown backlog.** No `TASKS.md` / `TODO.md` shadow list. Ask
  "what's next" with `gh issue list --state open` (filter by label / milestone), not a file.
  - **A reconciled local mirror is not a shadow backlog.** `pull` materializes Issues to
    `.pm-playbook/backlog/` so agents can read and edit them without a round trip per question.
    That is allowed, and the distinction is precise: **a second copy is a shadow backlog when it
    can disagree with Issues indefinitely.** This one cannot. It is gitignored rather than
    committed, so it is never a reviewable artifact competing with the issue; `pull` overwrites it
    from GitHub; and `push` refuses outright the moment both sides have moved, rather than merging
    or picking a winner. A `TASKS.md` has none of those properties — nothing overwrites it and
    nothing refuses on its behalf, so it drifts silently and forever. **If you find yourself
    hand-maintaining a file the tooling does not reconcile, that is the forbidden thing**,
    regardless of where it lives.
- **Auto-file issues for new work.** When you commit to a piece of work, `gh issue create` first
  (`tech-debt` for grounded gaps, `idea` for speculative features), *then* implement — don't wait
  to be asked.
- **Re-check the issue list each session.** State changes out-of-band; `gh issue list` at the
  start of relevant work so you're not acting on a stale view.
- **Proactively cross-link docs ↔ issues.** When new issues/epics give a home to claims scattered
  in docs, add the pointers **both directions** without waiting for permission — this is the
  *propagate* half of keeping sources aligned (run `sync-sources` at task boundaries).
- **Reconcile sources at every gate boundary, both directions** (§9.2). Task boundaries are the
  floor; gates are the ones that must never be skipped, because a gate's input is the previous
  gate's output and a stale claim there is built on rather than caught.
- **Keep the release-gate ledger current as you go** (§5.2). When a change touches an
  independently versioned asset, set that asset's row in the same pass — not at tag time.
- **Prioritize on engineering merit, not demand.** Never justify building or deferring on "demand,"
  "usage," or "when users want it" — for a pre-launch product those signals *don't exist*, so
  leaning on them smuggles in data you don't have. Justify on **scope, risk, foundational
  sequencing** (does X unblock Y), **identity fit**, and the legitimate YAGNI test: *does generated
  code / another crate actually link this?* (an in-codebase-consumer question, never a market one).
