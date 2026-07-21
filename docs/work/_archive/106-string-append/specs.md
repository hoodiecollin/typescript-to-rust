# 106 — Specs: append-assignment → in-place string mutation

Drives the public `emit(...)` / `compile(...)` entry via the differential harness
(`tests/_support/differential`), cargo-compiling and running each program so every shape
assertion is also a COMPILES/BEHAVES proof. Spec file:
`packages/compiler/tests/string-append.test.ts`. Per the corpus-coverage rule, every
decided behavior gets a fixture — including the negatives that must **keep** `format!`
(prepend / non-head accumulator), which are the soundness-critical rejects.

## Positive — self-append rewrites to in-place `write!` (RED until 106 lands)

- **SA1** (strbuild shape) — `let s = ""` grown by `s = s + "abc" + (i % 10)` in a loop:
  the assignment emits `write!(s, "{}{}", "abc", i % 10).unwrap()`, **not**
  `s = format!(…)`. The module imports `use std::fmt::Write;`. Prints the identical
  checksum to node/bun.
- **SA2** (literal-only tail) — `s = s + "x"` emits `write!(s, "{}", "x").unwrap()`
  (single tail part).
- **SA3** (multiple mixed tail parts) — `s = s + a + "-" + b` (string vars + literal)
  emits one `write!` with all three tail parts in order; output identical.
- **SA4** (idempotent / re-run safe) — running the pass twice yields the same node (the
  rewritten `strAppend` is no longer a `strConcat`-valued assign, so it is not re-matched).

## Negative — keeps `format!` (each isolates a non-append shape; soundness-critical)

- **SA5** (prepend) — `s = "x" + s`: the accumulator is **not** the head, so an in-place
  append would corrupt order — stays `format!("{}{}", "x", s)`. Output identical to
  node/bun (proves we don't silently reorder).
- **SA6** (accumulator not head / spliced) — `s = a + s + b`: `S` appears but is not
  `parts[0]`, so it is not a plain append — stays `format!`.
- **SA7** (different binding) — `t = s + "x"` where `t` and `s` are distinct locals: not a
  self-append (head is `s`, target is `t`) — stays `format!` (this is a genuine new-string
  build, and mutating `s` in place would be wrong).
