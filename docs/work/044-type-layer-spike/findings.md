# 044 — TS-checker-backed type resolution, coupled with oxc (SPIKE findings)

> **Status: SPIKE COMPLETE — awaiting Collin's adopt / reject / wait decision
> (2026-07-13).** Issue **#44**. This is an architecture spike, not an impl.
> Runnable artifact: `prototype.ts` next to this file
> (`bun run docs/work/044-type-layer-spike/prototype.ts`).

## What the spike set out to answer

The front end is `oxc-parser` (syntax only, no checker), so the transpiler
hand-rolls a mini type system (`bindingTypes`, `structFields`, `collectionOf`,
numeric inference, nullability). #44 asks: **can we couple a real TypeScript
checker to oxc — query `getTypeAtLocation` for the *TS-type* half — while
keeping our ownership layer ours?** The canonical symptom is `collectionOf`
(`lower.ts:3144`): 4 lines, `if (obj.type !== "Identifier") return null` — it
resolves a Map/Set receiver *only* when it is a bare identifier, because
`bindingTypes` keys on names. `this.field` / `local.field` / `getX()` receivers
fall out (#37 Fork C).

## Result: the coupling works, and the feared risk evaporated

All four questions came back green. The prototype takes an **oxc node's span**,
finds the **tsc node at that span**, and calls **`getTypeAtLocation`**:

| Receiver shape | `collectionOf` today | tsc via span-coupling |
|---|---|---|
| `this.cache` (`this.field`) | ❌ null | ✅ `Map<string, number>` |
| `local` (identifier) | ✅ | ✅ `Map<string, number>` |
| `this.getMap()` (**CallExpression**) | ❌ null | ✅ `Map<string, number>` |

The `getX()` case is the point: a call-expression receiver is *categorically*
beyond a name-keyed table, and the checker resolves it with the same one-line
query as everything else. **#37 Fork C dissolves.**

### Finding 1 — offset reconciliation is a NON-issue (the big one)

The coupling primitive is "find the tsc node whose `[getStart, getEnd]` equals
the oxc `[start, end]`." I feared an encoding mismatch: oxc is Rust (UTF-8
bytes), tsc is JS (UTF-16 code units). **It is not a problem.** oxc-parser's JS
bindings emit **UTF-16 code-unit offsets** — verified against a source with an
accented char *and* a surrogate-pair emoji before the receiver:

```
receiver oxc.start : 48
UTF-16 index        : 48   ← matches (what tsc uses)
UTF-8  byte index   : 51   ← does NOT match
```

So oxc and tsc spans align **natively, with zero translation table**, even
across multi-byte/surrogate text. This was the single scariest part of the
coupling boundary and it costs nothing.

### Finding 2 — `noLib` (1.3 ms) covers the `collectionOf` case; lib (87 ms) only for method-return inference

Two operating points, measured (`perf.ts`, avg over 20, small file):

| Mode | `.get()` **result** inference | Cost / compile |
|---|---|---|
| `noLib` | `any` | **1.3 ms** |
| full `lib.d.ts` | `number` ✓ | **86.8 ms** |

The split is sharp and useful:

- **Receiver types from explicit annotations** (`this.cache: Map<…>`,
  `getMap(): Map<…>`, `const local: Map<…>`) resolve **under cheap `noLib`** —
  all three table rows above were `noLib`. This is exactly `collectionOf`'s job.
- **Inference *through* built-in method signatures** (what does `.get()` /
  `arr.map()` *return*) needs `lib.d.ts` → the ~65× cost, because those
  signatures live in the lib.

Crucially, the 87 ms is **per file-compile, paid once** (one `Program`, many
`getTypeAtLocation` queries against it) — not per query — and is cacheable
across a process (document registry / incremental program). So it is **not** a
throughput blocker; it is a "load lib only if a query needs method-return
inference" knob.

### Finding 3 — OPERATIONAL TRAP: Bun's `"typescript"` is hijacked by a v7 native shim

`import … from "typescript"` under Bun in this repo resolves to
`~/.bun/install/cache/typescript@7.0.2@@@1/lib/version.cjs` — the **tsgo native
v7 build, which ships NO compiler API** (`createProgram`/`ScriptTarget` are
`undefined`). This is the exact "v7 has no API yet" tension from the issue,
showing up as a silent resolution trap rather than a missing package. The real
v5.9.3 JS API is at `node_modules/typescript/lib/typescript.js` and must be
pinned **by explicit path** (both the prototype and any real adoption must do
this, or set up an import alias). Note the "v6" in prior notes is really
**v5.9.3** — the last line of the classic JS-API TypeScript.

## Risks assessed

- **Offset encoding** — resolved, non-issue (Finding 1).
- **Whole-program weight** — `noLib` 1.3 ms; lib 87 ms once-per-compile,
  cacheable (Finding 2). Not a blocker.
- **Determinism** — tsc is deterministic given identical input; a single
  in-memory file with fixed options is reproducible.
- **Structural-vs-nominal (#43)** — NOT exercised here. tsc types are
  structural; our trait/interface classification (#43/071) is partly nominal.
  The checker answers "what TS type is this," not "which of our synthesized
  traits does it map to" — the mapping stays our job. Flagged for the adoption
  design, not a spike blocker.
- **Union widening / `| undefined`** — under lib, `.get()` returned
  `number | undefined`-style results correctly; feeding those into the
  nullability layer is a design detail, not a feasibility question.

## Concrete drivers this unblocks (once adopted)

- **#37 Fork C** — `collectionOf` on any receiver shape (demonstrated).
- **#48** — string concat when both operands are method calls: needs
  method-return types → the **lib** operating point (Finding 2).
- **#40 / 081** — operators on a bare `T`: the checker gives the instantiated
  type at a call site, a prerequisite for graduating the operators-on-`T`
  fail-loud.

## Recommendation (for Collin — the adopt / reject / wait decision)

**Adopt, coupled and incremental — do not wait for the v7 native API.** The
spike shows the coupling is sound *today* on v5.9.3, the offset boundary is
free, and there is a cheap (`noLib`, ~1 ms) operating point that already retires
the `collectionOf` / #37-Fork-C class of hand-rolled lookups. The v7-API wait
would strand this behind an external timeline for no feasibility gain; when the
native API lands it becomes a drop-in speedup behind the same boundary.

Proposed shape if adopted (own series, spec-first):

1. A thin `TypeOracle` module: builds **one** in-memory `ts.Program` per
   compiled source, exposes `typeAtSpan(start, end)` via the `findBySpan`
   primitive. Lib loaded **lazily** — `noLib` by default, upgrade to lib only
   when a query needs method-return inference.
2. First real cut-over: **`collectionOf`** → `typeOracle.typeAtSpan(obj.range)`,
   deleting the Identifier-only restriction. Ownership layer untouched.
3. Keep #43 nominal-trait mapping ours; oracle answers TS-type only.

**Open question for Collin:** adopt now on v5.9.3 (coupled, lazy-lib), or hold?
And if adopt — is the first cut-over `collectionOf` (lowest-risk, `noLib`), or
#48 concat (needs lib, exercises the heavier path first)?
