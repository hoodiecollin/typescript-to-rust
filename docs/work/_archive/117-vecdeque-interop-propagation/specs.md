# 117 — Specs: VecDeque interop + cross-boundary propagation

Spec file: `packages/compiler/tests/vecdeque-interop.test.ts`. Cargo-compiled +
differential (Rust stdout === TS-via-Bun stdout). Issue #101.

## Cross-boundary propagation (residual #1 — full call-graph)

- **VD1** backward `param→arg`: `function drain(q: number[]): number { return q.shift() ?? -1; }`
  with `drain(a)` on a plain `const a = [1,2,3]` — `q` is deque inside `drain` (front-mutated),
  so `a` is promoted to `VecDeque` at the caller. Asserts `VecDeque` in emit, `pop_front` in
  `drain`, `deque_from_vec` on `a`; runtime parity.
- **VD2** forward `arg→param`: caller's `a` is front-mutated (`a.unshift(0)`) then passed to
  `fn total(xs: number[])` that only reads — `total`'s param flips to `VecDeque` (or borrows a
  slice). Runtime parity.
- **VD3** `return`: `function make(): number[] { const q=[1,2,3]; q.unshift(0); return q; }` —
  `make`'s **ret** flips to `VecDeque<f64>`; `const x = make()` binds a deque **without**
  double-wrapping (`x` is not `deque_from_vec`'d again). Runtime parity.
- **VD4** alias: `const a=[1,2,3]; a.unshift(0); const b=a;` — `b` inherits deque class (no
  re-wrap of `b`). *(If aliasing forces `Rc<RefCell>` this instead exercises the borrow;
  keep the alias a straight rebinding.)*
- **VD5** chained boundary: deque threaded caller→callee→callee (two hops) stays deque the
  whole way (fixpoint convergence across a 2-edge chain).
- **VD6** `&mut` param mutation reflects back: `function pushFront(q: number[]) { q.unshift(0); }`
  called on a caller binding — the param is `&mut VecDeque`, mutation visible after the call
  (the by-ref case convert-at-boundary could **not** do — this is why full propagation).

## Vec-only ops on a deque binding (residual #2 — interop wiring)

- **VD7** `sort()` (default) on a front-mutated binding →
  `sort_default(tslib::array::deque_as_slice_mut(&mut a))`; JS lexicographic order parity.
- **VD8** `sort((x,y)=>x-y)` (comparator) on a deque → `sort_by(deque_as_slice_mut(&mut a), …)`.
- **VD9** `join(",")` on a deque → `&tslib::array::deque_to_vec(&a)` coerced to `&[T]`; string parity.
- **VD10** `concat(b)` on a deque receiver (and/or a deque argument) → `deque_to_vec` at the
  boundary; fresh `Vec` result, element parity.
- **VD11** `flat()` on a deque-of-arrays receiver → `deque_to_vec` boundary; parity.
- **VD12** in-place `sort` then continued **front** mutation (`shift`) on the same binding —
  proves `make_contiguous` sort does not break the deque (still a `VecDeque` after).

## Multi-arg push / unshift (residual #3)

- **VD13** statement `a.push(x, y)` → two `push_back`s in order; length + elements parity.
- **VD14** value `const n = a.push(x, y)` → `{ a.push(x); a.push(y); a.len() as f64 }`; `n` parity.
- **VD15** `a.unshift(x, y)` on a deque → front becomes `[x, y, …orig]` (JS order) via
  `push_front` in **reverse**; parity.

## Corpus workload

- **VD-corpus** a front-mutated work queue (`unshift`/`shift`) passed into a free `process`
  function and then `sort`+`join`ed for output — the combined cross-boundary + interop path
  in one realistic script. Lives in the corpus fixtures, differential-checked.

## Characterization / guards (stay honest)

- **VD-neg-method** a genuinely unresolvable name-keyed cross-class method-param collision
  stays `UnsupportedError`/cargo-loud (documented limitation, mirrors ownership `methodParams`).
- Existing `array-mutations.test.ts` (13/13) and all prior array specs (Vec literals,
  indexing, `.length`, adapters, sort/join/concat/flat on plain Vecs) still green — a plain
  Vec array is byte-unchanged (the `&mut [T]` sort signature coerces).

## Verification gate

- `vecdeque-interop.test.ts` all green (cargo + differential).
- `array-mutations.test.ts` 13/13 still green.
- Full compiler suite no regression.
