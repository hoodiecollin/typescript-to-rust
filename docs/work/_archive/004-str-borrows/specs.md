# 004 — Specs

Unit specs drive `refineStrings` on HIR produced by real `lower(...)`, so the
input is realistic. IDs are referenced from the test file. `refineStrings` is
idempotent, so re-applying it to `lower`'s (already-refined) output is safe.

`&str` is `{ kind: "ref"; mut: false; inner: { kind: "str" } }`;
`&mut String` is `{ kind: "ref"; mut: true; inner: { kind: "String" } }`.

## Unit — `refineStrings` (`tests/strings.test.ts`)

- **S1** A read-only `string` parameter lowers to `&str`.
  `function greet(name: string): void { console.log(name); }` →
  `greet`'s param `ty` is `&str` (`ref`, not `mut`, inner `str`).

- **S2** A mutated `string` parameter stays `&mut String`.
  A parameter reassigned or grown in the body keeps `ty` = `&mut String`
  (inner stays `String`; `&mut str` is never produced).

- **S3** A moved (owned) `string` parameter stays `String`.
  A parameter that is not used at all — ownership `move` — keeps `ty` =
  `{ kind: "String" }` (not a `ref`, untouched).

- **S4** A non-string reference parameter is untouched.
  A read-only `Array<number>` parameter keeps `ty` = `&Vec<f64>` (the pass only
  rewrites `String` inners).

- **S5** Refinement is per-item and touches every function.
  Two functions each with a read-only string param both get `&str`
  independently.

- **S6** The pass is idempotent.
  `refineStrings(refineStrings(m))` equals `refineStrings(m)` — a param already
  `&str` is left as `&str`.

## Oracle — fixture (`tests/compiler.test.ts`)

- **F1** `10_ownership/04_str_borrow.ts` — a fn with a read-only string param,
  called from a top-level script passing a `String` variable, printing it —
  compiles (tier-1 COMPILES) and its emitted Rust prints the same stdout as the
  TypeScript (tier-2 BEHAVES differential).
