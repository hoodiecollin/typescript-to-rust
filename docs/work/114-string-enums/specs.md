# 114 — Specs: string enums → Rust enum

Spec file: `packages/compiler/tests/string-enums.test.ts`. Cargo-compiled +
byte-identical / differential via the harness. Issue #77.

## Forward mapping & member access

- **SE1** basic — `enum Dir { North = "north", South = "south" }` + `const d = Dir.North`
  → fieldless `enum Dir { North, South }`, `#[derive(Clone, Copy, Debug, PartialEq)]`,
  `Display` arms round-tripping to `"north"`/`"south"`; `Dir::North` for the access.
  Cargo-compiles.
- **SE2** stringify — `` `${Dir.North}` `` (and/or `String(Dir.South)`) prints
  `north`/`south` — differential stdout matches TS.
- **SE3** equality — `d === Dir.North` / `d !== Dir.South` → `d == Dir::North` etc.;
  differential boolean matches.

## Narrowing

- **SE4** switch (**statement position** — assign + `break`) → a `match` over the enum;
  differential stdout matches. NB switch-with-`return`-in-every-case fails E0308 for
  numeric enums too (pre-existing, filed **#98**), so SE4 uses the statement-position shape.
- **SE5** if-chain — `if (d === Dir.North) … else …` narrows; differential matches.

## Shared-path & edge

- **SE6** shares 093 `Display` generator — a string enum and a string-literal union in
  the same program both emit the same `impl Display` shape (assert both compile and
  round-trip; pins that they did **not** diverge into two generators).
- **SE7** keyword-ish member — a member name needing sanitization compiles to a valid
  Rust ident (reuses `sanitizeVariantIdent` keyword guard).

## Negatives (stay fail-loud)

- **SE-mixed** — `enum E { A = 0, B = "b" }` (heterogeneous) → `UnsupportedError`
  (out of scope; not silently mis-lowered).
- **SE-const** — `const enum E { A = "a" }` → `UnsupportedError` (unchanged).
- **SE-computed** — `enum E { A = someFn() }` → `UnsupportedError` (unchanged).

## Verification gate

- `string-enums.test.ts` green (cargo + differential).
- Numeric-enum specs (025a) still green — the numeric `HirEnum`/`emitEnum` path is
  untouched.
- 093 literal-union specs still green — the shared `emitUnionEnum` path is unchanged.
- Full compiler suite no regression.
