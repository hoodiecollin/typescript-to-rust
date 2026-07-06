# typescript-to-rust — agent entry point

## Where to look for "what to do next"

**GitHub Issues are the source of truth for the backlog.** Repo:
`hoodiecollin/typescript-to-rust` (private).

```
gh issue list                              # the whole backlog
gh issue list --label epic                 # the big themes
gh issue list --label deferral-graduation  # graduate-a-fail-loud-deferral tail
gh issue list --label needs-user-input     # blocked on Collin's design input
gh issue list --label has-design           # a complete design doc already exists
gh issue view <n>                          # tasks live in the issue body
```

Do **not** treat `docs/plan.md`'s "Next" section as the live todo list any more —
it's the historical status/architecture record. When you pick up work, start from
an issue, follow its task checklist, and cross-reference the design doc it names
(or write one if it's labeled `needs-design`).

### Label legend

- `epic` — large multi-part area; the body tracks sub-work.
- `needs-design` — no complete design doc yet; **design + impl-plan are the first tasks.**
- `has-design` — a complete design doc exists under `docs/work/**`; reference it, skip the design step.
- `needs-user-input` — **stop and get Collin's input during design** (see process rule below).
- `deferral-graduation` — turns an existing fail-loud residual into real support without weakening fail-loud.
- Area tags: `ownership` · `dialect` · `codegen` · `errors` · `async` · `closures` · `generators` · `control-flow`.

## Process rule: get Collin's input before designing deferral-graduations

**Many of the "graduate a fail-loud deferral" items are dialect-shape decisions,
not mechanical work.** For any issue labeled `needs-user-input` (and, by default,
anything touching the accepted dialect surface or the memory model):

1. Do the investigation and draft the design **options**, then
2. **pause and ask Collin** — surface the tradeoffs and get a decision — **before**
   writing the final `design.md` or any impl.

Do not silently pick a dialect/semantics direction and build it. A wrong guess here
is expensive to unwind because it ripples through the validator, HIR, and emitter.

## The rest

- **Process / workflow (spec-first BDD, oracle-driven TDD, no-barrel-files):**
  `.agents/AGENTS.md`.
- **Architecture, pipeline, memory-model decision, and shipped-status log:**
  `docs/plan.md`.
- **Design docs & specs per series:** `docs/work/<NNN-slug>/` (active) and
  `docs/work/_archive/` (shipped).
- Run everything from the repo root (`bun run check`, `bun run test`,
  `bun run typecheck`).
