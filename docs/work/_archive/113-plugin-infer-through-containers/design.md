# 113 — infer a plugin call's type through a container-literal binding

**Issue:** #97 (`deferral-graduation`). Graduates the one documented v1 residual of
the plugin system (epic #95, series 110). Parent design:
`docs/work/110-plugin-system/design.md` (§"v1 residuals").

## The residual

A plugin-bound intrinsic call is typed **by construction** and binds directly
without an annotation (the `isPluginCallInit` exemption in the binding-annotation
gate):

```ts
const x = leftPad("7", 3, "0"); // ✅ OK — direct-binding exemption
```

The same call nested inside an **array-literal** binding trips the gate:

```ts
const a = [leftPad("7", 3, "0"), leftPad("42", 4, "*")]; // ❌ "binding 'a' without a type annotation"
```

## Root cause (one line, in the oracle)

The gate's last resort before failing loud is the series-099 lib-backed type
oracle (`inferredRustType`). It builds an in-memory `ts.Program` over the input and
infers the initializer's type *through* built-in signatures. But its module
resolver (`type-oracle.ts` `resolveModuleNames`) returns `undefined` for **any
non-`.`-relative specifier** — so the `@ttr/plugin-leftpad` import never resolves,
`leftPad(...)` types as `any`, `[leftPad(...)]` is `any[]`, `rustTypeOf(any)` is
`null`, and the gate throws.

With an explicit annotation the case already works (`const a: string[] = […]`
emits `let a: Vec<String> = vec![ttr_plugin_leftpad::left_pad(…)]`) — the plugin
call lowers fine; only the *binding-type inference* was blind to the plugin's type.

## The fix — generic, in the oracle (not the lowerer)

**Teach the type oracle to resolve registered, type-resolvable plugin specifiers
to their on-disk TS oracle package** — the *same* TS source the differential
harness already runs under Bun. Then `leftPad(...)` types as `string`, and
array-literal inference (`[…]` → `string[]` → `Vec<String>`, incl. nested
`Vec<Vec<String>>`) resolves through the existing series-099 tier with **zero
container-specific logic**.

**Scoped to array-literal bindings.** A plugin call inside a `.map`/`.filter`
callback is a *separate* capability — the callback-body lifter (series 048/105)
only types a **numeric** body surface, so it rejects a String-returning callback
body regardless of where the value came from; that is its own follow-up, not this
residual. Likewise `a[i] + b[j]` on two `String` index accesses is a pre-existing,
general string-concat limitation (Rust needs `String + &str`; it breaks on an
annotated `string[][]` too) — unrelated to inference, so the specs read nested
values via a template literal, not `+`.

This mirrors the machinery already in place:
- **#68** already resolves `./`-relative crate imports so cross-module inference
  works *through* imports. This extends the same `resolveModuleNames` seam to a
  registered plugin specifier.
- **series 099** already infers *through* `lib.d.ts` built-in signatures. The
  plugin's `leftPad(s, width, fill): string` is just one more signature to see
  through.

### Why generic beats narrow

A narrow, lower-side fix (detect a plugin call inside a container literal and
synthesize its element type) would special-case one container shape, miss nesting,
and duplicate type knowledge the TS oracle package already states authoritatively.
Resolving the plugin package once makes **flat and nested array literals** infer
for free, and any future expand-to-HIR plugin inherits it with no new code.

### Scope guard — `@ttr/std` stays excluded

Only **pure expand-to-HIR** plugins are type-resolved. `@ttr/std`
(`SPECIAL_LOWERED`) is deliberately **not** resolved in the oracle: its surface is
rich and partly fallible (`readFile` → a fallible type, `JsonValue`, `Writer`,
`http`), and letting tsc auto-infer those bindings could let a currently-fail-loud
shape slip past the gate — weakening the fail-loud fixpoint its dedicated lowering
maintains. The registry exposes `typeResolvablePluginSpecifiers()` =
registered specifiers **minus** `SPECIAL_LOWERED`.

### What stays fail-loud (correctly)

An **anonymous object literal** binding stays fail-loud with or without a plugin
call inside it — `const o = { a: leftPad(…) }` throws exactly as `const o = { a:
"x" }` does, because the dialect models object *shapes* only as a named
struct/interface, never an anonymous `{…}`. That is a pre-existing general rule,
not a plugin residual, and this change does **not** relax it.

## Byte-identical guarantee

No existing corpus entry exercises a plugin call inside a container literal (it
threw until now), and the annotated path and the direct-binding exemption both
bypass the inference tier. So resolving plugin specifiers only newly-*succeeds*
cases that previously threw — it changes no existing emitted byte.
`bun run lower:verify` (the pinned 62-entry snapshot) must stay green.

## Touch points

- `plugins.ts` — add `typeResolvablePluginSpecifiers()` (registered − `SPECIAL_LOWERED`).
- `type-oracle.ts` — resolve those specifiers to their on-disk entry
  (`require.resolve`, degrade gracefully if absent); serve the entry file from
  disk in both the `noLib` and lib-backed hosts; route it in `resolveModuleNames`.
- No change to `statements.ts` — the existing gate already consults
  `inferredRustType`; it simply starts getting a non-null answer.

## Non-goals

- Anonymous-object-literal inference (a general dialect rule; out of scope).
- Migrating `@ttr/std` onto the generic resolve path (deliberately excluded).
