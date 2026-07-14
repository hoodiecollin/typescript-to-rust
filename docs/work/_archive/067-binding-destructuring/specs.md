# 067 — Binding destructuring specs (exact-arity)

> Drives `emit(...)` / the differential oracle. IDs map to
> `packages/compiler/tests/binding-destructure.test.ts`. Scope = the exact-arity
> shapes graduated by issue #34 (object-pattern over a named struct, array-pattern
> over a fixed-arity tuple source). Vec-source array-patterns and rest stay
> fail-loud (deferred to #42 / later series).

## Object-pattern over a named struct

- **BD1 (emit)** `const { x, y } = point` over a struct-typed source emits a Rust
  struct pattern `let Point { x, y } = point;`.
- **BD2 (differential)** the destructured fields carry the source values;
  `console.log(x, y)` matches TS.
- **BD3 (differential, source live)** the source `point` used after the destructure
  still works (ownership pass clones the non-`Copy` source), matching JS where the
  source stays usable.
- **BD4 (differential, source dead)** a source unused after the destructure is a
  bare move (no clone), same observable output.
- **BD5 (fail-loud)** a renamed field `const { x: px } = point` is `UnsupportedError`
  (shorthand-only, mirrors 064).
- **BD6 (fail-loud)** a rest element `const { x, ...rest } = point` is
  `UnsupportedError` (rest deferred).

## Array-pattern over a fixed-arity tuple

- **BD7 (emit)** `const [a, b] = [e0, e1]` (a fixed-arity array literal source) emits
  a Rust tuple binding `let (a, b) = (e0, e1);`.
- **BD8 (differential)** the tuple binding preserves element order; `console.log(a, b)`
  matches TS.
- **BD9 (differential, three elements)** `const [a, b, c] = [e0, e1, e2]` binds all
  three in order.
- **BD10 (fail-loud)** an array-pattern over a `Vec`-typed identifier source
  `const [a, b] = arr` is `UnsupportedError` pointing at #42 (out-of-bounds is
  `undefined`; no `undefined` model yet).
- **BD11 (fail-loud)** an array-pattern arity mismatch (pattern arity ≠ literal
  arity) is `UnsupportedError`.
- **BD12 (fail-loud)** a rest element `const [a, ...rest] = [1, 2, 3]` is
  `UnsupportedError` (rest deferred).

## Unregressed prior art

- **BD13 (differential)** the 051a `const [a, b] = await Promise.all([…])` tuple
  destructure still binds `let (a, b) = …` and runs.
