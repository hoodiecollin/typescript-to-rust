# 025 — Esoteric feature support (plan)

> **Status: PLAN, not yet implemented.** Prerequisite: series 024 (fail-loud
> validator) has landed, so all of these currently `DialectError`/`Unsupported`
> rather than mistranslate. Each construct below graduates from "rejected" to
> "supported" as its own sub-series; this doc ranks them and sketches the target
> Rust shape. Pick them up one at a time, spec-first.

## The constructs (rejected by 024) and whether they earn support

Ranked by **ROI = (real-world usage) × (quality of Rust target) ÷ complexity**.
Each row is a candidate sub-series; the order is the recommended sequence.

| # | Construct | Rust target | Usage | Fit | Complexity | Verdict |
|---|---|---|---|---|---|---|
| 1 | `using` / `Symbol.dispose` | `Drop` | rising | ★★★★★ | medium | **support first** |
| 2 | sync generator `function*` | `impl Iterator` | moderate | ★★★☆ | high | support next |
| 3 | `for await` / async generator | `Stream` (futures) | niche | ★★☆ | very high | defer |
| 4 | decorators `@dec` | — (no faithful target) | common (Nest/Angular) | ★☆ | very high | **rejected (permanent)** |
| 5 | parameter properties | field + assign desugar | common | ★★★★ | low | **cheap win** |
| 6 | `enum` | Rust `enum` (C-like) | common | ★★★★ | low–medium | strong candidate |

### 1. `using` → `Drop` (best ROI)

TS 5.2 explicit resource management is *exactly* RAII, which is Rust's native
idiom. `using r = acquire()` binds a resource whose `Symbol.dispose` runs at
scope exit — i.e. `Drop::drop`.

```ts
function work(): void {
  using file = openFile("x");
  file.write("hi");
} // file.dispose() here
```
```rust
fn work() {
  let file = open_file("x");   // type must impl Drop
  file.write("hi");
} // file.drop() here — automatic
```

Design points:
- The *disposable* type must be one whose Rust translation impls `Drop`. If the
  class defines `[Symbol.dispose]() { … }`, lower that method body into a
  `impl Drop for T { fn drop(&mut self) { … } }`.
- `await using` → `Drop` cannot express async cleanup faithfully (no async
  drop in stable Rust). Keep rejecting `await using` (stays 024's `DialectError`)
  until/unless we adopt a scope-guard pattern.
- Ordering: Rust drops in reverse declaration order — matches JS dispose order.
  Verify with a differential (two `using`s, observe dispose order).

Sub-series scope: recognize `[Symbol.dispose]` method → `Drop` impl; `using`
decl → plain `let` with the drop-carrying type; reject `await using`.

### 5 & 6. Parameter properties and `enum` (cheap structural wins)

Both are low-complexity desugars worth doing before the harder iteration work:
- **Parameter property** `constructor(public x: number)` → add a struct field
  `x` and prepend `this.x = x` to the constructor body. Pure AST desugar in
  lowering; no new HIR.
- **`enum E { A, B }`** → `enum E { A, B }` (unit variants) with
  `#[derive(Clone, Copy, PartialEq)]`. Numeric/`const enum` and
  string-valued enums are follow-ups. Discriminant values map to
  `E::A as i64`.

### 2. Sync generator → `Iterator`

`function* g()` becomes a type implementing `Iterator`. The hard part is
compiling the generator *body* (arbitrary control flow between `yield`s) into a
state machine — a real mini-CPS transform. Two tractable subsets to start:
- **Yield-in-a-loop** (`for (…) yield x`) → the common "map/filter a sequence"
  shape → can often lower to an iterator adapter chain instead of a state
  machine.
- **Finite yields** (straight-line `yield a; yield b;`) → a small enum state
  machine.
General generators (yield inside nested try/switch) stay rejected.

### 3 & 4. Async iteration and decorators — defer / decline

- **`for await` / async generators** need `Stream` (from `futures`), which isn't
  in std, plus pinning ergonomics. Very high complexity, niche in pure-logic TS.
  Keep rejected until there's a concrete need.
- **Decorators — PERMANENT REJECTION (decided 2026-07-06).** They have
  *library-defined* runtime semantics (metadata reflection, DI containers); there
  is no faithful static Rust target, and supporting them would mean baking a
  specific framework's semantics into the translator. They stay `DialectError`
  (series 024). Not revisited. If a genuinely pure, well-specified subset ever
  comes up (e.g. a `@memoize`-style decorator with no reflection), that would be a
  brand-new, narrowly-scoped proposal — not a lifting of this decision.

## Recommended sequence

`using`→`Drop` (1) → parameter properties (5) → `enum` (6) → sync generators (2).
Async iteration (3) and decorators (4) remain rejected until justified.

## Specs sketch (per sub-series, turned RED when picked up)

- `using` with a `[Symbol.dispose]` class → emits `impl Drop`; differential
  observes dispose-on-scope-exit and reverse order for two resources.
- parameter property → field present in struct + assigned in `new`; differential
  reads the field back.
- `enum` → Rust enum; `switch` over it → `match` (composes with 019).
- generator (loop subset) → iterator; `for (const x of g())` consumes it.

## Open questions

- Do we require the disposable class to *declare* `[Symbol.dispose]`, or also
  accept `implements Disposable` interface shape?
- For `enum`, do we model TS's open numeric semantics or restrict to closed
  C-like enums (recommended: closed, matches Rust)?
