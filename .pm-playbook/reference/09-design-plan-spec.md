<!-- Generated from PLAYBOOK.md §9. Do not edit; edit the playbook and rebuild. -->
<!-- Part of the pm-playbook doctrine. Full document: ../PLAYBOOK.md · Map: ../AGENT.md -->

## 9. The design → plan → spec doctrine

> **Nothing gets coded until two artifacts exist, in series: a *design-doc*, then an
> *implementation-plan*. Both live as issues, never as committed files.**

Design and planning are **two distinct deliverables**. Doing them *in series before any code* is
what surfaces gotchas while they're cheap and makes the coding fast and unambiguous. Three gates:

- **Gate 1 — design-doc (WHAT & WHY).** An **`rfc` issue**: problem, desired behavior, solution
  *shape*, alternatives, and explicit **non-goals/limits**. Solution-shaped, not code-shaped.
  Catches **conceptual** gotchas. **Accepted →** drop `idea`, add `plan-next`.
- **Gate 2 — implementation-plan (HOW).** Written after the design is accepted and the item is
  scheduled, *before* code: files to touch, build order, dependencies/blockers, interfaces, and
  **the BDD scenarios to write**. Catches **execution** gotchas. Lives on the issue.
- **Gate 3 — BDD spec-first, RED → GREEN.** Write the scenarios as failing specs (**RED**),
  implement to **GREEN**, refactor under green. The specs *are* the acceptance criteria, so "done"
  is unambiguous and regression-proof.

**Why it works:** each stage's output is the next's input, so nothing is re-derived. Design kills
conceptual surprises; the plan kills execution surprises; RED locks intent as executable truth
before implementation exists.

**No `has-design` / `needs-design` / effort labels.** State is **derived from ground truth**: does
an accepted design-doc exist (past Gate 1)? an implementation-plan on the issue (Gate 2)? passing
specs (Gate 3, read from CI)? A status label is a claim a human must remember to update; the
**artifact's existence is the signal**. And **effort labels are banned** — effort isn't reliably
knowable, and a guess mis-steers scoping.

**Where design lives:** the design-doc is the `rfc` issue — **never** a committed `proposal-*.md`.
The only design docs in the tree are **durable architecture references for *shipped* features**
(`ARCHITECTURE.md`). When a feature ships, fold its durable design into `ARCHITECTURE.md` and
**close the `rfc`**.

### 9.1 Reopening an accepted gate — purge the body FIRST

Gates get reopened. New information lands, a constraint turns out to be an artifact of an
assumption, an implementation reveals the design was solving the wrong problem. Redoing a gate is
healthy; what is not healthy is what the issue body says while you redo it.

**The moment you decide to redo an accepted gate, the issue body is purged — before any new
thinking happens.** What replaces it is a placeholder and nothing else:

```markdown
> **Gate 1 is being redone (reopened YYYY-MM-DD).** The previously accepted design has been
> withdrawn and this body intentionally holds no design content. Do not plan against anything
> here. The live discussion is in the comments.
```

**Why this is a hard rule and not a nicety.** A superseded design in the body does not read as
superseded — it reads as **the accepted design**, because that is what a body *is*. Everything
downstream trusts it: the next planning pass, an agent picking the issue up cold, a reviewer
checking whether the implementation matches. The correction is invariably in a comment, and
top-down readers never reach it. The failure is silent and it compounds: a plan written against a
withdrawn design looks exactly like a plan written against the live one.

Stashing the old body to a scratch file while you work is fine and often useful. **Delete the
stash when the new gate is accepted and the new body is written** — a lingering copy of a
withdrawn design is the same hazard one directory over.

The body stays a placeholder for the whole redo. It is repopulated only at acceptance, from the
accepted outcome — never patched incrementally as thinking evolves, which just recreates the
half-superseded state the purge exists to prevent.

### 9.2 Reconcile sources at every gate boundary, both directions

Gates are exactly where stale claims do their damage: each gate's output is the next gate's input,
so a bad input is not caught, it is *built on*. **Run a source reconciliation before and after
every gate** — not only around "non-trivial" work, and not only around implementation.

- **Before a gate (verify):** enumerate every claim source touching the work — issue bodies and
  comments, design/architecture docs, agent memory, code comments, the release-gate ledger — and
  check each against ground truth (the code, history, actual runtime state). Fix or delete what
  has drifted *first*, so the gate is built on verified state.
- **After a gate (propagate):** push the accepted outcome outward — issue body, docs, memory,
  cross-linked issues — so the next gate and the next session start aligned.

This is deliberately expensive. It is worth it: the cost of a reconciliation pass is bounded and
paid once, while the cost of planning against a stale claim is unbounded and discovered late.
