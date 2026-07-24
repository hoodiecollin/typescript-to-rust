# 116 — Specs: array mutation methods

Spec file: `packages/compiler/tests/array-mutations.test.ts`. Cargo-compiled +
differential. Issue #78. **13/13 green.**

## Vec arrays: push/pop (characterization — already worked pre-116)

- **AM1** push (statement) appends — `a.push(1)` → `a.push(1)`; length + elements match.
- **AM2** pop → `Option`, `a.pop() ?? -1` threads the 066 model.
- **AM3** pop on empty → `undefined` parity.
- **AM4** push non-Copy (`string[]`) + pop moves an owned `String`.

## VecDeque arrays: shift/unshift (front mutation → `VecDeque`)

- **AM5** shift → `pop_front` on a `VecDeque`; decl is `VecDeque<f64>`, construction
  `tslib::array::deque_from_vec(vec![…])`; asserts `VecDeque` in the emit.
- **AM6** unshift → `push_front`.
- **AM7** push+shift FIFO queue — both route to the deque back/front (`push_back`/`pop_front`).
- **AM8** index + `for…of` + `.length` on a `VecDeque` array (cross-container ops native).

## splice (full support, tslib helper)

- **AM14** remove → returns removed `Vec<T>`, mutates receiver.
- **AM15** remove+insert (`splice(1, 1, 9, 8)` → `deque`/`Vec` helper with `vec![9, 8]`).
- **AM16** insert-only (`deleteCount 0`).
- (one-arg `splice(start)` delete-to-end verified manually via the `f64::INFINITY`
  clamp; the helper clamps to `len - start`.)

## Return values

- **AM18** push returns the new length when consumed → the `arrayMutLen` block
  `{ a.push(x); a.len() as f64 }`.
- **AM19** unshift returns the new length on a `VecDeque` binding (`push_front` block).

## Residuals (filed, not silently capped)

- **Cross-boundary `VecDeque` propagation** — a front-mutated binding passed to / returned
  from a fn typed `Vec` stays `Vec` at the boundary → **cargo-loud** mismatch (never a
  silent divergence). Whole-program propagation is a follow-up (**#101**).
- **`Vec`-only ops on a `VecDeque` binding** (`sort`/`join`/`concat`/`flat`) — the interop
  helpers exist (`tslib::array::deque_as_slice_mut`/`deque_to_vec`) but `refineDeque` does
  not yet route them → cargo-loud today (**#101**).
- **Multi-arg `push(x, y)`** — single-arg only in this cut; multi-arg falls through
  (cargo-loud). Minor follow-up.

## Verification gate

- `array-mutations.test.ts` 13/13 green.
- Existing array specs (literals, indexing, `.length`, non-mutating adapters, join/concat/
  flat, sort) still green — a Vec array is unchanged; only a front-mutated binding switches
  container.
- Full compiler suite no regression.
