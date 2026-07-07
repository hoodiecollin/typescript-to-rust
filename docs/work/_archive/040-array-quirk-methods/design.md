# 040 — Array quirk methods: `sort` / `slice` (plan)

From the 029 catalog (Tier 1 · Array — access/mutation) — both route to `tslib`
(Route **Tf**) because their JS runtime semantics diverge from the obvious Rust.

## `sort` — default lexicographic string compare (Tf)

`xs.sort()` in JS compares elements **as strings** by default, in place, returning
the array. For numbers that is the classic quirk: `[10, 1, 2].sort()` → `[1, 10, 2]`
(not `[1, 2, 10]`). Rust's `Vec::sort` needs `Ord` (which `f64` lacks) and would
sort numerically anyway — so this is confined to `tslib::array::sort_default`,
which sorts by `.to_string()` (`10.0.to_string() == "10"`, so string order matches
JS exactly).

`xs.sort((a, b) => e)` with a **comparator** routes to `tslib::array::sort_by`,
which takes an `Fn(T, T) -> f64` closure and maps its sign to `Ordering`
(`< 0` → `Less`, `> 0` → `Greater`, else `Equal`, mirroring JS). The comparator is
the two-param closure shape from 039; params are plain (owned Copy) values.

- Recognized in **statement / expression position**; `sort` returns `()` here
  (the JS "returns self" is a residual — aliasing the result is fail-loud/cargo).
- `sort` with a non-arrow argument is fail-loud.
- The receiver is already marked `mut` (`analysis.MUTATING_METHODS`), so
  `&mut xs` is well-formed.

## `slice` — clamped, negative-aware sub-array (Tf)

`xs.slice(start[, end])` clamps out-of-range and interprets negative indices from
the end, `end` exclusive and optional (defaults to `len`). Confined to
`tslib::array::slice(&xs, start, end)` / `slice_from(&xs, start)`, returning a
**cloned** `Vec<T>` (JS slice is a shallow copy). Numeric args arrive as owned
`f64` and are floored in the crate (the `at` precedent — no codegen `as usize`).
No-arg `slice()` is fail-loud this slice.

## Differential proof

- `sort()`: `[10,1,2].sort()` then print all three → `1 10 2` (string-order quirk).
- `sort(cmp)`: `[10,1,2].sort((a,b)=>a-b)` → `1 2 10` (numeric — differs from default).
- `slice`: `[1,2,3,4].slice(1,3)` → `[2,3]`; negative `slice(-2)` → `[3,4]`.
