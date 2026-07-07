# 040 — specs

Differential specs in `packages/compiler/tests/array-quirk.test.ts`.

- **QRK1** `sort()` default is lexicographic string order (the quirk):
  `[10,1,2].sort()` → printed `1 10 2`, and the route is `tslib::array::sort_default`.
- **QRK2** `sort((a,b)=>a-b)` numeric ascending → `1 2 10` (differs from default),
  route `tslib::array::sort_by`.
- **QRK3** `sort((a,b)=>b-a)` numeric descending → `10 2 1`.
- **QRK4** `sort` with a non-arrow argument is fail-loud.
- **QRK5** `slice(1,3)` → `[2,3]` (start inclusive, end exclusive), route
  `tslib::array::slice`.
- **QRK6** `slice(-2)` (end omitted, negative start) → `[3,4]`, route `slice_from`.
- **QRK7** `slice(1,100)` clamps the end to `len` → `[2,3,4]`.
- **QRK8** (guard) a user class method named `sort`/`slice` is a native call.
