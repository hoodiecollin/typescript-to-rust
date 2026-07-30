# 121 — Plugin archetypes: mirror (Rust-authoritative) vs macro (TS-authoritative)

Design / doctrine. **Extends series 110** (the plugin system, epic #95) along a new
axis. This series does **not** ship an implementation; it establishes the
organizing principle for how the plugin contract grows, and sketches its first
*mirror-archetype* client — a `candle` plugin authored for the voidloop project.
Specs + impl are gated behind a greenlight on the contract deltas in §5 (each of
which is plausibly its own follow-up series).

## Summary — the thesis

Series 110 shipped one shape of plugin: a TS facade call that **expands** to a
core-HIR call into a Rust crate (`@ttr/plugin-leftpad` → `ttr_plugin_leftpad::left_pad`).
Its correctness is judged by the **differential oracle** — the same TS run under
Bun must match the emitted Rust run under cargo. That model is correct *for that
kind of plugin* and quietly wrong for another kind. The distinction is not a
detail; it is a **second axis of the plugin contract**:

> A plugin's **oracle belongs on whichever side holds the source of truth.** Which
> side that is determines everything else about the plugin's shape.

Two archetypes fall out:

- **Macro plugin (TS-authoritative)** — the *TS* interface is the spec; it
  **expands one-to-many** into rich Rust the author never sees. Oracle: Bun-diff.
  This is what 110 shipped. `leftPad`'s TS body is authoritative *because JS
  `padStart` is its specification*.
- **Mirror plugin (Rust-authoritative)** — a *Rust crate* is the spec; the TS side
  is a **~1:1 typed shadow** of that crate's API. Oracle: the emitted Rust
  compiles and runs against the real crate, checked against the **crate's own**
  known-good values. `candle`'s TS facade is authoritative *nowhere* — candle-in-Rust
  is the truth.

Naming both archetypes — and, critically, refusing to force a mirror plugin
through the macro plugin's Bun-diff oracle — is the whole of this series.

## Background: what 110 assumes, and where it breaks

110's differential oracle assumes the TS side is a **faithful, runnable
specification** of the intended behavior. That holds when the *semantics are
defined in TS/JS terms* (string ops, array ops, `padStart`): Bun-running the TS
*is* the ground truth, so `TS-output == Rust-output` is a meaningful equality and
any divergence is a real transpiler bug.

It breaks the moment the source of truth is a Rust crate the TS is *imitating*:

1. **Parity becomes a standing maintenance contract.** A hand-written TS reimpl
   (e.g. voidloop's `ml-core`, a rough TS mirror of `candle`) must be kept
   bit-aligned with the crate forever, or the differential test flags the *reimpl's*
   drift as if it were a transpiler bug. That is exactly backwards — the reimpl is
   the *less* authoritative artifact.

2. **For floating-point numeric libraries, the equality is not even
   well-defined.** Tensor results depend on reduction order, FMA contraction, and
   BLAS kernel choice. candle-in-Rust and *any* TS reimplementation diverge in the
   last ULPs **even when both are correct.** A bit-exact `TS == Rust` diff is
   therefore impossible in principle, and a tolerance-based diff is precisely where
   real bugs hide. The differential oracle is **semantically ill-defined** for such
   a library, independent of how good the TS reimpl is.

Point 2 is the load-bearing justification: it is not that the Bun oracle is
*expensive* here, it is that **"equality" is the wrong relation.** So a mirror
plugin must get its correctness from the authoritative side (the crate), not from a
TS re-execution.

## The core principle — oracle-follows-authority

|                       | **Macro plugin** (110, `leftpad`)           | **Mirror plugin** (this series, `candle`)       |
|-----------------------|---------------------------------------------|-------------------------------------------------|
| Source of truth       | The **TS** interface (JS semantics)         | The **Rust crate**                              |
| Authority direction   | TS → Rust                                    | Rust → TS                                        |
| TS side is…           | a runnable spec (real behavior under Bun)    | a **types-only facade** shadowing the crate API  |
| Expansion cardinality | one-to-many (a *macro* into rich Rust)       | ~1:1 (call → crate call, type → crate type)     |
| Oracle                | **Bun-diff** (TS-run == Rust-run)            | **cargo-run against the crate, checked vs the crate's golden values** |
| What "faithful" means | Rust reproduces JS behavior                  | TS reproduces the crate's *interface*           |

Both archetypes keep 110's spine **unchanged**: recognize-by-specifier → `expand`
to **core HIR only** → an **explicit, enumerated accept-set**, with the emitter
total and fail-loud. They differ solely in *which side truth flows from*, and hence
where the oracle sits and whether the TS facade needs a runnable body.

## The two archetypes, precisely

### Macro (shipped in 110) — TS-authoritative

- **Recognizes** owned specifier calls; **expands** one call into arbitrarily rich
  core HIR (today one crate call; in general a subtree).
- **TS ships a real, runnable body** that *is* the specification (the corpus runs
  it under Bun as the oracle baseline).
- **Right when** you deliberately want to *hide* Rust-side complexity behind a
  small TS surface — declare a simple interface that expands, macro-like, into rich
  Rust constructs and patterns. (This is where the discussion's "value-facade",
  "model-as-data / eDSL", and "trace-to-graph" options belong — all TS-authoritative.)

### Mirror (this series) — Rust-authoritative

- **Recognizes** owned specifier types *and* calls; **expands** ~1:1 into
  fully-qualified crate call/type nodes.
- **TS ships a types-only facade** (`declare`d signatures, no bodies) whose shape is
  *derived from the crate's API*, ideally generated rather than hand-mirrored.
- **Oracle is the crate**: the emitted Rust must `cargo`-compile and run, and its
  output is checked against values the **crate itself** produces (a golden/snapshot
  oracle), never against a Bun re-execution of a TS reimpl.
- **Right when** the plugin's whole job is to *be* the crate in TS clothing —
  faithful pass-through, not abstraction.

## The contract deltas a mirror plugin needs

Each is a **crate-agnostic generalization** of a capability that today only
`@ttr/std`'s in-tree `SPECIAL_LOWERED` lane enjoys. Promoting them to *declarable
contract surface* is what keeps a mirror plugin a **Tier-2 package** rather than an
in-tree special case — candle becomes the *first client* of a richer contract, not
a bespoke lane.

- **D1 — Rust-authoritative oracle mode.** A plugin may declare its corpus is
  validated by *cargo-run-against-crate golden values*, not Bun-diff. TTR already
  requires emitted Rust to "compile and run"; this only swaps the **comparison
  baseline**. A consequence: such a plugin's TS side may be **types-only** (no
  runnable body), because nothing Bun-executes it.

- **D2 — Type-intrinsic declaration.** A plugin may declare owned **types that
  flow** through bindings and signatures, mapping a TS type name to a crate type
  path (`Tensor → candle_core::Tensor`). This generalizes std's `JsonValue` /
  `Writer` / `HttpResponse` intrinsics onto the declarable seam. The type oracle
  (series 099/113) resolves the declared type; contrast 113's deliberate exclusion
  of std — see §"fail-loud" for why declaration, not auto-inference, keeps that
  exclusion honest.

- **D3 — Namespace declaration.** A plugin may declare namespaced constructors /
  statics (`candle.Tensor.zeros(…)`), generalizing std's `fsAsync` / `http`
  namespaces.

- **D4 — Fallible-leaf registration + non-`String` error type.** A plugin may
  register its calls as **fallible leaves** feeding the existing 049 fallibility
  fixpoint, and declare the error type (`candle_core::Error`) rather than today's
  hardcoded `String`. Generalizing the fixpoint's error type off `String`-only is a
  latent TTR win regardless of this series.

- **D5 — Per-method borrow/ownership table.** A mirror plugin declares each
  method's borrow shape (`a.matmul(&b)`) as **data derived from the crate's
  signatures**, rather than relying on ownership inference to reverse-engineer it.
  Faithful mirror ⇒ borrows are *declared, not divined*. (candle's regular
  `&Rhs`-taking binary-op convention makes this table mechanical.)

## How fail-loud + emitter totality survive

Unchanged from 110, and the discipline is the same one 113 used to justify keeping
std out of auto-inference:

- **Explicit, enumerated accept-set.** A mirror plugin models a *closed* method/type
  table (for candle, generated from the crate's API). **Any unmodeled method or
  type fails loud** (`UnsupportedError` / `DialectError`). There is **no
  auto-inference of the crate's surface** — the danger 113 guarded against (a
  fallible, unmodeled shape silently slipping past the gate) is avoided because
  membership is declared, not inferred.
- **Still expand-to-core-HIR.** A mirror expansion produces fully-qualified crate
  `call`/type nodes — HIR the emitter already handles. The emitter gains **no** new
  case; totality is preserved exactly as in 110 (the opaque `"plugin"` node still
  only ever *asserts* if it survives expansion).
- **No text emit.** The Tier-3 escape hatch stays dropped for both archetypes.

## First client — the `candle` mirror plugin (voidloop)

Motivating example; the plugin package itself lives in the consuming project
(voidloop), not in this repo.

- **Specifier(s):** the plugin owns candle's TS entry specifier; recognition is
  specifier-anchored per 110 §2.
- **TS facade:** a **types-only** shadow of `candle` 0.8.0 (`Tensor`, `Var`,
  `Device`, `DType`, `Shape`, the `nn` layers), **generated** by a `ttr` CLI
  subcommand pointed at the crate (see §"Facade generation") so it cannot drift by
  hand.
- **Method table (D5) + fallibility (D4):** each `Tensor` method maps to its crate
  call with declared borrow shape and `Result<_, candle_core::Error>` fallibility,
  threaded through the 049 fixpoint.
- **Crate:** a thin `ttr-candle` (or a direct re-export of `candle-core`) declared
  in the oracle manifest and warmed via `ensureDepsWarm`, per 110 §5.
- **Oracle (D1):** emitted Rust compiles + `cargo`-runs against real candle; results
  checked against candle-computed golden values. **`ml-core` never runs in this
  loop.**
- **Ownership fit:** candle `Tensor` is `Arc`-backed and its API is largely
  pure-functional over immutable tensors, so any `.clone()` the Option-A ownership
  pass inserts at a move is **cheap and semantically correct** — candle is
  unusually friendly to idiomatic-borrow output.
- **Scope guard:** **inference forward-pass only** for v1. candle's stateful
  training surface (`VarMap`, optimizers, autograd loop) is explicitly out of scope
  and is a later, separate question.

### Facade generation — a new `ttr` subcommand (decided)

The mirror facade is **generated, never hand-written** — hand-mirroring is the very
drift a mirror plugin exists to eliminate. TTR ships a CLI subcommand that is
pointed at a Rust crate and emits the plugin's TS side:

```
ttr facade <crate>[@<version>] [--out <dir>]
```

It reads the crate's **public API** (candidate mechanisms, to be decided in the
generator's own series: `cargo doc --output-format json` / rustdoc JSON, or a `syn`
pass over the source) and emits:

- the **types-only `.d.ts` facade** (D2/D3 — the owned types, namespaces, and method
  signatures as `declare`d shapes with no bodies), and
- the **method table** the mirror expansion consumes (D4/D5 — per-method crate call
  path, borrow shape, and fallibility), derived from the crate signatures.

Regeneration against a new crate version is the *only* supported way the facade
changes, so the TS side cannot silently diverge from the crate. This subcommand is
a TTR-core deliverable (it produces artifacts a consumer's plugin package then
owns) and is plausibly its own series under the D1–D5 greenlight.

### Cross-repo consequence: `ml-core` is demoted, not deleted

voidloop's `ml-core` (a rough TS mirror of candle) stops being either the type
source *or* the oracle for the plugin. It is **demoted from oracle to optional,
non-authoritative preview**: a fast Bun sketch path for iterating on architecture
without a Rust toolchain, carrying **no parity guarantee** and **gating nothing**.
The napkin sketch, not the render. This is recorded here only to note that the
mirror archetype *decouples the transpile story from ml-core entirely* — the
maintenance contract we were avoiding never forms.

## Rejected alternatives

- **Bun-execution of a TS reimpl as the mirror oracle.** Rejected — the §Background
  point 2 (float/ULP) makes the equality ill-defined, and it manufactures a
  standing crate↔reimpl parity contract. The oracle must sit on the authoritative
  (crate) side.
- **Make candle an in-tree `SPECIAL_LOWERED` lane like `@ttr/std`.** Rejected — that
  is candle-specific special-casing. The D1–D5 generalizations serve *every* future
  mirror plugin and keep candle a Tier-2 package, consistent with how 110 itself
  generalized the std-shim lane into a registry.
- **Collapse candle behind an infallible value-facade / model-as-data / trace-to-graph
  (a *macro* treatment).** Rejected **for candle specifically** — candle wants to
  *be* candle, not abstract it, and hiding it forfeits faithful fidelity. **Retained
  as the correct choice for other libraries** where abstracting the low-level Rust
  *is* the goal; that is exactly why both archetypes are named rather than one being
  declared "the" plugin shape.
- **Open/extensible HIR or a text-emit seam.** Rejected — inherits 110's spine
  verbatim; both archetypes stay expand-to-core-HIR with a total emitter.

## Dependencies / status

- **Builds on:** series 110 (plugin registry, `refinePlugins`, expand-to-HIR
  contract) and the 049 fallibility fixpoint. Touches the series 099/113 type oracle
  for D2.
- **Status:** design / doctrine; this is the **umbrella** series. `specs.md` and
  implementation live in the **per-delta child series** (D1–D5, the generator, the
  candle plugin), each greenlit and sequenced on its own — see §Decisions.
- **First client:** the voidloop `candle` mirror plugin.

## Decisions (locked)

- **Repo split** — the D1–D5 contract deltas and the `ttr facade` generator are
  **TTR-core**; a mirror **plugin package lives in the consumer** (the candle plugin
  lives in voidloop). (Confirmed.)
- **Facade is generated** — via the `ttr facade <crate>` subcommand (see
  §"Facade generation"), never hand-authored. Regeneration against a new crate
  version is the only way the facade changes. (Confirmed.)
- **Each delta ships as its own series.** D1–D5, the `ttr facade` generator, and the
  first-client candle plugin are **independent follow-up series**, not one monolithic
  epic. This tracking series (121, issue #118) is the umbrella; each child gets its
  own `docs/work/<NNN-slug>/` + issue and is sequenced/greenlit on its own. (Confirmed.)
- **Golden-value provenance for D1 — pinned candle run.** Mirror-plugin goldens are
  captured from a pinned `candle` run, **not** an independent numpy/torch reference.
  Rationale: for a mirror plugin candle *is* the source of truth, so its own output is
  authoritative by definition; the fixture tests "does TTR emit the right candle
  calls," not "is candle numerically correct." An external reference would re-introduce
  the cross-implementation ULP-tolerance problem the oracle-follows-authority doctrine
  rejects (§Background point 2) — this decision is that doctrine applied to D1's
  fixtures. (Confirmed.)

## Open questions (delegated, not blocking)

1. **Facade extraction mechanism** — does `ttr facade` read rustdoc JSON
   (`cargo doc --output-format json`) or parse source via `syn`? Resolved **inside the
   generator's own series**, noted here so it isn't lost.
