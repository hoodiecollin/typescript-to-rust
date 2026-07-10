# 059 — Struct / interface deferrals · specs

Differential oracle: emitted Rust compiles **and** its run matches the TS run (via
Bun), plus emitted-text checks and fail-loud `DialectError` checks.

## `interface B extends A` — trait-based (Fork 1)

1. **polymorphism** — `function useA(a: A)` accepts a `B` (`useA(b)`); emits `trait
   IA`, `impl IA for A`, `impl IA for B`, and `fn useA(a: &impl IA)`; differential.
2. **multi-level** — `C extends B extends A`; a `C` passes where `A`/`B` are
   expected; base fields flatten through the chain.
3. **direct access stays direct** — a concretely-typed binding (`const a: A = …`)
   reads `a.x` as a plain field (not a getter call).

## `readonly` (Fork 2, validator-enforced)

4. **assignment rejected** — `p.id = 5` where `id` is `readonly` → `DialectError`.
5. **construction allowed** — a struct literal initializing a `readonly` field
   compiles and runs.

## Arg-position struct literals (032 residual)

6. **arg literal** — `f({x:1, y:2})` where `f`'s param is a struct type → lowers to
   `f(Point { x, y })`; differential.

## Local struct field mutation

7. **`s.x = v`** on a local binding → `let mut s`; differential-match (the binding
   is declared mutable, the field write compiles).

## Fail-loud residuals

8. **readonly assignment** — the `DialectError` above (the point of Fork 2).
9. **anonymous-object arg literal with no nameable target type** — no struct to
   construct (same boundary as 058's destructuring rule).
