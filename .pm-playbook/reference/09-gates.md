<!-- Generated from PLAYBOOK.md §9. Do not edit; edit the playbook and rebuild. -->
<!-- Part of the pm-playbook doctrine. Full document: ../PLAYBOOK.md · Map: ../AGENT.md -->

## 9. Gates — the work item's decomposition

> **Nothing gets coded until the gates before it are closed. Each gate is its own sub-issue, so
> "what stage is this at?" is a fact about the tree rather than a reading exercise.**

A work item's body holds **the business, project or product need**, and stays as non-technical as it
can. The technical work lives in the gates beneath it. That is one artifact per issue, which is what
makes any of them trustworthy: an issue holding the need *and* the design *and* the plan *and* the
spec list is never in a state where a reader can rely on the whole body.

### 9.1 The gate sets

Each gate is a **native sub-issue** of its work item, labelled `{type}:gate-{n}`. **A closed gate
means approved.** Closing the last gate closes the work item, and the PR that lands the work should
close both.

**`improvement` — three gates**

| Gate | Label | Is |
|---|---|---|
| 1 | `improvement:gate-1` | **design (WHAT & WHY).** Problem, desired behavior, solution *shape*, alternatives, explicit non-goals. Solution-shaped, never code-shaped. Catches **conceptual** gotchas. |
| 2 | `improvement:gate-2` | **plan (HOW).** Files to touch, build order, dependencies and blockers, interfaces, and **the BDD scenarios to write**. Catches **execution** gotchas. |
| 3 | `improvement:gate-3` | **impl.** Write the scenarios as failing specs (**RED**), implement to **GREEN**, refactor under green. The specs *are* the acceptance criteria. |

**`bugfix` — two gates**

| Gate | Label | Is |
|---|---|---|
| 1 | `bugfix:gate-1` | **diagnose.** Reproduction, root cause cited to a file and line, blast radius. For a hotfix, also the warrant (§5.6). |
| 2 | `bugfix:gate-2` | **fix**, spec-first: the regression test fails before and passes after. |

**`experiment` — two gates**: research (the charter) and evaluate (the verdict). Both are specified
in §4.1, because for an experiment the gates *are* the lifecycle.

**Why it works:** each gate's output is the next one's input, so nothing is re-derived. Design kills
conceptual surprises; the plan kills execution surprises; RED locks intent as executable truth
before any implementation exists.

**Gate contents are unchanged from earlier versions of this model.** What a design or an
implementation plan should say is the same. Only where it lives moved — out of a body section that
nothing could query, into an issue that everything can.

### 9.2 Gates carry their parent's milestone

A gate is milestoned identically to its work item (PM011). Two things fall out of that, and both
were reasons to choose it:

- **`scope-check` keeps working with no special cases** (§5.3). A gate is an ordinary milestoned
  issue to PM008, so a PR closing one is gated exactly like a PR closing anything else.
- **Milestone progress reflects gate completion**, which is what makes the cycle legible mid-flight
  rather than binary. §2 states the caveat that comes with it.

The invariant matters in the direction people forget: **moving a work item to a different milestone
must move its gates too**, or the gates are stranded on the old one and every milestone-scoped query
silently under-reports.

### 9.3 Gates materialize lazily, as a complete set

**Gates are created by the tool, never by hand**, and always as a whole set — never one at a time.

| Type | Trigger |
|---|---|
| `improvement`, `bugfix` | **Mechanical**: the work item is milestoned *and* that milestone is the cycle in flight. Cycle rollover is therefore the moment the next batch of work gets its gates, all at once. |
| `experiment` | **By decision**: when work on it starts. An experiment never carries a milestone, so the mechanical trigger can never fire for it — an experiment with no gates means *not started*. |

**This asymmetry is deliberate and has to be documented as such**, or "why didn't my gates appear?"
becomes a recurring question with no answer in the docs.

```
pm-playbook materialize --yes                 # the cycle in flight
pm-playbook materialize --issue 42 --yes      # an experiment, by decision
```

**Why tool-only creation is load-bearing.** If a human could file a gate, "gate absent" would mean
either *not materialized yet* or *nobody wrote it*, and nothing could tell the two apart. That is
exactly the failure §5.2 describes for the asset ledger, where an absent row and a "no change" row
look identical and mean opposite things. Tool-only creation is what makes absence *mean* something,
and therefore what makes the completeness rule below worth having.

Two mechanisms close it, and §5.5 constrains both:

- **The command is idempotent and resumable.** Creating N sub-issues can fail partway, which is
  §5.5's "fail-closed needs a resume path" case exactly. Re-running materializes only what is
  missing, and *adopts* a gate that was created but never linked rather than making a second one.
- **The completeness rule needs a schedule, not only a push trigger.** "Every focused work item has
  its full gate set" (PM013) is a **continuously-true claim whose truth changes with no commit from
  anyone** — closing a milestone advances the cycle and instantly makes a new milestone's items
  non-compliant. §5.5 names this class directly: a push trigger answers *did we break it*; only a
  schedule answers *is it still true*. Wire `check` on a `schedule:` as well as on pull requests.

### 9.4 No status labels — state is the structure

There is no `has-design`, no `needs-design`, and no effort label. **State is derived from ground
truth**: does gate 1 exist, and is it closed? Is there a gate 2? Are the specs passing (read from
CI)? A status label is a claim a human must remember to update; **the artifact's existence is the
signal**.

Effort labels are banned outright — effort is not reliably knowable, and a guess mis-steers scoping.

### 9.5 Where design lives

The design is **the gate-1 issue** — never a committed `proposal-*.md`. The only design documents in
the tree are **durable architecture references for *shipped* features** (`ARCHITECTURE.md`). When a
feature ships, fold its durable design into `ARCHITECTURE.md`; the gate issue is already closed and
stays as the record of how the decision was reached.

### 9.6 A body states current truth only — purge as you amend

**The general rule, of which reopening a gate is one instance:**

> **An amendment replaces. The thing being superseded comes out in the same edit that puts the
> replacement in.** Not struck through, not annotated "see below", not left in place with a
> correction underneath.

**Why this is a hard rule and not a nicety.** A superseded paragraph does not read as superseded —
it reads as current, because that is what a body *is*. Everything downstream trusts it: the next
planning pass, an agent picking the issue up cold, a reviewer checking whether the implementation
matches. The correction is invariably in a comment, and top-down readers never reach it. The failure
is silent and it compounds, and it costs every parallel agent separately, because each one loads the
whole body and pays for the dead half.

Two shapes recur. **Superseded content accumulates**: a claim is disproved, a constraint turns out
to be an assumption, a number gets corrected — the correction lands in a new paragraph and the
original stays, so every later reader has to work out which half is live. And **justification
outgrows substance**: rationale gets written at the length it took to think rather than the length
it takes to convey, until the artifact stops being reviewable by a human and stops being usable by
an agent. **Rationale is proportionate to the decision it supports.**

This is about the **body**, which is the only surface that reads as current by default. Comments
remain the discussion record; nothing here deletes history.

#### Every body opens with a plain-English summary

**The first section of every work item and every epic is `### In plain English`** — two or three
sentences on what this is, for a reader who has never seen it. Structured content follows it;
rationale follows that.

The heading is **identical everywhere** rather than tuned per type, because it is read by tooling as
well as by people, and a per-type heading would push a type-to-heading table into every consumer and
break the moment a type is added. It is checked by **PM017**, on presence and position only — no
mechanism can tell a live paragraph from a dead one, and a length threshold measures the symptom
least correlated with the defect.

**Gates and `release-gate` issues are exempt from the slot**, though not from the purge rule above:
their bodies are seeded with mandated structure that already serves the purpose. An **epic is not
exempt** — it is read by the same tooling its children are.

#### Reopening an accepted gate

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

Stashing the old body to a scratch file while you work is fine and often useful. **Delete the
stash when the new gate is accepted and the new body is written** — a lingering copy of a
withdrawn design is the same hazard one directory over.

The body stays a placeholder for the whole redo. It is repopulated only at acceptance, from the
accepted outcome — never patched incrementally as thinking evolves, which just recreates the
half-superseded state the purge exists to prevent.

### 9.7 Reconcile sources at every gate boundary, both directions

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

---

### 9.8 Parallel agents — what they must be given, and what they may conclude

Point several agents at several issues at once and each reads only its own. It then confidently
proposes something that breaks, duplicates, or contradicts what a sibling issue already decided.
That is not a discipline failure. §1 bans a third decomposition axis and epics give hierarchy only,
so there is nowhere in the model to record that two issues constrain each other — **the agent is not
failing to look; there is nothing to look at.**

**Context is pushed, never fetched.** A rule telling agents to read their siblings first fails under
exactly the conditions that motivate it: an agent optimising its own narrow task skips a
discretionary read. So the fan-out step assembles the neighbourhood and puts it in the brief. An
agent is *given* its context.

**The neighbourhood is derived, never recorded.** From explicit `#N` references in either direction,
the epic parent and its other children, a shared surface, and a shared milestone. Nothing about a
relation is stored anywhere, so nothing can drift — the same argument §8 makes for the board. A
`related-to` label would be a third axis in disguise, needing its own invariant to stay honest and
decaying exactly like the `Priority`/`Size` fields §1 exists to ban.

**Breadth is complete; depth is rationed.** The neighbourhood arrives as two layers:

- **A roster naming every neighbour, never truncated.** This is the property that cannot be traded
  for size. An agent that does not know a neighbour exists is the failure being fixed, so anything
  not expanded is still listed, with an explicit count and the command that expands it.
- **Depth for the closest ring only**, composed of each neighbour's own §9.6 summary rather than its
  raw body. An excerpt says what a neighbour *contains*; a summary says what it is. Closed issues
  are roster-only — closed work is reference, not context.

**What a parallel agent may conclude.** An agent that can see the edge of its neighbourhood but not
all of it may produce **gate 1 material**: a design that states what it would disturb across that
neighbourhood. It may **not** jump to implementation across a neighbourhood it cannot fully see.
Two agents proposing conflicting designs for genuinely coupled issues is the expected outcome, and
declaring blast radius is what surfaces the conflict for a human — it does not resolve it, and it is
not meant to.

**The code map is written onto the issue at gate 2.** Entry points, call paths, files that must
change — each cited by path, and carrying the commit it was derived at. The next agent reads the map
instead of rediscovering it. A map is a **claim** about ground truth (§1) and therefore rots, so
§9.7's before-gate verify pass re-checks it. A stale map that reads as current is the §9.6 failure
in a new location.

**Relations neither issue's own summary can carry** — "these two must ship together" — belong on the
**epic**. That is the model's existing home for a relation between issues, with one owner and a body
rather than an append-only log.
