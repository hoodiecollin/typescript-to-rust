# 005 — Specs

Unit specs drive the public `emit(...)` entry (so the whole pipeline is exercised)
and assert that `any`/`unknown` are rejected with `DialectError` — the
forbidden-input error, distinct from `UnsupportedError` (not-yet-implemented).
IDs are referenced from the test file.

## Unit — `validate` via `emit` (`tests/validate.test.ts`)

- **V1** `any` on a variable is rejected.
  `const x: any = 1;` → throws `DialectError`.

- **V2** `any` on a parameter is rejected.
  `function f(x: any): void {}` → throws `DialectError`.

- **V3** `any` in return position is rejected.
  `function f(): any { return 1; }` → throws `DialectError`.

- **V4** `unknown` is rejected the same way.
  `const x: unknown = 1;` → throws `DialectError`.

- **V5** `any` nested in a type argument is rejected.
  `const xs: Array<any> = [];` → throws `DialectError`.

- **V6** A fully-annotated valid program is not rejected.
  `const n: number = 5; console.log(n);` → does **not** throw (and `DialectError`
  is a distinct class from `UnsupportedError`).
