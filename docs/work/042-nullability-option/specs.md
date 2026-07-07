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

## 042b — optional struct fields (`packages/compiler/tests/option-fields.test.ts`)

- **OFL1** `field?: T` → `Option<T>` struct field; a provided value is `Some`-wrapped.
- **OFL2** a provided optional field is `Some`, an omitted one is filled with `None`.
- **OFL3** the `field: T | undefined` union form also lowers to `Option`.

## 042c — equality + narrowing (`packages/compiler/tests/option-narrow.test.ts`)

- **NRW1** `=== undefined` → `.is_none()`, `!== undefined` → `.is_some()`.
- **NRW2** those behave (true/false differential).
- **NRW3** `if (x !== undefined) { …x… }` → `if let Some(x) = x { … }`.
- **NRW4** the narrowing takes the `else`/`None` path when absent.
- **NRW5** `if (x === undefined) … else …` narrows the else branch (branches swap).
- **NRW6** `null` narrows identically.

## 042d — `find` + optional chaining (`packages/compiler/tests/option-find-chain.test.ts`)

- **FND1/2** `xs.find(p)` → `.iter().find(|&&x| p).copied()` → `Option<T>`, via `??`.
- **FND3** the `find` result narrows with `if let`.
- **CHN1/2** `a?.b` → `a.map(|v| v.b)` → `Option<…>`.
- **CHN3** a deeper chain (`a?.b?.c`) is fail-loud (a later slice).
