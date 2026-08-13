<!-- Generated from PLAYBOOK.md §12. Do not edit; edit the playbook and rebuild. -->
<!-- Part of the pm-playbook doctrine. Full document: ../PLAYBOOK.md · Map: ../AGENT.md -->

## 12. Adopting this in a new repo — checklist

1. **Adopt locally.** `npx @hoodiecollin/pm-playbook init` — vendors this doctrine into `.pm-playbook/`,
   copies the issue templates, and wires the agent instruction files so the model reaches whatever
   harness your team uses. Add `--detect` to also write `CLAUDE.md`, `.cursorrules`, and friends.
   **Commit what it writes**: agents read it from the repo, so it must not be gitignored.
2. **Provision GitHub.** `npx @hoodiecollin/pm-playbook bootstrap --repo <owner>/<name> --project <N>` — the
   labels (with descriptions), a starter milestone, and the scriptable filtered views. Idempotent.
3. In the UI, set the **group-by** on the Release-spine / Surface / Execution boards (grouping
   isn't scriptable).
4. **If migrating an existing board: delete the `Priority`, `Size`, and `Workstream`/`Area`
   fields and every view that filters or groups by them**.
5. Define this product's **`surface:*`** labels — only if it ships more than one artifact
   (`bootstrap --surfaces "core,website"`).
6. Seed `VERSION_ROADMAP.md` + `WHAT_IT_IS.md` (§10) and put the two-axis model + doctrine into
   `CONTRIBUTING.md`.
6b. **If the product publishes artifacts its own built output depends on** (§5.2): decide *now*
   whether you publish eagerly or hold the gap off trunk, write the answer and the branch a PR
   targets into `CONTRIBUTING.md`, and wire the outside-repo reclose as a required check on the
   default branch. A repo that publishes nothing can skip this entirely.
6c. **Pick how branches land** (§5.4) — merge commit, squash, or rebase. Disable the other two in
   the repository settings so the merge button and `CONTRIBUTING.md` cannot disagree, and record
   the choice, the exact local command if work merges locally, and whether closing keywords reach
   your issues.
7. Backfill: give every existing issue **exactly one type label**, assign milestones to what you
   are committed to, and **enforce the invariants** (§3.2). Find every violation at once with
   `npx @hoodiecollin/pm-playbook check --all-states` — PM010 enumerates what is still untyped.
8. Convert epic checklists to **native sub-issues** (§7.1).
8b. **Materialize gates for the cycle in flight**: `npx @hoodiecollin/pm-playbook materialize --yes`.
   PM013 tells you when this is owed, and it is owed again at every cycle rollover — which is why
   step 9b's `schedule:` matters more than it looks.
9. **Wire the gates into CI** so the invariants survive the person who set them up:
   `check` on pull requests, `release-check <vX.Y.Z>` before a tag, and — if you keep an
   integration branch (§5.3) — `scope-check <pr>` on PRs targeting it.
9b. **For each gate you just wired, name what it can fail** (§5.5) — "before a tag" in step 9 is
   doing more work than it looks. A `release-check` job triggered by the same tag push as your
   release workflow runs *beside* it and blocks nothing; it needs a pre-release hook, a required
   status check, or a written acknowledgement that it is parallel-and-loud. Also give a
   `schedule:` to every check validating state you do not control (the reclose, advisories,
   credential expiry) — those go stale with no commit from you, and a push-triggered badge cannot
   tell *verified now* from *verified once*.
