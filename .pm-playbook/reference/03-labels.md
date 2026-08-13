<!-- Generated from PLAYBOOK.md §3. Do not edit; edit the playbook and rebuild. -->
<!-- Part of the pm-playbook doctrine. Full document: ../PLAYBOOK.md · Map: ../AGENT.md -->

## 3. Labels — the "what" axis

Labels are **self-documenting**: each label's *description* is the process. The bootstrap script
writes these descriptions for you.

### 3.1 The taxonomy (portable verbatim)

**Every work item carries exactly one of three type labels.** The type decides which gates it
takes, and therefore what its ladder rungs are called.

| Label | Color | Description (this text is the process) |
|---|---|---|
| `improvement` | `#0e8a16` | Work that makes the product better: features, refactors, performance, debt. Three gates: design → plan → impl. |
| `bugfix` | `#d73a4a` | A defect in behavior that already exists. Two gates: diagnose → fix. |
| `experiment` | `#a2eeef` | Work whose deliverable is a finding, not a shippable artifact. Two gates: research → evaluate. Never milestoned (§4). |

Then one modifier, one container, one release marker:

| Label | Color | Description |
|---|---|---|
| `hotfix` | `#b60205` | A bugfix in released behavior that cannot wait: bounded, warranted, on its own patch milestone (§5.6). Never alone — always with `bugfix`. |
| `epic` | `#6f42c1` | Umbrella tracking issue; decomposes via native sub-issues. Not a work type, and never carries gates of its own. |
| `release-gate` | `#b60205` | Blocks the tag: this milestone cannot be released until it is closed (§5.2). |

And **seven gate labels**, one per gate per type — `improvement:gate-1..3`, `bugfix:gate-1..2`,
`experiment:gate-1..2`. Their descriptions are in §9, because the description *is* the gate.

**Why the gate labels are type-prefixed** rather than a shared `gate-1`/`gate-2`/`gate-3` set: §3.1
makes the description the process, and `experiment:gate-2` ("the verdict…") and
`improvement:gate-2` ("the implementation plan…") describe genuinely different work. A shared label
could only carry one of those descriptions, so it would have to carry none.

#### What is deliberately absent

**No descriptor labels.** There is no `tech-debt`, `perf`, `config` or `legacy-audit`. All four
described *flavour*, which is what the body is for — and with one mandatory type label, a second
label saying "…and it is a perf one" re-creates the parallel-decomposition drift §13 exists to
prevent, on the axis most likely to be left stale.

**No maturity labels.** `idea` and `plan-next` are derived rungs now (§2), not labels. `rfc` is
gone entirely: the concept it named is gate 1, and it never described how it was used anyway —
there was no wider audience to request comment from.

**No stock GitHub labels.** `bug`, `documentation`, `enhancement`, `good first issue`, `help
wanted`, `question`, `duplicate`, `invalid` and `wontfix` are all removed on adoption. `bug` and the
two enhancement-shaped ones are merged onto their successors; the rest have GitHub-native
replacements — "closed as not planned" says what `wontfix` said, in the place a reader looks.

**No priority, severity, size, or effort.** §1's no-extra-fields rule, unchanged. Effort labels in
particular are banned: effort is not reliably knowable and a guess mis-steers scoping.

The **`surface:*`** delivery labels (§6) are the one open-ended set, because they name a repo's
actual shippable artifacts.

### 3.2 Label invariants (the integrity rules)

These keep the two axes clean and the derived views trivial. **Enforce them on every issue** —
`pm-playbook check` does, and each rule id below is what it reports.

- **Exactly one type label per work item** (PM010). Not zero, not two. An epic is a container
  rather than work, and a gate takes its type from its own label, so neither needs one.
- **`experiment` ⊕ milestone** (PM003). A spike feeds the spine; it never rides it (§4).
- **`release-gate` ⇒ milestone** (PM004), and **`release-gate` ⊕ `experiment`** (PM005). A gate
  blocks a *specific* tag, so it is meaningless without the milestone it blocks — and it is
  committed by definition, which a spike can never be. **An open `release-gate` on a milestone
  means that milestone cannot be tagged**, regardless of whether every feature on it is closed
  (§5.2).
- **`hotfix` ⇒ `bugfix` + a milestone, and `hotfix` ⊕ {`experiment`, `epic`}** (PM014). A hotfix is
  a *form* of bugfix, not a fourth type (§5.6).
- **A patch milestone holds one hotfix and its gates, nothing else** (PM015).

The structural rules live with the structures they govern: gate parentage and completeness in §9,
epic decomposition in §7.1.
