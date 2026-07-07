# 041 — specs

`IndexMap` migration is checked by the updated `records.test.ts` (asserts
`IndexMap` in place of `HashMap`); the behavioral record specs
(`compiler.test.ts`, `fail-loud-holes.test.ts` gap E) stay green unchanged.

New differential specs in `packages/compiler/tests/object-methods.test.ts`:

- **OBJ1** `Object.keys(m)` over a 3-key record prints `a b c` (insertion order),
  and the route is `.keys().cloned().collect`.
- **OBJ2** `Object.values(m)` prints `1 2 3` (insertion order).
- **OBJ3** `Object.keys(m).length` is the entry count (`3`).
- **OBJ4** the emitted module imports `use indexmap::IndexMap;`, not
  `std::collections::HashMap`.
- **OBJ5** (fail-loud) `Object.entries(m)` throws `UnsupportedError`.
- **OBJ6** (fail-loud) `Object.assign(...)` throws `UnsupportedError`.
- **REC1′** the record type lowers to `IndexMap<String, f64>` (migrated).
