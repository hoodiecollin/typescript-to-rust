# typescript-to-rust

A translator from a **strict subset of TypeScript** to **idiomatic Rust**
(Option A — real ownership, not `Rc<RefCell>`-everything). Written in TypeScript
on Bun; the generated Rust is judged by a real `cargo` toolchain, not by string
matching.

```bash
bun install
bun run ttr packages/compiler/sample.ts --run   # TS → Rust → compile → run
bun run check                                    # typecheck + rust tests + compiler tests
```

## What this is (and isn't)

It is a language-level translator for an explicitly-enforced TS dialect. It is
**not** "compile any TypeScript" — TS is unsound and garbage-collected, so a
total mapping to Rust's ownership model does not exist. Tractability comes from
restricting the input (see [docs/dialect.md](./docs/dialect.md)).

## Docs

- [docs/plan.md](./docs/plan.md) — goal, memory-model decision, pipeline, status.
- [docs/dialect.md](./docs/dialect.md) — the accepted input subset.
- [docs/architecture.md](./docs/architecture.md) — harness design, oxc gotcha,
  emitter invariants.

## Layout

- `packages/compiler/` — parser front-end, emitter, and the cargo-backed
  verification harness.
- `crates/ts-primitives/` — minimal Rust runtime (`TsAny`) for the rare
  constructs without a clean static mapping.

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](./LICENSE-APACHE))
- MIT license ([LICENSE-MIT](./LICENSE-MIT))

at your option. Unless you explicitly state otherwise, any contribution
intentionally submitted for inclusion in this project by you, as defined in the
Apache-2.0 license, shall be dual licensed as above, without any additional
terms or conditions.
