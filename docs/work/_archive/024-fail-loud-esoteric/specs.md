# 024 — Specs

Drives the public `emit(...)` entry (whole pipeline). `DialectError` =
forbidden-flag rejection; `UnsupportedError` = default-deny on an unmodeled node
type. RED today: EF1–EF9 currently *do not throw* (silent mistranslation) or
throw the wrong class.

## Forbidden flags → `DialectError`

- **EF1** `function* g(): void { console.log("x"); }` (sync generator, no
  `yield`, body lowers cleanly) → `DialectError`. *RED: emits a plain `fn`.*
- **EF2** `async function* g(): void { console.log("x"); }` (async generator) →
  `DialectError`.
- **EF3** `async function f(xs: number[]): Promise<void> { for await (const x of xs) { console.log(x); } }`
  (`for await`) → `DialectError`. *RED: `await` flag dropped, emits ordinary
  `for`.*
- **EF4** `function f(): void { using r = acquire(); }` (`using`) →
  `DialectError`. *RED: emits plain `let`.*
- **EF5** `async function f(): Promise<void> { await using r = acquire(); }`
  (`await using`) → `DialectError`.
- **EF6** `@sealed class C {}` (class decorator) → `DialectError`. *RED:
  decorator dropped, bare struct emitted.*
- **EF7** `class C { @log m(): void {} }` (method decorator) → `DialectError`.
- **EF8** `abstract class C { m(): void {} }` (abstract class) → `DialectError`.
  *RED: `abstract` dropped, normal impl emitted.*
- **EF9** `declare function f(): void;` (ambient declaration) → `DialectError`.
  *RED today: throws `UnsupportedError` (no body), want `DialectError`.*

## Default-deny on unmodeled node type → `UnsupportedError`

- **EF10** `enum E { A, B }` (`TSEnumDeclaration`) → `UnsupportedError`.
- **EF11** `namespace N {}` (`TSModuleDeclaration`) → `UnsupportedError`.
- **EF12** `class C { constructor(public x: number) {} }` (`TSParameterProperty`
  — the field is silently dropped today) → `UnsupportedError`.

## Regression guards (must stay GREEN)

- **EF13** A normal program with a non-generator function and a plain `for…of`
  compiles without throwing:
  `function sum(xs: number[]): number { let t = 0; for (const x of xs) { t += x; } return t; }`
- **EF14** `DialectError` and `UnsupportedError` are distinct classes
  (`DialectError.prototype` is not an `UnsupportedError`), so callers can
  discriminate "fix your input" from "not implemented yet".
- **EF15** The existing `any`/`unknown` rejections (series 005 V1–V6) still throw
  `DialectError` — default-deny did not disturb them. (Covered by
  `validate.test.ts`; noted here for traceability.)
