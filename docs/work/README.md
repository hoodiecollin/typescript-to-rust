# Work series

Each unit of work is a numbered folder here holding its markdown docs, per the
spec-first workflow:

1. **Docs** — `research.md`, `scratchpad.md`, `design.md`, `specs.md`. Only
   `design.md` and `specs.md` are required; the rest are optional per scope.
   (Pure, behavior-preserving refactors need `design.md` only — no new specs.)
2. **Mock** — a mock interface of what the real impl will supersede.
3. **Specs** — transcribe `specs.md` into real BDD tests that call the mock;
   verify every new spec is **RED** before implementing.
4. **Impl** — build until all specs are **GREEN**.
5. **Archive** — move the finished series folder to `_archive/`. Follow-ups and
   enhancements get a **new** series; never grow an archived one.

Settled architecture still lives in `../plan.md` / `../architecture.md` /
`../dialect.md`; these series folders are the working record of a single change.
