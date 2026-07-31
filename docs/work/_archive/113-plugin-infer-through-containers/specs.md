# 113 — specs (PIC1–PIC6)

Graduates #97. Design: `./design.md`. Tests: `packages/compiler/tests/plugin-infer.test.ts`
(registry + lowering + negatives as `test()`s; behavior parity via
`defineDifferential("plugin-infer", …)`). `leftPad` = the reference plugin
`@ttr/plugin-leftpad`.

## Registry (unit)

- **PIC1** — `typeResolvablePluginSpecifiers()` **includes** `@ttr/plugin-leftpad`
  (a pure expand-to-HIR plugin) and **excludes** `@ttr/std` (`SPECIAL_LOWERED`): the
  scope guard that keeps `@ttr/std`'s fallible surface off oracle auto-inference.

## Lowering (unit — the headline graduation)

- **PIC2** — `const a = [leftPad("7",3,"0"), leftPad("42",4,"*")]` (no annotation)
  now **compiles** (previously threw `UnsupportedError` "without a type
  annotation"). The emitted Rust binds `a` to a `vec![ttr_plugin_leftpad::left_pad(…), …]`
  and Rust infers `Vec<String>`.

## Behavior parity (differential — TS-under-Bun vs emitted Rust)

- **PIC3** — array-literal binding: `const a = [leftPad("7",3,"0"), leftPad("42",4,"*")]; console.log(a.join(","))`
  ⇒ `007,**42`.
- **PIC4** — nested array literal (`Vec<Vec<String>>`):
  `const a = [[leftPad("7",3,"0")], [leftPad("42",4,"*")]]; console.log(`${a[0][0]}${a[1][0]}`)`
  ⇒ `007**42`. (A template literal, not `+`: `String + String` via index is a
  pre-existing general concat limitation — it breaks on an annotated `string[][]`
  too — so it is deliberately avoided here.)

## Negatives — the change does not over-broaden

- **PIC5** — anonymous **object** literal binding stays fail-loud:
  `const o = { a: leftPad("7",3,"0") }` (no annotation) still throws
  `UnsupportedError` "without a type annotation" — matches `const o = { a: "x" }`;
  object shapes need a named struct, plugin or not.
- **PIC6** — a user's own local `leftPad` (no plugin import) inside an array is
  **not** hijacked (regression guard: resolution is specifier-anchored, never a
  name heuristic).

## Gate (not a unit spec)

- `bun run lower:verify` stays byte-identical (62 entries) — resolving plugin
  specifiers only newly-succeeds previously-throwing cases.

## Out of scope (noted follow-ups)

- A plugin call inside a `.map`/`.filter` callback — the callback-body lifter is
  numeric-only, a separate capability.
- `String + String` via indexed access — a pre-existing general string-concat gap
  independent of plugins.

## Impl-plan

1. `plugins.ts`: `typeResolvablePluginSpecifiers()` (registered − `SPECIAL_LOWERED`) + PIC1.
2. `type-oracle.ts`: resolve those specifiers to their on-disk entry, serve the
   file in both hosts, route in `resolveModuleNames`. RED→GREEN PIC2–PIC4.
3. Confirm PIC5/PIC6 (already-correct behavior preserved) + `lower:verify` green.
