# 030 — Comprehensive fixture-coverage expansion

## Problem

The fixture corpus proved *presence* of each shipped feature (one fixture per
construct) but not its *breadth*. Whole classes of ordinary programs — recursion,
nested control flow, multi-method classes, matrices, deep expression nesting —
went untested, so we could not distinguish "the feature works" from "the one
happy-path fixture works". The brief (task #7): broaden `tests/fixtures/**`
across **all** shipped areas, not just undeveloped ones, and deliberately push
into deep-nesting/precedence territory to see what the oracle catches.

Two motivations, both foundational-first (not demand — this project has no
consumers):

1. **Confidence before layering.** Later series (closures, tslib, directives)
   build on today's emitter. A broader corpus raises the floor so a regression in
   the base surfaces immediately.
2. **Surface latent gaps via the oracle.** Deep nesting is exactly where a
   string emitter with hand-managed precedence is expected to be fragile (see
   026). Writing the fixtures that stress it is what converts a *theoretical* gap
   into a *concrete, reproducible* one.

## What shipped

**22 behavioral fixtures** across every area (each a complete program with
`console.log`, so it earns both tiers):

- `01_variables/03_compound_assign` — `+=` / `-=`.
- `02_control_flow/06_nested_if`, `07_while_nested_if`, `08_switch_multi_stmt`,
  `09_forof_print` — nested branches, multi-statement `case`s, loop bodies.
- `03_functions/03..12` — factorial & fibonacci recursion, nested calls,
  triple-nested calls, boolean-returning fns, precedence-that-aligns
  (`a*b + c*d`), left-assoc chains (`a - b - c`), `%`, negation via `0 - n`,
  string concatenation.
- `04_data_structures/04_matrix`, `05_array_of_structs` — `Array<Array<number>>`
  with nested indexing, arrays of structs.
- `05_interfaces/02_nested_struct` — a struct with struct-typed fields.
- `06_classes/02_multi_method`, `03_getter_method` — multiple methods, a method
  mutating fields, a method deriving a value from fields.
- `07_async/02_multi_await` — two sequential `await`s.
- `10_ownership/05_struct_borrow` — a struct passed by borrow and read.

**A fixture-driven differential tier** (`tests/fixture-differential.test.ts`):
each behavioral fixture is run under Bun *and* as emitted Rust, and their stdout
must match byte-for-byte, with the value pinned. This complements the curated
inline differentials in `compiler.test.ts` by adding breadth from files rather
than strings. Net: +22 tier-1 compiles and +22 tier-2 differentials, all green.

## Gaps surfaced (the real yield)

Probing candidate fixtures through the emitter + Rust oracle surfaced **five
concrete defects**. Each is now a reproducible finding routed to an owning
series; the *green* fixtures above route around them, and the repros live in
`specs.md`.

| # | Trigger | Symptom | Fail-loud today? | Owner |
|---|---|---|---|---|
| A | `f(grid, 1, 0)` where `f`'s params infer `usize` | call passes `1.0`/`0.0` to a `usize` param → `cargo check` E0308 | ❌ emits broken Rust | integer-arg retyping across call boundaries (numeric inference, inter-procedural) |
| B | `{ start: { x: 0, y: 0 } }` nested object literal | inner literal not recognized as a struct literal | ✅ `UnsupportedError` | nested/inferred struct literals (011 follow-up) |
| C | `let box: Box = …` | `box` is a Rust keyword → emitted Rust fails to parse | ❌ emits broken Rust | Rust-keyword identifier hygiene (emitter) |
| D | `(a + b) * c` | `ParenthesizedExpression` is unmodeled | ✅ `UnsupportedError` | 026 — parens are the prerequisite that would then expose flat precedence printing |
| E | `m["b"] = 2` (HashMap) | emits `m["b"] = 2.0`; `Index` is read-only → E0594 | ❌ emits broken Rust | HashMap index-assignment → `.insert(...)` (lowering) |

The three ❌ rows (A, C, E) are **fail-loud holes**: the emitter produces
plausible-but-broken Rust that only `cargo check` rejects, exactly the class of
defect series 024 closed for forbidden *flags*. At minimum they should become
lowering `UnsupportedError`s (fail loud); better, they should be supported. They
are the highest-priority follow-ups from this series.

Finding **D** is the headline for 026: the precedence gap the string emitter is
"quietly paying for" (026 §"The cost…") is currently **masked** — you cannot even
write `(a + b) * c`, because explicit parens are rejected one level earlier at
validation. So supporting `ParenthesizedExpression` is the *prerequisite* that
would expose flat precedence printing; the two must land together (parens +
precedence-aware parenthesization). The 026 doc is updated to record this.

## Non-goals

- No emitter/lowering changes. This series is purely additive test coverage plus
  the differential harness; the surfaced gaps are handed off, not fixed here.
- No new dialect surface. Every fixture stays within today's accepted vocabulary
  (no parens, `&&`/`||`, unary, ternary, or template literals — all still
  `UnsupportedError`).

## Follow-ups

New series (see plan.md "Next" and the task list): integer-arg retyping (A),
Rust-keyword hygiene (C), HashMap index-assignment (E), nested struct literals
(B). Parens+precedence (D) folds into 026.
