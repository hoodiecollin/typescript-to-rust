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
  │                          (no `any`/`unknown`, no untyped bindings, …)
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
| `number`              | `f64`                         | A numeric-inference pass for `i64`/`usize` (indices, counters) is planned — `f64` cannot index a `Vec`, so this is a known landmine for loop/array code. |
| `string`              | `String` (owned)              | `&str` where ownership analysis proves read-only borrow suffices. |
| `boolean`             | `bool`                        | |
| `Array<T>` / `T[]`    | `Vec<T>`                      | ownership pass picks `Vec<T>` / `&Vec<T>` / `&mut Vec<T>`. |
| `Record<string, T>`   | `HashMap<String, T>`          | |
| `interface` / object  | `struct`                      | closed, statically-known shapes only. |
| `class`               | `struct` + `impl`             | no inheritance; shared-mutable instances need the `Rc<RefCell>` fallback. |
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
  and call-site borrows into the IR. The emitter (`src/emitter/`) is a pure, total
  HIR → string function with no analysis and no rejection. Side tables are an
  internal detail of lowering, no longer threaded downstream.

**Next** (order reflects decisions made 2026-07-01)
- [ ] Numeric inference (`usize`/`i64` for indices & counters) → unblock
      variable array indexing and `for`-loop fixtures. (Literal indices already
      emit `usize`.) The HIR is the home for this: annotate `number` nodes with a
      refined `RustType` during (or after) lowering.
- [ ] Generalize ownership: inter-procedural moves (value passed/returned/stored),
      `&str` for read-only string params, nested scopes.
- [ ] Dialect validator pass (reject out-of-subset input; enforce [dialect.md](./dialect.md)).
- [ ] Control flow: `if`/`else`, `while`, `for`, `for…of`, `switch → match`.
- [ ] Data structures: records/`HashMap`, `interface`/struct literals.
- [ ] `interface`/`class` → `struct`/`impl`.
- [ ] `throw`/`try` → **`Result<T,E>` + `?`** (decided; not `panic!`).
- [ ] `async`/`await` — emit `async fn` + `#[tokio::main]` (runtime already wired).

The `tests/fixtures/**` tree enumerates these as `test.todo` targets; each flips
to a real compile/behave test as the feature lands.

## Development flow

Strict TDD, but against the **oracle**, not golden strings: add/enable a fixture
(or a differential program), watch it fail to compile/run (RED), implement the
emitter/analysis until `cargo` accepts it and output matches (GREEN). See
[../.agents/AGENTS.md](../.agents/AGENTS.md).
