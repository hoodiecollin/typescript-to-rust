# Custom Rules

## Development Flow: TDD against the verification oracle

This project uses strict **Test-Driven Development**, but the test oracle is a
**real Rust toolchain**, not hand-written golden strings. Never assert emitted
Rust by string-equality against a `.rs` file (that approach was removed — it was
brittle and shipped invalid Rust). Instead:

1. **RED** — add or enable a fixture (`packages/compiler/tests/fixtures/**`, a
   `.ts` input) or a differential program, and watch it fail:
   - tier 1 (COMPILES): `cargo check` on the emitted Rust must currently fail or
     the emitter must throw `UnsupportedError`;
   - tier 2 (BEHAVES): TS-run-via-Bun and Rust-run output must differ / not run.
2. **GREEN** — implement the emitter/analysis until `cargo` accepts the output
   and (for complete programs) the differential stdout matches.

Use the harness (`src/harness`): `checkRust`, `runRust`, `formatRust`. The
emitter must always produce a **complete, compilable module** and must **fail
loudly** (`UnsupportedError`) on anything outside the dialect — never silently
emit `Any` or commented-out stubs.

## The spec-first workflow (required for every change)

Every change goes through these steps (see `docs/work/README.md`):

1. **Docs** — a numbered series under `docs/work/<NNN-slug>/`. Required:
   `design.md`, `specs.md`. Optional per scope: `research.md`, `scratchpad.md`.
2. **Mock** — a mock interface of what the real impl will supersede.
3. **RED specs** — transcribe `specs.md` into real BDD tests that call the mock;
   verify every new spec **fails** before implementing. (Tests must exercise the
   interface, so they genuinely signal when the spec is met — never fake-green.)
4. **GREEN** — implement until all specs pass.
5. **Archive** — move the finished series to `docs/work/_archive/`. Follow-ups get
   a **new** series; never grow an archived one.

Two scope carve-outs (decided 2026-07-02):
- **Pure refactors** (behavior-preserving, covered by existing green tests) need
  `design.md` **only** — no new specs, no mock/RED steps.
- **Pre-rule code** gets characterization specs backfilled **GREEN-from-start**,
  honestly labeled (a truly-RED spec is impossible against working impl).

## No barrel files

No re-export barrels — they hide the dependency graph and rot. Default to a flat
`<module-name>.ts`. Promote to a folder (`<name>/index.ts`) only when the single
file grows too large, and then `index.ts` must hold **real functionality**, not
re-exports. Outside files may import a folder's siblings directly (e.g.
`./harness/cargo` for types/constants) — that's preferred over a barrel.

## Run everything from the repo root

- `bun run test` — compiler tests (cargo-backed).
- `bun run typecheck` — `tsc --noEmit` on the compiler.
- `bun run rust:test` — `ts-primitives` unit tests.
- `bun run check` — typecheck + rust tests + compiler tests.
- `bun run ttr <file.ts> [--check|--run]` — compile a file to Rust.

## Memory model is decided: Option A (idiomatic borrows)

See docs/plan.md. Emit plain Rust ownership; `Rc<RefCell<T>>` is a last resort,
not the strategy. Keep `ts-primitives` minimal.
