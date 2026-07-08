# 048 — specs

Spec-ID prefix `LIFT`. Differential specs assert **both** the runtime behavior
(TS-run-via-Bun stdout == Rust stdout) **and** that the emitted Rust contains the
lifted `fn` + forwarding shim — the whole point of the reframe is the *shape*, so we
pin it.

## 048a — lift anonymous callback bodies + shim (`packages/compiler/tests/lift-callbacks.test.ts`)

- **LIFT1** `const xs = [1,2,3]; console.log(xs.map(x => x * 2))` → `[2, 4, 6]`;
  emitted contains a lifted `fn __cb_map_1(x: f64) -> f64` and the shim
  `.iter().map(|x| __cb_map_1(*x, )).collect::<Vec<_>>()` (no free vars → empty
  forward list).
- **LIFT2** `xs.filter(x => x > 1)` behaves (differential over the survivors) and
  emits `fn __cb_filter_1(...) -> bool` + `.filter(|x| __cb_filter_1(**x, ))` +
  `.copied()`.
- **LIFT3** `xs.forEach(x => console.log(x))` behaves and lowers to
  `for &x in xs.iter() { __cb_foreach_1(x, ); }` (the lifted fn is a `-> ()` body).
- **LIFT4** (green control) a program with no callbacks emits no `__cb_` fn.

## 048b — read-only scalar forwarding (`packages/compiler/tests/lift-forward.test.ts`)

- **LIFT5** `const bump = 10; console.log([1,2,3].map(x => x + bump))` → `[11, 12,
  13]`; emitted contains `fn __cb_map_1(x: f64, bump: f64) -> f64 { x + bump }` and
  the shim `.map(|x| __cb_map_1(*x, bump))` (the read-only scalar is forwarded by
  value).
- **LIFT6** the differential is correct when the forwarded scalar changes the result
  (`bump = 100` → `[101, 102, 103]`).
- **LIFT7** `reduce`: `const seed = 5; console.log([1,2,3].reduce((a, x) => a + x,
  seed))` → `11`; emits `.fold(seed, |acc, x| __cb_reduce_1(acc, *x, ))` (init seeds
  `acc`; no extra free var here — control that reduce's two-param shape still lifts).
- **LIFT8** two callbacks in one module get distinct hoisted names
  (`__cb_map_1`, `__cb_filter_2`) — no collision.

## 048c — `fn`-pointer values (`packages/compiler/tests/lift-fnptr.test.ts`)

- **LIFT9** a function value param:
  ```ts
  function double(n: number): number { return n * 2; }
  function apply(f: (n: number) => number, x: number): number { return f(x); }
  console.log(apply(double, 5));
  ```
  → `10`; emitted `apply` signature contains `f: fn(f64) -> f64` and the call passes
  the bare fn name `apply(double, 5.0)` (coerces to the pointer). The
  `(n: number) => number` annotation lowers to `fnPtr`, not fail-loud.
- **LIFT10** a non-capturing normalized arrow as a value: `const inc = (n: number):
  number => n + 1; console.log(apply(inc, 5));` → `6` (015's `fn inc` coerces to
  `fn(f64) -> f64`).

## Fail-loud specs

- **LIFT11** (mutable-capture callback rejected) `let total = 0; [1,2,3].forEach(x
  => { total += x }); console.log(total)` stays `UnsupportedError` "mutable capture
  in a callback" — the free var is *assigned*, so it is not forwardable-by-copy.
- **LIFT12** (capturing function value rejected) an arrow that reads an outer local
  passed as an argument (`const y = 3; apply(x => x + y, 5)`) is `UnsupportedError`
  — a capturing value has no `fn`-pointer form (lift it to a named fn taking `y`).
</content>
