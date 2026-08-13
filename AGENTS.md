# Agent instructions

This is the harness-agnostic entry point. The full working rules live in two places, and
both are worth loading before you touch anything:

- **[`.agents/AGENTS.md`](.agents/AGENTS.md)** — the development rules: the spec-first
  workflow and its three gates, the cargo-backed oracle (never string-match emitted Rust),
  the no-barrel-files rule, and the memory-model decision.
- **[`CLAUDE.md`](CLAUDE.md)** — the same rules plus where to find "what to do next," and
  the standing rule about getting a decision before designing dialect-shape work.

The human-facing version of all of it is **[`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md)**.

**Three things that are load-bearing here:**

1. **The backlog is GitHub Issues.** Nothing in `docs/` schedules work — it holds
   durable references only ([`ARCHITECTURE.md`](docs/ARCHITECTURE.md),
   [`DIALECT.md`](docs/DIALECT.md), and the three process docs).
2. **Designs and implementation-plans live on the issue**, never as a committed
   `design.md`. If you reopen an accepted gate, purge the issue body first — a superseded
   design left in place reads as *the* design.
3. **Anything touching the accepted dialect surface or the memory model needs a decision
   from Collin before it needs code.** Draft the options with tradeoffs, then ask. A wrong
   guess ripples through the validator, the HIR and the emitter.

<!-- pm-playbook:begin -->
## Project management — pm-playbook v2.1.0

Issue tracking in this repo follows the **pm-playbook** two-axis model. The full doctrine is
vendored at `.pm-playbook/` and is authoritative; this block is only a summary.

**Before you create, label, milestone, or close an issue — read `.pm-playbook/AGENT.md`.**
It is a short router: load only the reference section relevant to what you are doing.

**The two axes, and nothing else, organize work:**
- **Milestone** = *when*. Assigning one means **committed**. *Focus* — the milestone being the
  cycle in flight — is what means scheduled. There is no label for "committed but unscheduled."
- **Labels** = *what kind*. Epics decompose via **native sub-issues**, never checkboxes and never
  a Project field.
- There are **no Priority / Size / Workstream fields**. Do not propose adding any.

**Every work item carries exactly one type, and the type decides its gates:**

| Type | Gates |
|---|---|
| `improvement` | design → plan → impl |
| `bugfix` | diagnose → fix (`hotfix` is a bounded form of this) |
| `experiment` | research → evaluate (never milestoned) |

Each gate is a sub-issue labelled `{type}:gate-{n}`. A closed gate means approved. The tree is
exactly three levels: epic → work item → gate.

**The commitment ladder is DERIVED from gate state — there are no maturity labels.** Walk the
gates in order; the first not closed decides the rung. Ask for it with `pm-playbook ladder`; no
GitHub filter can compute it.

**Invariants — violating one is a bug, not a style preference:**
- Exactly **one** type label per work item — never zero, never two (PM010).
- `experiment` never carries a milestone. A spike's deliverable is a finding; it feeds the
  release spine, it never rides it (PM003).
- **Never create a gate by hand** — `pm-playbook materialize` owns them and creates a complete
  set at once. A hand-made gate destroys the meaning of an absent one.
- A gate's milestone equals its parent's (PM011); an `epic` never carries gates (PM012).
- `release-gate` always has a milestone and never carries `experiment`. An open `release-gate`
  means its milestone **cannot be tagged** (PM004/PM005).
- A non-core `surface:*` issue never rides a core `v*` milestone (PM006).

**Read the backlog from the local mirror when it exists.** `.pm-playbook/backlog/` holds every
issue body and comment as files — grep it instead of spending an API round trip per question. It is
gitignored and machine-local, so its absence means "not pulled here yet", never "no issues", and it
goes stale as soon as anyone else moves an issue. Reading is local; **writing is not** — edit and
`push` (it refuses when both sides moved), or use `gh` directly.

```bash
npx @hoodiecollin/pm-playbook pull     # refresh the mirror (idempotent)
npx @hoodiecollin/pm-playbook check    # verify before opening a PR — exit 0 means compliant
```
<!-- pm-playbook:end -->
