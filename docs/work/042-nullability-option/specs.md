# 042 — specs

## 042a — Option core + `??` (`packages/compiler/tests/option-core.test.ts`)

- **OPT1** `const x: number | undefined = 5; console.log(x ?? 0)` → `5`; emitted
  contains `Option<f64>`, `Some(5.0)`, `.unwrap_or(`.
- **OPT2** `const x: number | undefined = undefined; console.log(x ?? 0)` → `0`;
  emitted contains `None`.
- **OPT3** `const s: string | null = null; console.log(s ?? "fb")` → `fb`
  (`null` also maps to `None`).
- **OPT4** `??` passes a present value through: `const x: number | undefined = 3;
  console.log(x ?? 9)` → `3`.
- **OPT5** an optional param `(x?: number)` lowers to `Option<f64>` and its body
  can `x ?? d`.
- **OPT6** (fail-loud) a union of two real types (`number | string`) stays
  `UnsupportedError` (that is enum/union territory, not nullability).

Later slices (042b optional fields + Debug print, 042c equality/narrowing, 042d
optional chaining + `find`) have their own spec files.
