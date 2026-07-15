# 092 — static `flat`-depth + `flatMap` ternary — specs

Specs live in `packages/compiler/tests/flatmap-flat.test.ts` (extending series
085's file — same feature). Differential = emitted Rust runs and its stdout ===
the TS-via-Bun run. The three graduated IDs keep their 085 names (now passing).

## Graduated (was fail-loud in 085 → now differential)

| ID | Source | JS/Rust result | Notes |
|----|--------|----------------|-------|
| **FLATK-FL2** | `number[][][]` · `.flat(Infinity)` | `[[[1]],[[2]]]` → `[1,2]` → `"2"` | `Infinity` → flatten all `N`=2 levels to the scalar leaf |
| **FLATK-FL3** | `number[][]` · `.flat(2)` | `[[1,2],[3,4]]` → `[1,2,3,4]` → `"4 1 4"` | over-deep `flat` = `min(2,1)`=1 level (no under-nested error) |
| **FM-FL1** | `.flatMap(x => x % 2 === 0 ? [x, x] : x)` | `[1,2,3]` → `[1,2,2,3]` → `"4 1 2 3"` | ternary `U\|U[]`; scalar arm wrapped `vec![x]`, result homogeneous `Vec<f64>` |

New graduated:

| ID | Source | Result | Notes |
|----|--------|--------|-------|
| **FLAT-NOOP** | `number[]` · `.flat()` | `[1,2,3].flat()` → `[1,2,3]` → `"3"` | depth-1 on an already-flat array = no-op copy (`min(1,0)`=0 → `.clone()`) |
| **FM-TERN2** | `.flatMap(x => x > 2 ? [x] : [x, x])` | `[1,2,3]` → `[1,1,2,2,3]` → `"5"` | ternary with **both** arms arrays (no scalar wrap needed) |
| **FM-TERN3** | ternary with a captured free var in an arm | forwards through the lift | free-var machinery reused |

## Stays fail-loud (unchanged / deferred to JsonValue)

| ID | Source | Why |
|----|--------|-----|
| **FLATK-FL1** | `.flat(n)` (variable `n`) | runtime depth — not a compile-time constant |
| **FM-FL-HET** *(new)* | `.flatMap(x => [x, [x]])` | genuinely heterogeneous `(U\|U[])[]` — a real dynamic value → epic #59 JsonValue increment |
| **FM-FL-EMPTY** *(new)* | `.flatMap(x => x > 0 ? [] : [x])` | empty-array arm — element type unknown → fail-loud |

## Rationale

JS `flatMap(cb) = map(cb).flat(1)`. A ternary `cond ? scalar : [array]` yields a
homogeneous `U[]` (scalars contribute one element each, arrays are spread one
level). Wrapping the scalar arm `x` as `[x]` makes the lifted callback return a
uniform `Vec<U>`, so `.flat_map` is exact and the result stays statically typed —
no `JsonValue` needed. `flat(k)`/`flat(Infinity)` depth is bounded by the
statically-known nesting `N` of the homogeneous receiver, so the flatten count is
a compile-time constant.
