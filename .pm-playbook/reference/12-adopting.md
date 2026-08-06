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
7. Backfill: label the existing backlog along the ladder, assign milestones, and **enforce the
   invariants** (§3.2) — a `plan-next`+milestone collision is the #1 drift smell. Find every
   violation at once with `npx @hoodiecollin/pm-playbook check --all-states`.
8. Convert epic checklists to **native sub-issues** (§7.1).
9. **Wire the gates into CI** so the invariants survive the person who set them up:
   `check` on pull requests, `release-check <vX.Y.Z>` before a tag, and — if you keep an
   integration branch (§5.3) — `scope-check <pr>` on PRs targeting it.
