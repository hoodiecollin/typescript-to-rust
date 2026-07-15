# 084 — `@t2r/std` std-shim, Tier A (`parseJson` / `stringifyJson`) — design

Epic **#52** (the std-shim lane), sub-issues **#53** (`parseJson`), **#58**
(`stringifyJson`), resolving **#57** (the JSON.stringify `None`→`null` divergence
decision). Depends on the shipped Option model (066), the serde/tslib JSON
machinery (045), and the library-method backbone (083).

## What this is

`@t2r/std` is a **third routing lane** alongside the Rust-side `tslib` (runtime
quirks) and compiler inference (type/ownership). It is a **blessed TS-side
surface** the developer imports *instead of* footgun APIs. The compiler
recognizes it **by the reserved import specifier `"@t2r/std"`** and lowers each
imported name to a known Rust target. It is the dialect's **isolation boundary
for JS-divergent behavior**: the type/policy problem moves to an explicit
call-site API, dissolving the `any` (`JSON.parse`) and fidelity (`JSON.stringify`)
problems that neither existing lane could rescue.

The shim is **real TS** (`packages/std/index.ts`) so the differential oracle —
which runs the input TS under Bun — executes faithful behavior identical to the
Rust the compiler emits.

## Decided parameters (settled — do not re-litigate)

- **Reserved import specifier: `@t2r/std`.** Recognition keys off the *specifier*,
  never a name heuristic. A user's own `parseJson`/`stringifyJson` imported from
  anywhere else is **not** hijacked. An `import { … } from "@t2r/std"` binds the
  intrinsic names into the module's std-shim table; the *local* alias
  (`import { parseJson as pj }`) is what the call sites use.
- **`parseJson<T>(s: string)` → a Result-like tagged return** (Collin's call): on
  success `{ ok: true, value: T }`, on error `{ ok: false, error: string }` *in
  spirit*. It lowers to `serde_json::from_str::<T>(s)` mapped into that result.
  `T` must be a modeled struct/enum (or a primitive / `Array` / `Record` of them);
  an unconstrained/unmodeled `T` stays **fail-loud**. `T` is taken from the
  explicit call type-argument (`parseJson<Point>(s)`) or, failing that, from the
  binding annotation (`const p: Point = …` — but here the binding is a
  `ParseResult<Point>`, so the explicit type-arg is the primary source).
- **`stringifyJson(v): string`** reuses the shipped 045 `JSON.stringify` writer
  (`tslib::json::stringify`), moved behind the shim. **Accepts the JS
  divergence**: a `None`/optional field renders `null` (JS omits it) — accepted,
  documented, *no* provenance/omission work now. The already-faithful cases stay
  (integrals no `.0`, shortest-round-trip fractions, `Infinity`/`NaN` → `null`).
- **Bare `JSON.parse` AND bare `JSON.stringify` are fail-loud** with an error that
  **redirects** to `parseJson`/`stringifyJson` from `@t2r/std`. The 045
  annotation-driven `JSON.parse` and the untyped `Value` fallback are **removed**
  from the accepted surface — the only JSON entry points are the two shim
  intrinsics.

## The `parseJson` result representation — chosen: purpose-built tslib type

**Dialect wall (confirmed):** the dialect's `enum` is a non-generic,
integer-discriminant runtime enum only (`lowerEnum` → `{ kind: "enum", name,
variants }`, integer discriminants; no generics, no payload-carrying variants, no
union modeling). A **raw TS discriminated-union** return
`{ ok: true; value: T } | { ok: false; error: string }` therefore **cannot** be
modeled through the existing struct/enum machinery — there is no generic-enum
support to lower it to.

Per the issue's explicit guidance ("if even a raw union can't be modeled, design a
purpose-built std-shim result TYPE … pick the tractable representation"), the
chosen representation is a **purpose-built Rust generic type in `tslib`**:

```rust
// crates/tslib/src/json.rs
pub struct ParseResult<T> {
    pub ok: bool,
    value: Option<T>,
    error: Option<String>,
}
impl<T: serde::de::DeserializeOwned> ParseResult<T> {
    pub fn parse(s: &str) -> ParseResult<T> {
        match serde_json::from_str::<T>(s) {
            Ok(v)  => ParseResult { ok: true,  value: Some(v),  error: None },
            Err(e) => ParseResult { ok: false, value: None,     error: Some(e.to_string()) },
        }
    }
    pub fn value(self) -> T          { self.value.expect("parseJson: value() on an error result") }
    pub fn error(self) -> String     { self.error.expect("parseJson: error() on an ok result") }
}
```

- `parseJson<T>(s)` lowers to `tslib::json::ParseResult::<T>::parse(&s)`.
- The consumption surface is the field/accessor triple: `.ok` → the public `ok`
  bool field; `.value` → the `value()` accessor (`self`-consuming, so used once,
  under a proven-`ok` branch); `.error` → the `error()` accessor. Member access on
  a binding whose type is `ParseResult<T>` lowers `.ok`/`.value`/`.error`
  accordingly; the binding type is recorded in `bindingTypes` so ordinary
  member-access routing resolves it.

**TS side** declares the matching discriminated union `ParseResult<T>` (so
`if (r.ok) r.value` narrows in TS exactly as the Rust accessor pair works) and a
`parseJson<T>` whose body is `try { return { ok: true, value: JSON.parse(s) as T };
} catch (e) { return { ok: false, error: String(e) }; }`. Under Bun this yields
the identical `.ok`/`.value`/`.error` observations the Rust produces, so the
differential matches.

**Why not the raw union / not a modeled enum:** a generic, payload-carrying,
discriminated-union enum is a genuine new dialect capability (generic enums +
union modeling + flow-narrowing) — far beyond Tier A and out of scope. The
purpose-built tslib type is the tractable representation that keeps the never-
miscompile contract while giving the developer the same `.ok`/`.value`/`.error`
ergonomics.

## Recognition mechanism

oxc **keeps** `ImportDeclaration`/`ImportSpecifier` nodes in `Program.body`
(verified). Today they are simply absent from the validator `MODELED` set, so any
import fails loud at the parse gate. This series models **only** the `@t2r/std`
import:

1. **Validator (`validate.ts`)** — add `ImportDeclaration` + `ImportSpecifier` to
   `MODELED`, but *guarded*: an `ImportDeclaration` whose `source.value !==
   "@t2r/std"` is fail-loud (`import from '<x>' — only "@t2r/std" is a recognized
   module (bare module imports are not yet supported)`), and an `@t2r/std` import
   of an unknown name is fail-loud (`'<name>' is not exported by "@t2r/std"`).
   This keeps 050 (general modules) unshipped while admitting exactly the shim.
2. **Analysis (`analyzeModule`)** — collect the std-shim table: for each `@t2r/std`
   `ImportSpecifier`, map `local.name → imported.name` into
   `analysis.stdShim: Map<string, "parseJson" | "stringifyJson">`. The import
   statement itself lowers to nothing (no Rust output).
3. **Lowering (`lowerCall`)** — in the identifier-callee path, *before* the generic
   user-fn lookup, if `call.callee` is an identifier whose local name is in
   `analysis.stdShim`, route to the intrinsic lowering for `parseJson` /
   `stringifyJson`.

## Emitter / HIR

- `stringifyJson(v)` reuses the existing `{ kind: "jsonStringify", value }` HIR →
  `tslib::json::stringify(&v)`. Unchanged emit; only the recognition front-end
  moves from `JSON.stringify` to the shim.
- `parseJson<T>(s)` → a new HIR `{ kind: "parseJson", source, target: RustType }`
  → `tslib::json::ParseResult::<T>::parse(&s)`. `usesJson` gating (serde
  derives on the structs) extends to cover `parseJson`.
- The `jsonParse` HIR (045 `from_str::<T>` / `Value`) is **removed** along with its
  recognition — bare `JSON.parse` no longer reaches it.

## Fail-loud (forbid + redirect)

- Bare `JSON.stringify(...)` → `` `JSON.stringify` is not accepted — import
  `stringifyJson` from "@t2r/std" ``.
- Bare `JSON.parse(...)` → `` `JSON.parse` is not accepted — import `parseJson`
  from "@t2r/std" ``.
- `parseJson` with no type argument and no modeled binding type, or a
  `parseJson<T>` where `T` is not a modeled struct/enum/primitive/array/record →
  `` `parseJson<T>` needs a modeled struct/enum type argument (`parseJson<Point>(s)`) ``.
- Any `@t2r/std` import of an unknown name, or an import from any other bare
  specifier → the recognition messages above.

## Package + resolution

`packages/std/` is a real Bun-resolvable workspace package (`"name": "@t2r/std"`,
root `package.json` already globs `packages/*`). After `bun install` it symlinks
into `node_modules/@t2r/std`, so `import { … } from "@t2r/std"` resolves both when
the differential harness runs the input TS under Bun **and** for typecheck. The
harness runs the TS via `Bun.spawnSync(["bun", "run", "-"], { stdin })` from the
repo root, so node_modules resolution from the repo root is what matters — the
workspace symlink covers it. (A tsconfig `paths` mapping is *not* used; the real
package is simpler and is what Bun's runtime actually consults.)

## Migration of the 045 specs

`packages/compiler/tests/json.test.ts` currently asserts bare `JSON.stringify` /
`JSON.parse` support (JSN1–JSN8). These migrate:
- The `stringify` behavior specs (JSN1–JSN5) re-point to `stringifyJson` imported
  from `@t2r/std` (same expected output — the writer is unchanged).
- The `parse` specs (JSN6–JSN8) re-point to `parseJson<T>` + the `ParseResult`
  consumption surface.
- New specs assert bare `JSON.stringify` / `JSON.parse` now fail loud with the
  redirect messages.
The old 045 file is retired in favor of the new `std-shim.test.ts` (the JSON
behavior lives behind the shim now).
