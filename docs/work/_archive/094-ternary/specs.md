# 094 — Ternary `?:` — specs

Differential specs (compile TS→Rust, `cargo run`, compare stdout to the Bun run).
IDs map to `packages/compiler/tests/ternary.test.ts`.

## Homogeneous (the common case)

| ID | Input shape | Expectation |
|----|-------------|-------------|
| TERN1 | `const n: number = big ? 100 : 0` | prints the chosen branch; emitted Rust contains `if` … `else` |
| TERN2 | `const s: string = ok ? "yes" : "no"` | string arms round-trip |
| TERN3 | `console.log(c ? x : y)` over two `number` locals | untyped position, homogeneous → bare `if`/`else` |
| TERN4 | nested `a ? 1 : b ? 2 : 3` | chained ternary picks the right arm |
| TERN5 | bare-statement ternary `c ? f() : g()` (side effects) | both arms are unit calls; the taken side runs |
| TERN6 | ternary as an arithmetic operand `1 + (c ? 2 : 3)` | parenthesized emission compiles; arithmetic is correct |
| TERN7 | truthy (non-bool) test `n ? "a" : "b"` | routes through `is_truthy` (JS falsy) |

## Typed context (coercion through `lowerTyped`)

| ID | Input shape | Expectation |
|----|-------------|-------------|
| TERN8 | `const x: number \| undefined = c ? 5 : undefined` | present arm `Some`-wrapped, `undefined` → `None` |
| TERN9 | `const sh: Shape = c ? circle : square` (declared named union) | arms coerce to `Shape::Circle(…)` / `Shape::Square(…)` |
| TERN10 | `return c ? 1 : 2` in a `number`-returning fn | typed-return ternary |

## Heterogeneous → auto-synthesized union (§4)

| ID | Input shape | Expectation |
|----|-------------|-------------|
| TERN11 | `console.log(c ? 1 : "a")` | synthesizes `__anonymous_union_<hash>`; prints `1` / `a` via the newtype Display |
| TERN12 | `const x: string \| number = c ? 1 : "a"` | declared-union target: arms coerce to variants (no synthesis) |

## Fail-loud residual

| ID | Input shape | Expectation |
|----|-------------|-------------|
| TERN-FL1 | `console.log(c ? pt : "a")` (struct arm, untyped) | throws `heterogeneous ternary … non-primitive arm …` |

## Refactor guard (092 flatMap ternary)

The existing `flatmap`/092 differentials assert stdout and must stay green after
`liftFlatMapTernaryBody` is flipped to `return (cond node)`.
