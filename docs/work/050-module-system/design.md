# 050 — Module system (`import` / `export`) — plan

Graduates the last `test.todo` (`09_modules`): all module syntax is fail-loud at the
parse gate today (`import`/`export` are absent from `MODELED` in `validate.ts`, so
they reject as generic `Unsupported <NodeType>`), and the pipeline is single-unit —
one `Program` → one `HirModule` → one `lib.rs`/`main.rs`.

**DECISION (issue #6, 2026-07-07):** each TS file → an inline Rust `mod name { … }`
inside **one** generated crate. `export`→`pub`, `import { f } from "./x"`→`use
crate::x::f;`. **Named exports only.** The harness stays a **single compilation
unit** — we do **not** emit a multi-file cargo project. The CLI takes an **entry
file** and follows `./`-relative imports transitively (a resolver + cycle check);
bare/package imports are refused. `export default`, `export * from` (re-export
barrels — against the no-barrel ethos), and dynamic `import()` stay fail-loud.

## File → `mod` mapping

| TS | Rust |
|---|---|
| the **entry** file's declarations + top-level script | crate root: items + generated `fn main()` (today's behavior, unchanged) |
| a non-entry imported file `./math.ts` | `mod math { … }` at crate root |
| a nested import `./util/math.ts` | nested `mod util { mod math { … } }` |
| `export function f` / `export class C` / `export interface S` / `export enum E` | `pub fn` / `pub struct C` + pub `impl` / `pub struct S` / `pub enum E` |
| `export { a, b }` (specifier list, same file) | mark `a`, `b` `pub` on their decls |
| `import { f } from "./x"` | `use crate::x::f;` at the top of the importing `mod` (or crate root, for the entry) |
| `import { f as g } from "./x"` | `use crate::x::f as g;` |

The mod name is the file **stem** sanitized to a valid Rust identifier (`rid`);
directory segments become nested `mod`s so the `use crate::util::math::f` path
mirrors the `./util/math` import. Only the **entry** file may carry top-level
executable statements (→ `fn main`); a non-entry module holds **only** declarations
(a `mod` body can't hold statements, and JS import-time side effects have no sound
Rust analog) — a top-level statement in an imported file is fail-loud.

## export → `pub`, import → `use`

`export` is collected per file into an **exported-name set** and consumed by
visibility inference (below). Two forms:
- `export <decl>` — `ExportNamedDeclaration` with a non-null `.declaration`; the
  wrapped `FunctionDeclaration` / `ClassDeclaration` / `TSInterfaceDeclaration` /
  `TSEnumDeclaration` lowers as today, then its `vis` is set `pub`.
- `export { a, b as c }` — `ExportNamedDeclaration` with `.specifiers`
  (`ExportSpecifier`, `local.name` → `exported.name`); each `local` name is marked
  `pub`. A **renamed** export (`b as c`) where `c ≠ b` is fail-loud in the first
  slice (Rust has no rename-on-declaration; it needs `pub use self::b as c;`).

`import { … } from "./x"` (`ImportDeclaration`, `ImportSpecifier` children, string
`.source`) contributes two things: (1) a resolver edge (below), and (2) a **`use`
map** for the importing module — each `imported`→`local` pair becomes a
`use crate::<modpath>::<imported> as <local>;` line emitted at the top of that
`mod`. Bare references to `f` in the body then resolve normally; nominal type
references (`Foo`) resolve through the same map during lowering.

## The CLI entry-file resolver

`packages/compiler/index.ts` (the `ttr` script) today reads **one** file and calls
`emit(program)`. The module system adds a **resolver stage in front of lowering**:

1. Parse the entry file. Collect its `ImportDeclaration`s.
2. For each `./`- or `../`-relative `.source`, resolve to a file path
   (append `.ts` / `/index.ts`), parse it, recurse. A **bare/package** specifier
   (no leading `.` — `"lodash"`, `"node:fs"`) is **refused** fail-loud (no
   `node_modules`, no ambient modules).
3. A **cycle check** (visited-set keyed by absolute path) terminates traversal.
   A genuine `A ↔ B` import cycle is **not** rejected — sibling `mod`s in one crate
   are mutually visible regardless of order, and (since only the entry runs
   statements) there is no init-order hazard — the visited-set exists only to make
   traversal finite.
4. The result is an ordered `SourceModule[]` — `{ absPath; modPath: string[];
   program; isEntry }` — passed to a new **`lowerCrate(modules)`** orchestrator.

Refactor note: the existing single-`Program` `lower(program)` stays as the
entry-only fast path (no imports/exports ⇒ one `SourceModule`, no `mod`s emitted),
so all current fixtures are untouched.

## Pipeline & HIR changes (single-unit preserved)

`lowerCrate` lowers each non-entry `SourceModule` to a new **`HirMod`** item and the
entry to crate-root items + `main`, all inside **one** `HirModule`:

```
HirMod  = { kind: "mod"; name: string; uses: string[]; items: HirItem[] }
HirModule.mods?: HirMod[]   // new; root items/main/mainRet/mainAsync unchanged
```

`emitModule` (emitter.ts) renders each `HirMod` as `mod <name> {\n <uses>\n
<items>\n}` and keeps emitting root items + `fn main` exactly as now. The std-import
deep-scan (`usesKind` → `use std::collections::…`, `IndexMap`, `Rc`/`RefCell`) runs
**per-`mod`** as well as at crate root, because items inside a `mod` don't see the
parent's `use` prelude — each `mod` gets its own. The harness still writes one
`src/lib.rs`/`main.rs`; the oracle is unchanged.

Analysis becomes **module-aware**: `analyzeModule` runs per file, and `lowerCrate`
builds a **global symbol table** — `(modPath, name) → decl` — plus each module's
`use` map, so `lowerType`'s nominal resolution (`TSTypeReference` → `{ kind:
"struct"; name }`) can resolve an imported `Foo` to the declaring module and confirm
it is exported. A bare name that is neither local nor imported stays fail-loud
(unresolved). Ownership/fallibility/numeric passes still run per HIR tree; they are
name-based and per-function, so nesting items under a `mod` is transparent to them.

## Visibility inference

Every `HirItem` (and struct field / method) gains `vis: "pub" | "pub(crate)" |
"priv"` (default `priv`; the emitter prefixes `pub `/`pub(crate) ` and omits nothing
for `priv`). Three tiers:

- **`pub`** — the name is in its file's exported set (`export …`).
- **`pub(crate)`** — not exported, but **reachable from an exported signature** in
  the same file: the type of an exported fn's param/return, an exported struct's
  field, or a type transitively reached from those. Rust forbids a private type in a
  `pub` signature (`private_interfaces`), so these must be widened. A closure over
  the exported items computes the reachable-type set.
- **`priv`** — purely local: not exported and not signature-reachable.

An exported struct's **fields** and an exported class's constructed-through methods
are widened to `pub` (a cross-`mod` struct literal / method call needs them). This
is the concrete meaning of "non-exported but cross-module-referenced → `pub(crate)`"
from the decision.

## Validator / `MODELED` additions (+ `ast.ts`, `dialect.md`)

`src/ast.ts` gains the ESTree shapes (verified against `parseSync`): an
`ImportDeclaration` (`source: Literal`, `specifiers: (ImportSpecifier |
ImportDefaultSpecifier | ImportNamespaceSpecifier)[]`), `ImportSpecifier`
(`imported`, `local`), `ExportNamedDeclaration` (`declaration`, `specifiers:
ExportSpecifier[]`, `source`), `ExportSpecifier` (`local`, `exported`).

`MODELED` in `validate.ts` gains **only the supported subset** — `ImportDeclaration`,
`ImportSpecifier`, `ExportNamedDeclaration`, `ExportSpecifier`. The fail-loud shapes
get **dedicated `DialectError`/`UnsupportedError` messages** (a clearer signal than
the generic default-deny) via new `checkForbiddenFlags`-style guards:

| Shape | Node | Kind | Message |
|---|---|---|---|
| default export | `ExportDefaultDeclaration` | Forbidden | `` `export default` (no named Rust analog) `` |
| re-export barrel | `ExportAllDeclaration`; `ExportNamedDeclaration` with a non-null `.source` | Forbidden | `re-export barrel (`export * from` / `export { x } from`)` |
| default import | `ImportDefaultSpecifier` | Not yet | `default import (named imports only)` |
| namespace import | `ImportNamespaceSpecifier` | Not yet | `namespace import (`import * as ns`)` |
| dynamic import | `ImportExpression` | Not yet | `dynamic `import()`` |
| bare/package import | `ImportDeclaration` whose `.source` has no leading `.` | Not yet | `bare/package import (only `./`-relative imports; no node_modules)` |
| renamed export | `ExportSpecifier` where `exported ≠ local` | Not yet | `renamed export (`export { x as y }`)` |
| top-level statement in an imported module | any non-declaration at a non-entry file's top level | Not yet | `top-level statement in an imported module (declarations only)` |

`dialect.md` mirrors these in a new **"Modules (`import` / `export`)"** section and
the `MODELED` list; the four newly-modeled node types are added to the allowlist
prose, and the "all module `import`/`export` syntax" line in the "not modeled" note
is narrowed to the fail-loud subset above.

## Directive scope (open design question)

`"use rc"` / `"use arena"` / `"use panic"` are valid today only on a free function
or at script scope (per-function). With modules, a directive as a **file prologue**
raises: is it **module-wide** (applies to every fn in that `mod`) or **program-wide**
(the whole crate)? The conservative first cut keeps directives **per-function**
(unchanged) and leaves a file-prologue directive fail-loud, deferring the
module-scope question until a real fixture needs it. Flagged for Collin before 050
lands anything touching the directive surface.

## Slices (each lands green)

1. **050a — single import/export.** The resolver (two-file: entry + one dep),
   `SourceModule` graph, `lowerCrate`, `HirMod` + emitter `mod { … }`, `export
   function`→`pub fn`, `import { f }`→`use crate::x::f;`, rename-on-import
   (`f as g`). Bare-import refusal. One differential two-file program green.
2. **050b — multi-file graph + visibility.** Transitive N-file resolution, the
   cycle-terminating visited-set, directory-nested `mod`s, the three-tier visibility
   inference (`pub` / `pub(crate)` / `priv`) + the signature-reachability closure,
   per-`mod` std-import preludes, imported-module top-level-statement rejection.
3. **050c — cross-`mod` struct/class/enum resolution.** The global symbol table +
   per-module `use` map feeding `lowerType`'s nominal resolution; exported struct
   fields / class methods widened to `pub`; a cross-`mod` struct literal, method
   call, and enum reference compile + behave. Couples to #4 (inheritance across
   files) — a `class B extends A` split across modules rides this resolution.

## Fail-loud residuals

`export default` and `export * from` / `export { x } from "./y"` (re-export barrels)
stay **Forbidden** — no named Rust analog / against the no-barrel ethos. Default
imports, namespace imports (`import * as`), dynamic `import()`, bare/package imports,
renamed exports, and top-level statements in an imported module stay **Not yet**.
Import cycles are **accepted** (not a residual) — they compile as sibling `mod`s. The
file-prologue directive-scope question is deferred (above).
</content>
