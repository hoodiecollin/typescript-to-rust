# 110 — Plugin system (recognized-shape, expand-to-HIR, bilingual)

Epic. **Depends on series 109 Phase 1** — the plugin recognition/expansion hook
lands in the clean `lower/method-routing.ts` module, not the monolith.

Adds a first-class way to extend the compiler along three axes the user asked for —
**new language nodes, new parser (recognition) logic, new emitter logic** — *without*
dissolving the two properties that define this compiler: **fail-loud** (it refuses
anything it can't faithfully translate) and **emitter totality** (every switch is
exhaustive with no default case, enforced at compile time).

## The core tension, and how it resolves

"Let plugins add emitter logic" reads, naively, as "let a plugin hand the emitter a
string of Rust." That is a **raw-Rust escape hatch**, and it is fatal to fail-loud: the
compiler can no longer vouch for what it emits — it becomes a text templating engine
with a trusted-input assumption. So the whole design is the answer to *how do you get
plugin-authored codegen without a text-emit seam?*

The answer, decided across three design rounds:

> Plugins **recognize** blessed TS shapes and **expand** them into **core HIR** — the
> same HIR the built-in lowerer produces. They never emit text and never introduce a
> new emitter case with real logic. The emitter stays total; the compiler still vouches
> for every byte because every byte still comes from core HIR it already owns.

## Decisions (locked)

### 1. Trust model — Tiers 1–2 only; **Tier 3 dropped**

We named three conceivable trust tiers and then **dropped the third entirely**:

- **Tier 1 — in-tree HIR additions.** A genuinely new construct that core HIR can't
  express is added the normal way: a new `hir.ts` variant + emitter case + validator
  `MODELED` entry, reviewed in-tree. Plugins do **not** do this.
- **Tier 2 — third-party plugins under a fail-loud contract.** A plugin package
  recognizes its owned shapes and expands them to **core HIR only**. This is the plugin
  surface. Faithfulness is automatic: the plugin can only produce HIR the compiler
  already knows how to emit correctly.
- **~~Tier 3 — raw-Rust escape hatch.~~** **Dropped.** A `emit(payload) => string` seam
  is Tier 3 in disguise and breaks fail-loud absolutely. Anything that *needs* a Rust
  construct core HIR can't express is a **Tier-1** job (bring it in-tree), not a plugin.

This is the single most important boundary in the design. It is why the seam below is
**expand-to-HIR, not emit-to-text**.

### 2. Recognition — specifier-anchored, never name heuristics

A plugin **owns reserved import specifier(s)** and claims the valid-TS shapes that flow
from those imports. This is the **exact mechanism the existing `@ttr/std` std-shim lane
already uses** (`std-shim.ts`: `STD_SHIM_SPECIFIER = "@ttr/std"`, scan top-level imports,
bind the recognized names). The std-shim lane is, in effect, the **first plugin**, and
the plugin system generalizes it into a registry.

- **No new syntax.** Everything a plugin recognizes is already valid TypeScript that
  `tsc` accepts; the plugin only assigns *meaning* to specifier-anchored shapes.
- **Never name heuristics.** Recognition is anchored to the import specifier and the
  bindings it introduces — never "any call named `foo()`". Two plugins can define `parse`
  without collision because each is bound to its own specifier.

### 3. Emit seam — single opaque `"plugin"` HIR variant + a front-of-chain expansion pass

One new HIR variant, added **once, in-tree**:

```ts
// hir.ts — added once
{ kind: "plugin", owner: string /* specifier */, payload: unknown }
```

The flow:

1. **Lower** — when `method-routing`/`lowerCall` sees a plugin-owned shape, it emits the
   opaque `{ kind: "plugin", owner, payload }` node. Lowering does no plugin-specific
   work beyond routing.
2. **Expand** — a **new `refinePlugins` pass at the FRONT of the refine chain** (the
   *innermost* call in the nested composition at `lower/index.ts`, i.e. wrapping
   `module` before `refineBitwise`/`refineNumerics`) replaces every `"plugin"` node with
   **core HIR** produced by the owning plugin's `expand(payload)`. It runs first so all
   downstream passes (ownership, numeric, string, rc, iter-fusion, …) see ordinary core
   HIR and treat plugin output exactly like built-in output.
3. **Emit** — the emitter's `"plugin"` case is a **fail-loud guard**: reaching it means a
   `"plugin"` node survived expansion, which is a compiler bug, so it throws
   `UnsupportedError` ("unexpanded plugin node"). It never emits real plugin logic.

Net effect on totality: the emitter gains exactly **one** case, and that case emits
nothing — it asserts. Exhaustiveness is preserved; `expand()` is forced to land in the
already-exhaustive core HIR space. There is no open union and no plugin-specific emitter
logic anywhere.

### 4. Runtime scope — **full bilingual from v1**

A plugin is not TS-only. Because `expand()` produces core HIR that may **call into a
runtime**, a plugin ships both halves, tslib-style:

- **TS side** — recognition + `expand()`, plus its `MODELED` contributions and a
  **rejection corpus**.
- **Rust side** — a **Rust crate** and a **Cargo-dep manifest** declaring what the
  emitted code depends on. `expand()` produces core HIR **call nodes into that crate**.
  The crate is warmed through the existing oracle path (`ensureDepsWarm`) so specs don't
  cold-compile deps.

This mirrors how `@ttr/std` intrinsics bind to `crates/tslib` today, generalized so a
plugin brings its own crate instead of extending tslib.

## The v1 plugin contract — four declared parts

A conforming plugin package declares:

1. **Owned specifier(s)** — the import path(s) it reserves (e.g. `@acme/thing`).
2. **`MODELED` contributions + a rejection corpus** — the accept-set entries it adds to
   the validator, **and** the fixtures proving each guard rejects what it should
   (per the corpus-coverage rule: every behavior *and* each guard's negative reject case
   gets a fixture).
3. **`recognize` + `expand`** — `recognize` maps its owned shapes to `{ kind: "plugin",
   … }`; `expand(payload)` returns **core HIR** (never text).
4. **Rust crate + Cargo-dep manifest** — the runtime the expanded HIR calls into, plus
   the dep declaration the oracle warms.

All four are required for v1 — a plugin missing any part fails loud at registration.

## The lockstep triad, extended

The compiler's existing invariant is a three-way lockstep: **`MODELED` accept-set
(validate) ↔ AST `.type` switches (lower) ↔ HIR `.kind` switches (emit)**. Plugins plug
into it without loosening it:

- Validate: plugin adds `MODELED` entries (accept-set grows, still explicit).
- Lower: plugin routes owned shapes to the single `"plugin"` variant (one shared case).
- Emit: unchanged and total — expansion happened before emit, so the emitter only ever
  sees core HIR.

## Rejected alternatives

- **`emit(payload) => string` (text-emit seam / Tier 3).** Rejected — it *is* the
  escape hatch; it breaks fail-loud and totality. This rejection is the spine of the
  whole design.
- **Open/extensible HIR union (plugins add their own `kind`s).** Rejected: it destroys
  compile-time exhaustiveness — the emitter switch could no longer be proven total, and
  a missing case becomes a runtime surprise instead of a type error. One opaque variant +
  expansion keeps the union closed.
- **Name-heuristic recognition** ("treat any `parse()` as ours"). Rejected: collisions,
  ambiguity, and it violates the established specifier-anchored discipline. Recognition
  is anchored to owned specifiers, full stop.
- **TS-only plugins (defer the Rust crate).** Rejected for v1: `expand()` inevitably
  needs runtime, and a half-contract that can't declare its Cargo deps would just get
  reworked immediately. Bilingual from v1.
- **New surface syntax for plugins.** Rejected: recognition is over *valid TS `tsc`
  accepts*; plugins assign meaning, they don't extend the grammar.

## Dependencies / status

- **Blocked on:** series 109 Phase 1 (clean `lower/` folder-module; hook lands in
  `lower/method-routing.ts`).
- **Touches (in-tree, once):** `hir.ts` (+`"plugin"` variant), `emitter.ts` (+fail-loud
  case), `lower/index.ts` (+`refinePlugins` at chain front), a plugin registry
  generalizing `std-shim.ts`, and the oracle dep-warming path.
- Issue TBD (epic).
