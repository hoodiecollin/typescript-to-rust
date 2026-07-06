# 035 specs — sync generators → `impl Iterator`

Transcribed as BDD tests in `packages/compiler/tests/generators.test.ts`
(differential: emitted Rust compiles **and** its stdout matches the Bun-run TS).

1. **A finite-yield generator, consumed by for-of, behaves.**
   `function* g(): Generator<number> { yield 1; yield 2; yield 3; }` +
   `for (const x of g()) console.log(x)` → `1\n2\n3`.
2. **Emits `impl Iterator` + `into_iter()`, and the for-of has no `.iter()`.**
   Rust contains `fn g() -> impl Iterator<Item = f64>`,
   `vec![1.0, 2.0, 3.0].into_iter()`, `for x in g() {`, and **not** `g().iter()`.
3. **A parameter is captured into the yielded sequence.**
   `function* g(n: number): Generator<number> { yield n; yield n*2; yield n*3; }`
   consumed with `g(5)` → `5\n10\n15`.
4. **A non-yield statement in the body fails loud** (`UnsupportedError`) — the
   state-machine slice is deferred.
5. **A yield inside a loop fails loud** (`UnsupportedError`) — needs a state machine.
6. **A generator without a `Generator<T>` return annotation fails loud**
   (`UnsupportedError`) — the item type can't be inferred.
7. **An async generator is rejected** (`DialectError`) — needs `Stream` (out of std).

Also updated `esoteric-reject.test.ts` EF1: a sync generator with an unsupported
shape now fails loud as `UnsupportedError` (unimplemented shape), not
`DialectError` (forbidden) — generators are no longer blanket-forbidden.

All 7 green; full suite 345 pass / 1 todo / 0 fail at landing.
