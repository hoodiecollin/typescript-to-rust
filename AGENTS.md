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
## Project management — pm-playbook v1.2.0

Issue tracking in this repo follows the **pm-playbook** two-axis model. The full doctrine is
vendored at `.pm-playbook/` and is authoritative; this block is only a summary.

**Before you create, label, milestone, or close an issue — read `.pm-playbook/AGENT.md`.**
It is a short router: load only the reference section relevant to what you are doing.

**The two axes, and nothing else, organize work:**
- **Milestone** = *when* (a version release — the release spine). Assigning one means "scheduled."
- **Labels** = *what kind / how committed*. Epics decompose via **native sub-issues**, never
  checkboxes and never a Project field.
- There are **no Priority / Size / Workstream fields**. Do not propose adding any.

**Invariants — violating one is a bug, not a style preference:**
- `plan-next` and a milestone never coexist. Assigning a milestone means dropping `plan-next`.
- `idea` and `plan-next` never coexist.
- `experiment` never carries `idea`, `plan-next`, or a milestone. A spike's deliverable is a
  decision; it feeds the release spine, it never rides it.
- `release-gate` always has a milestone, and never carries `idea` / `plan-next` / `experiment`.
  An open `release-gate` means its milestone **cannot be tagged**.
- A non-core `surface:*` issue never rides a core `v*` milestone.

**Verify before opening a PR** — exit code 0 means compliant:

```bash
npx @hoodiecollin/pm-playbook check
```
<!-- pm-playbook:end -->
