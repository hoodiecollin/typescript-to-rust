# 110 — Plugin system: specs

BDD specs for the plugin system (epic #95). The design is locked in `design.md`;
this file transcribes the observable behavior into specs and closes with an
impl-plan. Ground rule inherited from the design: **fail-loud and emitter
totality are preserved** — a plugin can only produce core HIR the compiler
already emits, and an unexpanded plugin node is a compiler bug that fails loud.

The reference plugin used throughout is **`@ttr/plugin-leftpad`**, owning the
specifier `@ttr/plugin-leftpad` and exporting one intrinsic
`leftPad(s: string, width: number, fill: string): string` — JS `padStart`
fidelity (a multi-char `fill` is cycled and truncated to the deficit; when `s`
already meets `width`, it is returned unchanged). It expands to a core-HIR call
into the bundled `crates/ttr-plugin-leftpad` crate
(`ttr_plugin_leftpad::left_pad`).

## 1. The opaque `"plugin"` HIR variant + emitter fail-loud guard

- **PLUG1** — `hir.ts` has exactly one plugin variant,
  `{ kind: "plugin"; owner: string; payload: unknown }`. The HIR union stays
  closed (no open/extensible `kind`).
- **PLUG2** — the emitter's `emitExpr` handles `case "plugin"` by throwing
  `UnsupportedError` ("unexpanded plugin node from '<owner>' reached the
  emitter"). Reaching it means a `"plugin"` node survived the expansion pass —
  a compiler bug, never plugin logic. (Verified by a direct unit test that feeds
  the emitter a hand-built `{ kind: "plugin", … }` and asserts it throws.)
- **PLUG3** — emitter totality is preserved: `emitExpr` remains an exhaustive
  switch with no `default`, so the type checker still proves every `HirExpr`
  `kind` is handled.

## 2. The plugin registry + contract completeness (fail-loud at registration)

- **PLUG4** — a plugin declares four parts (design §"contract"): owned
  `specifier`, owned `exports` (names), `recognize` + `expand`, and a `crate`
  (`{ name, manifest }`). `registerPlugin(p)` throws `DialectError` if **any**
  part is missing/empty (empty specifier, empty exports, non-function
  recognize/expand, empty crate name or manifest).
- **PLUG5** — the registry is specifier-keyed. `pluginForSpecifier("@ttr/plugin-leftpad")`
  resolves the reference plugin; an unregistered specifier resolves to
  `undefined`. Recognition is **specifier-anchored, never a name heuristic**: a
  user's own local `function leftPad(...)` (no plugin import) is untouched.

## 3. Recognition (lower) — owned shapes route to the opaque node

- **PLUG6** — `import { leftPad } from "@ttr/plugin-leftpad"` validates (the
  registered specifier + a registered export name are accepted by the validator,
  exactly as `@ttr/std` is). An import of an **unregistered** specifier still
  fails loud, and a name **not** exported by a registered plugin fails loud with
  the plugin's export list.
- **PLUG7** — a call to the bound name, `leftPad(s, w, f)`, lowers to
  `{ kind: "plugin", owner: "@ttr/plugin-leftpad", payload }` where `payload`
  carries the already-lowered args. Lowering does no plugin-specific work beyond
  routing (design §3 step 1).
- **PLUG8** — `recognize` is the plugin's guard seam: `leftPad` with other than
  three arguments fails loud (`UnsupportedError`). This is the reference plugin's
  negative reject case (corpus-coverage rule).

## 4. Expansion (refinePlugins) — opaque node → core HIR

- **PLUG9** — `refinePlugins` runs **first** in the refine chain (innermost,
  wrapping `module` before `refineBitwise`). It replaces every `{ kind: "plugin" }`
  node with the owning plugin's `expand(payload)`, which returns **core HIR**
  (here a `{ kind: "call", callee: "ttr_plugin_leftpad::left_pad", args }`). No
  `"plugin"` node survives into a downstream pass or the emitter.
- **PLUG10** — because expansion happens before every other pass, plugin output
  is indistinguishable from built-in output: the ownership / numeric / string
  passes see an ordinary `call`, and the reference plugin's result composes in
  every expression position (let init, `console.log` arg, array element,
  ternary branch, string concat, and as an argument to itself).

## 5. Bilingual runtime — the reference plugin's crate is real and warmed

- **PLUG11** — `crates/ttr-plugin-leftpad` exists as a workspace crate with
  `pub fn left_pad(s: &str, width: f64, fill: &str) -> String` implementing
  padStart fidelity, with its own `#[test]`s.
- **PLUG12** — the plugin's Cargo dep is declared in the oracle manifest
  (`rust-oracle/Cargo.toml`) so `ensureDepsWarm` pre-warms it (the manifest is
  the plugin's `crate.manifest`). Emitted programs that call `leftPad` compile
  and run against the real crate.

## 6. Behavioral corpus (differential, cargo-backed)

Each is a complete program; Rust stdout must equal the Bun-run TS stdout (the
TS side ships an equivalent `leftPad` so the corpus fixture type-checks and runs
under Bun as the oracle).

- **PLUG13** — `leftPad("7", 3, "0")` → `"007"` (pad deficit with single char).
- **PLUG14** — `leftPad("42", 2, "0")` → `"42"` (already at width → unchanged).
- **PLUG15** — `leftPad("x", 5, "ab")` → `"ababx"` (multi-char fill cycled +
  truncated to the deficit — the padStart quirk).
- **PLUG16** — a `leftPad` result flows through the standard passes: used in a
  `console.log`, an array, a ternary, and concatenated — one program asserting
  the composed output.

## 7. @ttr/std under the registry (task 10)

- **PLUG17** — `@ttr/std` is represented in the registry as the canonical first
  plugin **for recognition** (its specifier + exports resolve through the same
  registry API the validator consults), proving the registry generalizes the
  std-shim's specifier-anchoring. Its **lowering stays special-cased** (the
  fallibility fixpoint, the `fsAsync`/`http` namespaces, the `JsonValue`/`Writer`/
  `HttpResponse` type intrinsics, and the many binding-type exemptions are not a
  pure `expand()`-to-HIR-call), and this is documented as the reason it is not
  migrated onto the `recognize`/`expand` seam. All existing `@ttr/std` behavior
  is unchanged (byte-identical corpus).

## Impl-plan

Ordered, each step gated by `bun run typecheck` + `bun run lower:verify`
(byte-identical where the step is pure addition) and the full suite at the end.

1. **hir + emitter guard** — add the `{ kind: "plugin", owner, payload }` variant
   to `hir.ts`; add the fail-loud `case "plugin"` to `emitExpr`. (PLUG1–3)
2. **plugins.ts** — the `Plugin` contract type, specifier-keyed registry,
   `registerPlugin` completeness validation, `collectPluginBindings`, and the
   `refinePlugins` expansion pass (a comprehensive post-order HIR walker; an
   unwalked position degrades safely to the PLUG2 fail-loud guard). (PLUG4–5, 9–10)
3. **wire refinePlugins** — innermost in the `lower/index.ts` refine chain. (PLUG9)
4. **analysis + lower recognition** — collect plugin bindings into
   `analysis.plugins` (parallel to `stdShim`); route a bound-name call to the
   opaque node in `lowerCall`. (PLUG6–8)
5. **validate** — generalize the sole-import guard to accept any registered
   plugin specifier + its exports (keeping the `@ttr/std` message path). (PLUG6)
6. **reference crate** — `crates/ttr-plugin-leftpad` (fn + unit tests); declare
   its dep in `rust-oracle/Cargo.toml`. (PLUG11–12)
7. **register the reference plugin** — its descriptor (specifier, exports,
   recognize, expand, crate) registered at module load. (PLUG5, 7–8)
8. **@ttr/std registry entry** — register its recognition surface; document the
   special-cased lowering. (PLUG17)
9. **specs** — RED-first for the guard/reject specs (PLUG2, 6, 8) and the
   differential corpus (PLUG13–16); GREEN after impl.
