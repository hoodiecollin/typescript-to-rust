# 057 — Non-Copy element callbacks + index param — specs

Differential-oracle BDD specs (compile → cargo run → match TS-via-Bun). Each pins
**behavior** and, where the point is the shim shape, the **emitted Rust**. Test IDs
map to `packages/compiler/tests/noncopy-callbacks.test.ts`.

Dialect note: arrays are `Array<T>`; a bare-`T[]` annotation is out of dialect. The
`number` type is uniformly `f64`.

## Non-Copy element passing (the local read/consume classifier)

- **NCB1 — read-only struct element → `&T`, no clone (map).**
  `pts.map(p => p.x + p.y)` lifts to `fn __cb_map_1(p: &Point) -> f64` and the shim
  forwards the borrow: `.iter().map(|p| __cb_map_1(p))`. No `.clone()`.

- **NCB2 — read-only struct predicate → `&T`, `.cloned()` terminal (filter).**
  `pts.filter(p => p.x > 2)` → `fn __cb_filter_1(p: &Point) -> bool`, shim
  `.iter().filter(|p| __cb_filter_1(*p)).cloned()` (a filter predicate receives
  `&&T`; the borrow case derefs one level, and the non-Copy terminal is `.cloned()`,
  not `.copied()`).

- **NCB3 — consumed String element → owned `String`, `.clone()` (map).**
  `strs.map(s => s)` returns the element by value, so the lifted fn owns it:
  `fn __cb_map_1(s: String) -> String`, shim `.iter().map(|s| __cb_map_1(s.clone()))`.

- **NCB4 — consumed struct element → owned `T`, `.clone()` (map).**
  `pts.map(p => p)` → `fn __cb_map_1(p: Point) -> Point`, shim `.clone()` at the
  boundary. Differential-matches (a round-trip of the elements).

- **NCB5 — read-only struct predicate (some) → `.any`, borrow.**
  `pts.some(p => p.x > 2)` → `.iter().any(|p| __cb_some_1(*p))` → `bool`.

- **NCB6 — read-only struct predicate (find) → `.cloned()`, borrow.**
  `pts.find(p => p.x > 2) !== undefined` → `.iter().find(|p| __cb_find_1(*p))
  .cloned().is_some()`; the lifted fn takes `p: &Point`.

## Index param `(el, i)` → `.enumerate()`

The callback index joins the f64 numeric surface (decision 2026-07-09): `number` is
uniformly `f64` and JS's index *is* a number, so the shim forwards `i as f64`. This
admits arithmetic bodies and lets the result bind to `Array<number>` (a `usize`
index would clash with the f64 literals/result and admit only a bare `i`).

- **IDX1 — index used arithmetically.**
  `nums.map((x, i) => x + i)` → `.iter().enumerate().map(|(i, x)| __cb_map_1(*x,
  i as f64))`, `fn __cb_map_1(x: f64, i: f64) -> f64`. `[10,20,30]` → `10 21 32`.

- **IDX2 — bare index.**
  `nums.map((x, i) => i)` → `0 1 2`.

## Fail-loud residuals (stay rejected — `UnsupportedError`)

- **FL1 — whole-array third param `(el, i, arr)`.** Forces a second borrow of the
  receiver mid-iteration → rejected.

- **FL2 — non-Copy element in `reduce`/`sort`.** Element borrowing is wired for
  `map`/`filter`/`find`/`some`/`every` only; a non-Copy `reduce`/`sort` element
  stays fail-loud.

- **FL3 — unclassifiable element flow.** The local walk can't prove read-only or a
  clean consume (e.g. the element is reassigned) → rejected, no silent clone.
