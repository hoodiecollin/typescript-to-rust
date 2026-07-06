# 031 — Specs

Drives the public `emit(...)` entry (whole pipeline). Each gap has GREEN specs
(the fix compiles + behaves, verified against the Bun run) and, where a full fix
is out of scope, a fail-loud spec (`UnsupportedError`). Test file:
`tests/fail-loud-holes.test.ts`. Flagship cases also land as corpus fixtures
(tier-1 compile + tier-2 differential).

## Gap A — integer args across call boundaries

- **A1** `at([10,20,30], 1)` where `at(xs, i)` indexes `xs[i]` (free fn) → the
  literal `1` retypes to `usize`; prints `20`. *Was: `at(&xs, 1.0)` → E0308.*
- **A2** `g.at(2)` on a class whose `at(i)` indexes a field → method arg retypes;
  prints `30`.
- **A3** `new Ring([10,20,30], 2)` where the ctor indexes `xs[i]` → ctor arg
  retypes; prints `30`.
- **A4** `at([10,20,30], k)` with `const k: number = 1` (a non-literal `f64`
  argument at a `usize` parameter) → `UnsupportedError` (inter-procedural integer
  inference is a later series; honest refusal, not broken Rust).

Fixture: `04_data_structures/07_index_param` (`20`).

## Gap C — Rust-keyword identifier hygiene

- **C1** `const box: number = 42` → `let r#box …`; prints `42`.
- **C2** `interface Node { type: number }`, `n.type`, `{ type: 7 }` → every site
  emits `r#type`; prints `7`.
- **C3** `function match(a) { return a }`, `match(5)` → `fn r#match`; prints `5`.
- **C4** `const Self: number = 1` → `UnsupportedError` (`Self` cannot be a raw
  identifier). `self` (lowered from `this`) is exempt and still emits bare.

Fixture: `01_variables/04_keyword_ident` (a `box`-named binding of a `type`-fielded
struct; prints `7`).

## Gap E — HashMap index-assignment → insert

- **E1** `m["b"] = 2` on a `Record<string, number>` → `m.insert("b".to_string(),
  2.0)`; reads back `2`. *Was: `m["b"] = 2.0` → E0594 (read-only `Index`).*
- **E2** `m["a"] = 9` overwriting an existing key → prints `9`.
- **E3** `arr[1] = 5` (a numeric `Vec` index-assign) is unchanged (valid via
  `IndexMut`); prints `5` — proving the string-vs-numeric-key discrimination.

Fixture: `04_data_structures/06_hashmap_write` (`7`).

## Documented residuals (not silent — either fail loud or cargo-caught)

- A non-literal HashMap key write (`m[k] = v`, `k` a variable) stays an
  index-assign (can't be told from a `Vec` write without a binding-type table) —
  rarer; cargo-caught, not silent-wrong.
- An unresolved method receiver (chained/computed) skips gap-A reconciliation.
- A user binding literally named `self` passes through (rare; cargo-caught).
