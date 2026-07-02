# TypeScript → Rust Translator — Plan

## Goal (scoped honestly)

Translate a **strict, explicitly-enforced subset of TypeScript** into **idiomatic
Rust** (the "Option A" memory model — see below). This is a language-level
translator: no Node/Bun APIs. It is deliberately **not** "compile any TypeScript":
TS's type system is unsound and its GC semantics (shared mutable aliasing, cyclic
references, dynamic object shapes) have no total mapping onto Rust's affine
ownership. Tractability comes from restricting the input, not from heroics in the
backend. The accepted subset is specified in [dialect.md](./dialect.md) and is
**enforced** — input outside it is rejected, never silently mistranslated.

## Memory model: Option A (idiomatic borrows) — DECIDED

Two models were on the table:

- **Option A — idiomatic ownership.** Emit plain Rust (`T`, `&T`, `&mut T`,
  moves). Fast, idiomatic output. Cost: requires real **escape/mutation
  analysis** to choose ownership soundly.
- **Option B — managed memory.** Wrap everything in `Rc<RefCell<T>>` to mimic GC.
  Trivial to emit, but slow, unidiomatic, and lock/refcount-heavy.

**We chose Option A.** The whole point of targeting Rust is idiomatic, fast
output; Option B would make the project pointless. The consequence is explicit
and owned: **ownership inference is the central technical problem of this
project, not a footnote.** It gets first-class, multi-pass treatment below.
`Rc<RefCell<T>>` remains available as a *local* fallback for the rare in-dialect
shape that genuinely needs shared mutability, but it is the exception, not the
strategy.

## Pipeline

```
.ts source
  │  oxc-parser (parseSync → ESTree AST; see architecture.md for the ESTree gotcha)
  ▼
1. Parse
  │
  ▼
2. Dialect validation        reject anything outside dialect.md — FAIL LOUD
  │  (validate.ts)           `DialectError`. Enforces `any`/`unknown` today;
  │                          untyped bindings et al. are pending slices.
  ▼
3. Symbol table & scopes     resolve every identifier to a declaration
  │
  ▼
4. Typed HIR                 AST → IR carrying resolved types + binding info
  │
  ▼
5. Ownership & mutation      THE hard pass. Per binding/param, infer
   analysis                  move / &T / &mut T from how it is read, mutated,
  │                          aliased, returned, and passed to callees.
  ▼
6. Rust emission             HIR → idiomatic Rust string
  │
  ▼
7. rustfmt                   normalize formatting
  ▼
.rs output  ──►  verification harness: cargo check + cargo run (the oracle)
```

Note: there is **one** IR (HIR). The earlier draft mentioned both "HIR" and
"MIR" inconsistently; we lower TS-AST → HIR → Rust and do not maintain a
separate MIR.

## The oracle: compile and run, never string-match

Correctness is judged by a **real Rust toolchain**, driven by a Bun-based
harness (`packages/compiler/src/harness`):

- **Tier 1 — COMPILES:** emit Rust, `cargo check` it (as a library, so
  bare-function snippets verify without a `main`). Structured JSON diagnostics
  (error code, message, span) come back, so failures are explainable and can be
  mapped to TS source.
- **Tier 2 — BEHAVES:** for complete programs, run the TypeScript (via Bun) and
  the emitted Rust (via `cargo run`) and assert their stdout matches —
  differential testing.

The previous approach (string-equality against hand-written `.rs` golden files)
was retired: it is brittle to formatting, rejects idiomatic-but-different output,
and — as several of the original fixtures proved — let invalid Rust (e.g. bare
`let` at module scope) masquerade as a passing oracle. See
[architecture.md](./architecture.md) for the harness design.

## Type mapping (current + intended)

| TypeScript            | Rust (today)                  | Notes |
|-----------------------|-------------------------------|-------|
| `number`              | `f64`, or `usize` for indices | Numeric inference (`numeric.ts`) refines index-reached values to `usize` so `Vec` indexing compiles; `i64` counters are a planned addition. |
| `string`              | `String`, or `&str` for read-only params | Read-only string params refine to `&str` (`strings.ts`); owned params stay `String`, mutated stay `&mut String`. |
| `boolean`             | `bool`                        | |
| `Array<T>` / `T[]`    | `Vec<T>`                      | ownership pass picks `Vec<T>` / `&Vec<T>` / `&mut Vec<T>`. |
| `Record<string, T>`   | `HashMap<String, T>`          | Done: type + literal construction (`HashMap::from`) + string-literal lookup (`lower.ts`). String keys only (`f64` isn't `Hash`/`Eq`); mutation/methods/variable keys deferred. |
| `interface` / object  | `struct`                      | Done: `interface` → `struct` item + named-struct literals (`lower.ts`, resolved via `analysis.structs`). Optional/readonly/nested fields and inheritance deferred. |
| `class`               | `struct` + `impl`             | no inheritance; shared-mutable instances need the `Rc<RefCell>` fallback. Next data-structure slice (builds on the `struct` half). |
| `throw` / `try`       | `Result<T, E>` + `?`          | **not** `panic!` — `panic!` changes catch semantics. A return-type rewrite. |
| `async` / `await`     | `async fn` / `.await`         | runtime is **tokio**; generated entry point is `#[tokio::main]`. |
| `any` / `unknown`     | `ts_primitives::TsAny`        | escape hatch only. |

## Status

**Done**
- Verification harness (cargo check/run + structured diagnostics + rustfmt,
  offline-first with online fallback), proven by self-tests in
  `tests/harness.test.ts` — including a tokio async program.
- `ts-primitives` runtime crate with a real, tested `TsAny` (Option-A minimal).
- Typed emitter (off `any`, against a verified ESTree AST subset) producing
  *complete, compilable* modules — top-level script statements are wrapped in a
  generated `fn main()`.
- Working vertical slice (variables, mutability, functions, binary ops,
  `console.log`) that compiles **and** passes a differential run.
- **Ownership spike** (`src/analysis.ts`): intra-procedural parameter ownership
  (`T` / `&T` / `&mut T`) + usage-based local mutability, with call-site argument
  adaptation. Unlocks all three `10_ownership` fixtures + basic arrays. Rules
  unit-tested in `tests/analysis.test.ts`.
- **Typed HIR layer** (`src/hir.ts` + `src/lower.ts`): the pipeline is now
  AST → HIR → Rust. Lowering is the single dialect gate — it consumes the
  ownership analysis once and bakes resolved `RustType`s, borrow forms, `mut`-ness,
  and call-site borrows into the IR. The emitter (`src/emitter.ts`) is a pure, total
  HIR → string function with no analysis and no rejection. Side tables are an
  internal detail of lowering, no longer threaded downstream.
- **Numeric inference** (`src/numeric.ts`): a post-lowering HIR→HIR pass refining
  `number → usize` where array indexing demands it, propagating usize-ness through
  initializers and integer arithmetic and failing loud on an int/float conflict.
  Unblocks variable array indexing (`arr[i]`, `arr[i + 1]`). `i64` counters
  remain a separate numeric slice.
- **String-borrow inference** (`src/strings.ts`): a post-lowering HIR→HIR pass
  refining a read-only `string` parameter's `&String` into the idiomatic `&str`.
  Owned params stay `String`, mutated stay `&mut String`; call sites are unchanged
  (`&String` coerces to `&str`).
- **Dialect validation** (`src/validate.ts`): pipeline step 2, run first in
  `lower()`. Rejects `any`/`unknown` with a `DialectError` — "forbidden input, fix
  it" — now distinct from `UnsupportedError` ("in the dialect, not yet built").
  Other forbidden categories and the annotation requirement are future slices.
- **Control flow — complete** (`src/hir.ts`, `src/lower.ts`, `src/emitter.ts`):
  all five `02_control_flow` fixtures compile **and** behave (differential).
  `if`/`else if`/`else` and `while` are HIR `if`/`while` nodes with real block
  bodies (idiomatic `else if` chains); C-style `for` desugars to a
  scope-containing `block` + `while` (`lowerFor`); `for…of` →
  `for <pat> in <iterable>.iter()` (`lowerForOf`, by reference); `switch` → a
  guarded-wildcard `match` (`lowerSwitch`, sidestepping Rust's `f64`
  literal-pattern ban; cases must terminate, no fall-through); `break`/`continue`
  → Rust `break;`/`continue;`. Numeric inference descends into every control-flow
  body. **Deferred refinements** (each its own future series): idiomatic
  `for i in a..b` ranges and literal-pattern `match` arms; `continue` inside a
  C-`for` (rejected — needs a labeled-block desugar); for…of element ergonomics
  (`&T` binding — fine for arithmetic, not by-value comparison; destructuring /
  owned / `&mut` elements); labeled and stacked jumps; `i64` counters.
- **Data structures — records → `HashMap`** (`src/hir.ts`, `src/lower.ts`,
  `src/emitter.ts`): `04_data_structures/02_records` compiles **and** behaves.
  `Record<string, V>` → a `hashmap` `RustType` (`HashMap<String, V>`); a
  record-typed object literal → `HashMap::from([(k, v), …])` (empty → `::new()`),
  interpreted **contextually** from the binding's annotation (`lowerVarDecl` +
  `lowerHashMapLiteral`); a string-literal lookup `map["a"]` emits a bare `&str`
  index (not `.to_string()` — `HashMap: Index<&Q>`). A module using a map gets
  `use std::collections::HashMap;` prepended. A bare/struct-typed object literal
  is fail-loud (`UnsupportedError`). **Deferred** (each its own future series):
  non-`string` keys (`f64` is not `Hash`/`Eq`); variable/non-literal keys (need
  `&k` + numeric-seeding care); mutation / `.get` / `.has` / iteration / maps API;
  the `Map`/`Set` classes.
- **Data structures — `interface`/object → `struct` literals** (`src/hir.ts`,
  `src/lower.ts`, `src/emitter.ts`, `src/analysis.ts`): `05_interfaces/01_basic`
  compiles **and** behaves. An `interface` → a `HirStruct` **item**
  (`HirModule.items` is now a `HirFn | HirStruct` union); interface names are
  collected into `analysis.structs`, so `lowerType` resolves a `TSTypeReference`
  to a nominal `struct` `RustType` (an unknown type name stays fail-loud). An
  object literal in a struct-typed binding → a `structLit` (`Name { f: v, … }`),
  chosen contextually in `lowerVarDecl` (parallel to the record path); a field
  read reuses the existing `field` node. **Deferred** (each its own future
  series): `class` → `struct` + `impl` (methods/`new`/`this`); `interface extends`
  / inheritance; optional (`x?: T`) and readonly fields; nested/struct-typed
  fields and structs inside collections; struct mutation / field assignment;
  `#[derive(...)]` and whole-struct printing.

**Next** (order reflects decisions made 2026-07-01)
- [ ] Finish generalizing ownership: inter-procedural moves (use-after-move →
      `.clone()`, move-through-store) and nested-scope shadowing (blocked on
      control flow — no block scopes exist yet). Read-only-string `&str` params
      are done (`strings.ts`).
- [ ] Extend the dialect validator (`validate.ts` exists; rejects `any`/`unknown`):
      missing-annotation enforcement (with the trivial-literal exception), class
      `extends` inheritance, dynamic object manipulation, escaping mutable aliasing.
- [ ] Control-flow refinements (deferred, revisit as needed): the labeled-block
      `for`-`continue` desugar, literal-pattern / or-pattern `match` arms,
      idiomatic `for i in a..b` ranges, for…of element ergonomics (owned/`&mut`,
      destructuring), and labeled/stacked jumps. All are optimizations or edge
      cases over today's correct, fail-loud lowerings — not blockers.
- [ ] `class` → `struct` + `impl` (`06_classes/01_basic`): methods, constructor
      (`new`), `this`, field access. No inheritance. The struct half is done
      (series 011); this adds behavior. The next data-structure slice.
- [ ] `throw`/`try` → **`Result<T,E>` + `?`** (decided; not `panic!`).
- [ ] `async`/`await` — emit `async fn` + `#[tokio::main]` (runtime already wired).

The `tests/fixtures/**` tree enumerates these as `test.todo` targets; each flips
to a real compile/behave test as the feature lands.

## Development flow

Strict TDD, but against the **oracle**, not golden strings: add/enable a fixture
(or a differential program), watch it fail to compile/run (RED), implement the
emitter/analysis until `cargo` accepts it and output matches (GREEN). See
[../.agents/AGENTS.md](../.agents/AGENTS.md).
