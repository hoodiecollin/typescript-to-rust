# compiler

TypeScript (strict dialect) → Rust translator. Run all commands from the **repo
root**.

## Compile a file

```bash
bun run ttr packages/compiler/sample.ts          # print RAW emitted Rust to stdout
bun run ttr packages/compiler/sample.ts --fmt    # rustfmt-normalize the output
bun run ttr packages/compiler/sample.ts -o out.rs  # write the .rs to a path
bun run ttr packages/compiler/sample.ts --emit   # write a sibling .rs next to the source
bun run ttr packages/compiler/sample.ts --check  # also cargo check it
bun run ttr packages/compiler/sample.ts --run    # also compile & run, show stdout
```

Emitter output is **raw by default** (faithful for inspecting what the emitter
produces); pass `--fmt` to run it through `rustfmt`. `--fmt` applies uniformly —
to stdout, to any file written (`-o`/`--emit`), and to what `--check`/`--run`
compiles. `-o` may be repeated and combines with `--emit`; when any file target
is given, stdout stays quiet and each resolved path is reported on stderr.

## Tests

```bash
bun run test        # compiler tests (cargo-backed oracle)
bun run typecheck   # tsc --noEmit
bun run check       # typecheck + rust tests + compiler tests
```

## Layout

- `src/ast.ts` — typed ESTree subset (the shape oxc-parser actually emits; see
  `docs/architecture.md` for why this isn't `@oxc-project/types`).
- `src/emitter/` — AST → Rust module string. Always emits a complete, compilable
  module; throws `UnsupportedError` on out-of-dialect input.
- `src/harness/` — the verification oracle: drives `cargo check`/`cargo run` and
  `rustfmt`, parsing structured diagnostics. This is what judges correctness.
- `rust-oracle/` — persistent crate the harness compiles into (gitignored build
  state).
- `tests/` — `harness.test.ts` (proves the oracle), `compiler.test.ts` (fixture
  COMPILES + differential BEHAVES), `fixtures/**` (dialect targets).

See `docs/` for the plan, dialect spec, and architecture notes.
