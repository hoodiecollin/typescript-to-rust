# 122 — `ttr facade` generator: specs

BDD specs for the facade generator (child of series 121, issue #118). The design is
locked in `design.md`; this file transcribes observable behavior into specs and
closes with an impl-plan. Ground rule inherited: **fail loud** — the generator never
emits a partial, `any`, or best-effort facade; anything it cannot fully resolve is
reported with its exact source item path.

## Testing approach — pinned rustdoc-JSON fixtures + one live integration spec

A codegen tool's oracle is not TTR's usual TS-run-vs-Rust-run differential. Instead:

- **Deterministic specs run against a checked-in rustdoc-JSON fixture** — the
  captured `--output-format json` output of a small reference crate,
  **`ttr-facade-fixture`** (the generator's analog of `@ttr/plugin-leftpad`),
  exercising every mapping case below. This keeps parser/mapper specs hermetic and
  **nightly-free on CI**.
- **One live integration spec** actually shells `cargo +nightly rustdoc … --output-format
  json` on the fixture crate and asserts the captured fixture is still current;
  it **skips loudly** (not silently) when no nightly rustdoc-json toolchain is
  present, so the fixture cannot rot undetected where nightly *is* available.

The reference crate `ttr-facade-fixture` deliberately contains: a `pub use`
re-export, a macro-generated method, a `pub type Result<T> = …` alias, `&self` +
`&param` borrows, an owned enum with unit variants, an associated constructor, and
one **generic** method (the negative reject case).

## 1. CLI + invocation

- **FAC1** — `ttr facade <crate> --out <dir>` writes exactly two artifacts:
  `<crate>.d.ts` (types-only facade) and `<crate>.facade.json` (method table). No
  other files; `--out` is created if absent.
- **FAC2** — `<crate>@<version>` pins the source version; the emitted method-table
  header records the crate name + version + the rustdoc `format_version` it was
  generated from.
- **FAC3** — invocation shells `cargo +nightly rustdoc … -Zunstable-options
  --output-format json` via the offline-first spawn path; a missing nightly
  rustdoc-json capability **fails loud** naming the required toolchain (never an
  empty facade). *(Verified against a stubbed spawn in unit specs; exercised for
  real by the live integration spec.)*

## 2. Format-version pinning (fail-loud gate 1)

- **FAC4** — the generator declares the single `format_version` it understands;
  parsing a fixture whose top-level `format_version` differs **throws** a fail-loud
  error naming both the expected and the found version and the toolchain that emits
  the expected one. It does **not** attempt a best-effort parse.

## 3. Resolution (the capabilities `syn` cannot provide)

- **FAC5** — **re-export resolution.** A type surfaced via `pub use
  inner_crate::Widget` maps to its **canonical crate path** (`inner_crate::Widget`)
  in the method table and to a single owned TS type in the `.d.ts` — the re-export
  is followed, not emitted as an opaque alias.
- **FAC6** — **macro-generated methods.** A method produced by the fixture's
  `binary_op!`-style macro (no textual `fn` in source) **appears** in the method
  table with a resolved signature — proving expansion happened (a `syn` baseline
  would omit it).
- **FAC7** — **alias-resolved error type.** A method returning the crate's
  `Result<T>` alias is recorded as **fallible** with the **resolved** error path
  (`ttr_facade_fixture::Error`), not the surface token `Result` — this is the field
  **D4** consumes.

## 4. Borrow + shape mapping (feeds D5/D2/D3)

- **FAC8** — **borrow shapes.** For `pub fn combine(&self, rhs: &Widget, n: u32)`,
  the table records receiver `&self`, param `rhs: &` (borrow), and param `n: owned`.
  A `&mut self` method records `&mut self`.
- **FAC9** — **owned type (D2).** `pub struct Widget` becomes one `declare`d owned
  TS type whose name maps to `ttr_facade_fixture::Widget`.
- **FAC10** — **namespaced statics/ctors (D3).** An associated `pub fn
  Widget::empty()` and an enum unit variant `Mode::Fast` map to namespaced entries
  (`Widget.empty`, `Mode.Fast → …::Mode::Fast`), not free functions.

## 5. Fail-loud on unmappable items (gate 2)

- **FAC11** — a **generic** fixture method (`pub fn cast<T>(…)`) the generator
  cannot ground to a concrete facade shape **fails loud** with the item's exact
  rustdoc path — it is neither emitted as `any` nor silently skipped. *(This is the
  reference crate's negative reject case, per the corpus-coverage rule.)*
- **FAC12** — an **unsupported trait** method (a trait not passed via
  `--allow-trait`) is **absent** from the facade; passing `--allow-trait <path>`
  surfaces exactly that trait's methods and no others.

## 6. Output validity + determinism

- **FAC13** — the emitted `<crate>.d.ts` **type-checks under `tsc --noEmit`**
  (types-only, no bodies, no `any`).
- **FAC14** — doc comments are **omitted by default**; `--with-docs` includes them.
  (Default-off respects a consumer's no-comment policy on generated files.)
- **FAC15** — **determinism.** Two runs against the same fixture + pinned
  `format_version` produce **byte-identical** `.d.ts` and `.facade.json` (items
  sorted by crate path).

## Impl-plan

Ordered; each step gated by `bun run typecheck` and the relevant new specs going
RED→GREEN. No dialect surface is touched, so this proceeds straight through the
spec-first flow (no `needs-user-input` gate).

1. **Reference crate** — add `crates/ttr-facade-fixture` covering every §3–§5 case
   (re-export, macro method, `Result` alias, borrows, enum, ctor, generic reject).
2. **Capture fixture** — check in its rustdoc JSON (`--output-format json`) as the
   hermetic test input; record the nightly toolchain + `format_version`.
3. **Mock** — a `FacadeGenerator` interface (`generate(rustdocJson, opts) →
   { dts, table }`) plus the CLI seam, superseded by the real impl.
4. **RED specs** — transcribe FAC1–FAC15 against the mock; verify each fails.
5. **Parser/resolver** — deserialize rustdoc JSON in TS; `format_version` gate
   (FAC4); item index + path resolution (FAC5).
6. **Mapper** — items → owned types / namespaces / method table with borrow +
   fallibility (FAC6–FAC10); fail-loud gates (FAC11–FAC12).
7. **Emitter** — `.d.ts` + `.facade.json`, sorted/deterministic (FAC13–FAC15).
8. **CLI wiring** — `ttr facade` subcommand + offline-first nightly spawn (FAC1–FAC3);
   the live integration spec.
9. **GREEN** — all FAC specs pass; `bun run check` clean.
