# 122 — `ttr facade`: generate a mirror-plugin facade from a Rust crate

Child of series **121** (plugin archetypes — the umbrella; issue #118). 121 locked
two things this series depends on: mirror-plugin facades are **generated, never
hand-written**, and the generator is a **TTR-core** `ttr` subcommand (the produced
artifacts are owned by a consumer's plugin package). This series designs that
subcommand. It consumes nothing from D1–D5 — it *produces their input* — so it can
land first.

## Decision (this series): extraction = rustdoc JSON

The facade must carry **resolved, complete** signatures: fully-qualified crate
paths, per-parameter borrow shapes, and resolved error types — across a crate whose
API is macro-generated and re-exported (candle). Only the compiler's own semantic
view supplies that. Three ways to obtain it were weighed:

1. **rustdoc JSON** (`cargo +nightly rustdoc -- -Zunstable-options --output-format json`)
   — rustc has already done name resolution, macro expansion, and alias resolution;
   we read the result. **Chosen.**
2. **`syn` + a hand-rolled resolver** — `syn` is purely syntactic: it cannot follow
   `pub use` re-exports, cannot expand macros (candle's `binary_op!`-generated
   `add`/`matmul` are invisible), and cannot resolve a `Result<T>` alias to its
   error type. Closing those gaps means reimplementing rustc's resolution per crate.
   **Rejected** — unresolved/partial facade.
3. **rust-analyzer as a library** (`ra_ap_*`) — a real semantic engine on stable,
   but a massive, also-unstable dependency, and Rust-side while TTR is TS-on-Bun.
   **Rejected** — heavier and worse-fit than the nightly-rustdoc tax it avoids.

The real cost of the choice is not the engine but rustdoc's **nightly + unstable
format** tax, handled below.

## Engine mechanics

- **Invocation.** Shell `cargo +nightly rustdoc -p <crate> -- -Zunstable-options
  --output-format json`, mirroring the offline-first `Bun.spawn(["cargo", …])`
  pattern already in `packages/compiler/src/harness/cargo.ts`. rustdoc writes
  `target/doc/<crate>.json`.
- **Parse in TypeScript.** The JSON is deserialized in TS — **no Rust-side
  dependency** (`rustdoc-types` is not needed; it is just a schema for the same
  JSON). Keeps the generator inside the existing Bun compiler.
- **Nightly is dev-time and scoped to this subcommand.** TTR pins no toolchain
  today (no `rust-toolchain.toml`); the stable oracle path is untouched. `ttr
  facade` is the *only* surface that needs nightly, and only when (re)generating a
  facade — never at a consumer's build/run time. **This is the one genuinely new
  toolchain requirement this series introduces; it is called out here rather than
  buried.**
- **Pin the `format_version`, fail loud on mismatch.** The rustdoc JSON carries a
  top-level `format_version`. The generator declares the single version it
  understands — **pinned to `57`** (emitted by `nightly-1.98.0`, dated 2026-06-19,
  the toolchain present when this series was grounded). A different `format_version`
  is a **fail-loud** error (TTR's spine), with a message naming both the expected and
  found version and the nightly toolchain that emits the expected one — never a
  best-effort parse of an unknown schema.

## Output artifacts

Per 121 §"Facade generation", two artifacts, written under `--out`:

1. **Types-only `.d.ts` facade** — `declare`d owned types (D2), namespaces for
   constructors/statics (D3), and method signatures. **No bodies** (Rust-authoritative;
   nothing Bun-executes it).
2. **Method table (`<crate>.facade.json`)** — the machine-readable contract the
   mirror expansion consumes. Per entry:
   - TS-visible name ↔ **fully-qualified crate call path** (e.g.
     `candle_core::Tensor::matmul`),
   - **receiver** shape (`&self` / `&mut self` / `self` / static),
   - **per-parameter borrow** shape (`&T` / `&mut T` / owned) — feeds **D5**,
   - **fallibility** + resolved **error-type path** (`Result<_, candle_core::Error>`)
     — feeds **D4**,
   - owned-type / namespace membership — feeds **D2/D3**.

## Mapping rules (rustdoc item → facade) — the design meat

| rustdoc item | Facade output |
|---|---|
| `pub struct` / `pub enum` (`Tensor`, `Var`, `Shape`) | owned TS type (D2); mapped type name ↔ crate path |
| unit-variant `enum` (`Device`, `DType`) | namespaced constants (D3) — `Device.Cpu → candle_core::Device::Cpu` |
| inherent `pub fn` with `&self` (`matmul`, `add`) | method signature; record receiver + param borrows + fallibility |
| associated `pub fn` / ctor (`Tensor::zeros`, `randn`) | namespaced static (D3) |
| return `Result<T, E>` | mark **fallible leaf**; record resolved `E` path (D4) |
| doc comments | **dropped by default** (`--with-docs` opt-in) — respects a consumer's no-comment policy on generated `.d.ts` |

**Re-exports (refined from ground truth).** A `pub use` appears as a `use` item
carrying `source` (the canonical path string) and a resolved `id`; `paths[id]` gives
`{ crate_id, path, kind }`, so the canonical path resolves even cross-crate. **But a
cross-crate re-exported type's *methods are not in the re-exporting crate's
`index`*** — they live in the *defining* crate's own rustdoc JSON (confirmed: the
fixture's `Gadget` re-export exposes the type id but none of its methods). Two
consequences for v1: (a) **intra-crate** re-exports (submodule → root) resolve fully
and are surfaced with methods; (b) for a **cross-crate** re-export, the generator
records the canonical type path but **fails loud** if asked to surface its methods
without also being pointed at the defining crate. Practically this means *target the
crate that **defines** the types* — for candle, `candle-core` (where `Tensor` is
defined), not an umbrella re-export crate. Multi-crate documentation + merge is a
later enhancement, not v1.

**Trait handling.** v1 surfaces **inherent methods** plus a **declared allowlist**
of traits (`--allow-trait <path>`, e.g. candle's `Module::forward`). Blanket/std
derives (`Debug`, `Clone`, `From`) are **not** surfaced as methods; `Clone` is noted
specially (a candle `Tensor` clone is a cheap `Arc` bump — see 121 §"Ownership fit").

**Generics / associated types.** candle's core `Tensor` is largely non-generic at
the type level (dtype is runtime), which keeps v1 tractable. Any item the generator
cannot fully resolve to a concrete facade shape — an unresolved generic method, an
associated type it can't ground, an unsupported trait — is **failed loud with the
exact rustdoc item path**, never emitted as `any` or a partial stub. The generated
facade is *always* a complete, resolved subset; unsupported items are **reported**,
not silently dropped or faked. (This is the generator-level analog of the emitter's
no-silent-`Any` rule.)

**Determinism.** Items are emitted in a stable order (sorted by crate path) so a
regeneration against the same crate/toolchain produces a byte-identical diff.

## CLI

```
ttr facade <crate>[@<version>] [--out <dir>] [--allow-trait <path>]... [--with-docs]
```

- `<crate>[@version]` — the crate to mirror (path or registry name; version pins the source).
- `--out <dir>` — where the `.d.ts` + `.facade.json` land (defaults to a conventional path).
- `--allow-trait <path>` — surface methods from this trait impl (repeatable).
- `--with-docs` — pass through doc comments (off by default).

## Scope guard (v1)

The generator is **general**, but its v1 **acceptance corpus is candle-shaped**:
enough of `candle-core` (`Tensor` + `Device`/`DType` + a couple of `nn` layers) to
prove the pipeline end-to-end and to be the resolved input the D1–D5 series build
against. Whole-crate coverage of arbitrary libraries is not a v1 goal; unmapped
items fail loud, so coverage grows honestly issue-by-issue.

## Fail-loud discipline (inherited)

Three fail-loud gates, all consistent with TTR's spine:

1. **`format_version` mismatch** → refuse to parse an unknown rustdoc schema.
2. **Unmappable item** (generic/unresolved/unsupported-trait) → refuse to emit a
   partial facade; report the item path.
3. **Toolchain absence** (no nightly rustdoc-json capability) → a clear error naming
   the required toolchain, not a silent empty facade.

## Dependencies / status

- **Parent:** 121 (#118). **Blocks:** consumers of the facade (D2–D5, the candle
  plugin) depend on this artifact; this series depends on none of them.
- **New requirement:** a **nightly** toolchain for `ttr facade` only (dev-time).
- **Status:** implemented (PR #120). `src/facade.ts` (generator core) + `src/facade-cli.ts`
  (CLI seam) + the `ttr facade` subcommand; FAC1–FAC15 green against the checked-in
  fixture plus a live nightly integration spec. Archive the series to
  `docs/work/_archive/` on merge.

## Ground-truth schema (rustdoc `format_version` 57 — captured)

Confirmed by capturing the fixture crate's rustdoc JSON
(`packages/compiler/tests/fixtures/facade/ttr-facade-fixture.rustdoc.json`). The
parser targets these encodings; recorded here so the impl doesn't re-derive them:

- **Top level:** `{ root, index, paths, external_crates, format_version, target }`.
  `index[id]` = documented items of *this* crate; `paths[id]` = `{ crate_id, path[],
  kind }` for any id incl. external; `external_crates[crate_id] = { name, … }`.
- **Re-export:** `{ inner: { use: { source, name, id, is_glob } } }`; resolve via
  `paths[id]` (cross-crate → `crate_id` ≠ 0).
- **Type alias:** `{ inner: { type_alias: { type: { resolved_path: { path, id,
  args } }, generics } } }` — the alias body is fully resolved, so a `Result<T>`
  return resolves through the alias id to `core::result::Result<_, Error(id)>`
  (fallibility + error path for D4).
- **Method:** `{ inner: { function: { sig: { inputs: [name, Type][], output },
  generics, header } } }`. Receiver = first input named `self`; `Type =
  { borrowed_ref: { is_mutable } }` → `&self` / `&mut self`, absent → owned/by-value.
  Params carry the same `borrowed_ref.is_mutable` borrow shape (D5). `inputs: []` =
  associated/static (no receiver) → namespaced (D3).
- **Generic reject (FAC11):** `function.generics.params` containing a `type` param
  → fail loud (lifetime-only params are fine).
- **Impl kind (FAC12):** the struct/enum's `impls[]` → `index[implId].inner.impl`;
  `impl.trait === null` = inherent (surface); `impl.trait.path` set = trait impl
  (surface only if `--allow-trait` names it). Macro-generated methods (e.g. `raw`)
  appear in the inherent impl's `items` — expansion is already applied (FAC6).

*(format_version 57 pinned; see §Engine mechanics. When the toolchain bumps the
format, the pin + this section move together in a follow-up.)*
