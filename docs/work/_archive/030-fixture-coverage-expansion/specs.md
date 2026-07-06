# 030 — Specs

Two kinds of spec: **GREEN** behavioral fixtures (shipped, passing) and **RED**
gap repros (documented failures routed to owning series, *not* fixed here).

## GREEN — behavioral fixtures (tier 2 differential, all passing)

Each is a complete program; emitted Rust stdout must equal the Bun-run TS stdout
and the pinned value. Driven by `tests/fixture-differential.test.ts`; also
tier-1 compile-checked via `compiler.test.ts` `SUPPORTED`.

| Fixture | Pinned stdout |
|---|---|
| `01_variables/03_compound_assign` | `13` |
| `02_control_flow/06_nested_if` | `B` |
| `02_control_flow/07_while_nested_if` | `5` |
| `02_control_flow/08_switch_multi_stmt` | `two` |
| `02_control_flow/09_forof_print` | `7\n8\n9` |
| `03_functions/03_recursion_factorial` | `120` |
| `03_functions/04_recursion_fibonacci` | `55` |
| `03_functions/05_nested_calls` | `26` |
| `03_functions/06_triple_nest` | `3` |
| `03_functions/07_bool_return` | `pos` |
| `03_functions/08_precedence_mix` (`a*b + c*d`) | `26` |
| `03_functions/09_left_assoc` (`a - b - c`) | `5` |
| `03_functions/10_modulo` | `2` |
| `03_functions/11_negative` (`0 - n`) | `-7` |
| `03_functions/12_string_concat` | `hi ada` |
| `04_data_structures/04_matrix` | `10` |
| `04_data_structures/05_array_of_structs` | `5` |
| `05_interfaces/02_nested_struct` | `3` |
| `06_classes/02_multi_method` | `24` |
| `06_classes/03_getter_method` | `212` |
| `07_async/02_multi_await` | `3` |
| `10_ownership/05_struct_borrow` | `42` |

## RED — gap repros (documented, routed, not fixed in 030)

Minimal reproductions of the five gaps in design.md. These are the specs the
owning series turn green; kept here as the audit trail of what 030 surfaced.

- **A — integer-arg retyping across call boundaries.**
  `function cell(m: Array<Array<number>>, i: number, j: number): number { return m[i][j]; }`
  called `cell(grid, 1, 0)`. `i`/`j` infer `usize` in the signature, but the
  literal args emit as `1.0`/`0.0` → `cargo check` E0308. *Emits broken Rust
  (fail-loud hole).*
- **B — nested struct literal.**
  `const l: Line = { start: { x: 0, y: 0 }, end: { x: 3, y: 4 } };` → the inner
  `{ x, y }` is not recognized as a `Point` struct literal → `UnsupportedError`
  ("object literal without a Record type"). *Already fail-loud.* Green route:
  bind the inner literals to typed `const`s first (`05_interfaces/02_nested_struct`).
- **C — Rust-keyword identifier collision.**
  `const box: Bag = …` → emits `let box: … ` and `box` is a Rust keyword → Rust
  parse error. *Emits broken Rust (fail-loud hole).* Green route: avoid keyword
  identifiers (rename); the struct name `Box` also shadows `std::boxed::Box`.
- **D — parenthesized expression / precedence.**
  `return (a + b) * c;` → `ParenthesizedExpression` is unmodeled →
  `UnsupportedError`. *Already fail-loud.* This masks the flat-precedence
  printing gap (emitter renders `binary` with no parenthesization); supporting
  parens without precedence-aware printing would emit `a + b * c`. Folds into 026.
- **E — HashMap index-assignment.**
  `const m: Record<string, number> = { "a": 1 }; m["b"] = 2;` → emits
  `m["b"] = 2.0`; `HashMap`'s `Index` is read-only → `cargo check` E0594.
  *Emits broken Rust (fail-loud hole).* Correct lowering: `m.insert("b".to_string(), 2.0)`.
