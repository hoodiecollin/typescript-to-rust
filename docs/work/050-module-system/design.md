# 050 — Module system (`import` / `export`) — design

> **✅ RESOLVED (2026-07-16) — see the Decisions section below.** Collin's redecision
> on all five axes (from `options.md`) has landed; this doc is now the **resolved
> design**, and it **supersedes the issue-#6 2026-07-07 baseline** (mechanical inline
> `mod`-per-file, single compilation unit) — that baseline is recorded in git history.
> `options.md` is retained as the exploration record. The resolved design keeps the
> baseline as a *floor* (inline single-file `mod {}` is the no-import fast path) and
> adds real multi-file emission, `pub(crate)` visibility inference, sanctioned
> `pub use` barrel facades, `namespace`→nested `mod`, and prelude-module generation.
>
> Ground-truth drift carried forward (verified 2026-07-16): since 084, the
> `@t2r/std` std-shim put `ImportDeclaration`/`ImportSpecifier` **into** `MODELED`
> in `validate.ts`, gated by `checkStdShimImport` (only `import … from "@t2r/std"`
> is recognized). So `import` recognition already exists; the module system extends
> that path. **`export` is still fully fail-loud** — no `Export*` node is in
> `MODELED`. `index.ts` runs `lower(program, source)` → one `HirModule` →
> `emitModule(mod)`.

---

## Decisions (DECIDED 2026-07-16)

The five axes from `options.md` are now **DECIDED**. These override the issue-#6
baseline (kept as the floor / fast path).

- **Axis 2 — layout: DECIDED = real multi-file, single crate.** Each TS module → a
  real Rust file (`src/foo.rs` + `mod foo;`, or `foo/mod.rs`) mirroring the
  `./util/math.ts` layout; **ONE crate, one `cargo run`, one stdout** to diff. The
  inline single-file `mod {}` form is kept as the **no-import fast path**
  (backward-compat with every current fixture). Multi-**crate** workspace (option c) is
  **deferred** to a future detected-multi-package series.
- **Axis 3 — barrels: DECIDED = Position A, sanctioned `pub use` facade.** A **pure**
  barrel `index.ts` (body is *only* `export … from "./x"` re-exports, `./`-relative
  sources) → a generated `pub use` facade module. **Mixed** logic+re-export barrels
  stay fail-loud; `export default` stays **Forbidden**. A renamed re-export
  (`export { x as y } from "./z"`) → `pub use crate::z::x as y;` — this **lifts** the
  baseline's renamed-export fail-loud residual. Our own no-barrel authoring ethos is
  untouched; this translates a **user's** barrel.
- **Axis 1 — visibility: DECIDED = infer to `pub(crate)` granularity now.** Exported +
  cross-used → `pub(crate)`; exported + not-cross-used → `pub(crate)` (conservatively);
  a signature-reachable private type → `pub(crate)` (the `private_interfaces` rule);
  purely local → `priv`. Finer `pub(super)` / `pub(in path)` tiers are a **follow-on**.
- **Axis 4 — namespace/use: DECIDED = support `namespace`→nested `mod`** (coalescing
  reopened namespaces) **+ grouped/aliased `use` synthesis**; allow **generated** globs
  only inside sanctioned facades (Axis 3).
  - **RE-DECIDED 2026-07-17 (Collin):** **namespace imports** (`import * as ns from
    "./n"`) are now **supported** — they map to a Rust **module alias** (`use crate::n
    as ns;`) with member access `ns.x` routed to the `n::x` **path** (the same
    treatment as enum-member `Color.Red` → `Color::Red`). The original "glob capture
    risk" rationale was **mistaken**: TS `import * as ns` is *qualified* access, not an
    unqualified glob, so there is no capture. **Default import/export** are likewise
    **supported** via a reserved symbol `__default_export`: `export default <fn/class>`
    emits a named item `__default_export` (anonymous form) or the named decl plus a
    `pub(crate) use self::foo as __default_export;` alias (named form); `import def from
    "./d"` binds it via `use crate::d::__default_export as def;`. An anonymous **value**
    default (`export default 42/{}`) has no named Rust analog and stays fail-loud. Both
    land in slice **050d**.
- **Axis 5 — encapsulation creativity: DECIDED = ship prelude-module generation.**
  `#[cfg(test)]` test-file mapping and sealed traits are **separately-scoped future
  series** (noted, not designed here — see "Conditional compilation" below).

### Cross-cutting ordering dependency (with 099 inference tier)

**099 (inference tier) lands before 050 (modules).** The module resolver builds a
**global symbol table** from exported-function **signatures**; if 099 lets an exported
fn omit its return annotation, that signature is *inferred*, so 099's inference must
run **before** 050's visibility/resolution passes — the *inferred* type (not the
absent annotation) is what the `private_interfaces` reachable-type closure (Axis 1)
widens to `pub(crate)`. 099's inferred output must be available to 050's global symbol
table.

### Cross-cutting invariant (with 100 I/O)

100's I/O must **not** break the "only the entry module runs top-level statements"
invariant. Import-time I/O (a non-entry module running I/O at load time / top level)
stays **fail-loud** — I/O earns no exception. A module that only *defines* fns calling
shim intrinsics is fine.

---

Graduates the last `test.todo` (`09_modules`): all module syntax is fail-loud at the
parse gate today (`import`/`export` are absent from `MODELED` in `validate.ts`, so
they reject as generic `Unsupported <NodeType>`), and the pipeline is single-unit —
one `Program` → one `HirModule` → one `lib.rs`/`main.rs`.

**Resolved shape:** each TS file → a **real Rust source file** in one generated crate
(`src/foo.rs` + `mod foo;`, nested dirs as `util/math.rs`), mirroring the `./`-relative
layout; the inline `mod name { … }` form remains the no-import fast path.
`export`→ inferred visibility (`pub` at the crate boundary / `pub(crate)` otherwise),
`import { f } from "./x"`→`use crate::x::f;`. Named exports, **plus** a sanctioned
`pub use` facade from a pure barrel and `namespace`→nested `mod`. The harness emits a
**multi-file cargo project** but still runs **one binary** → one stdout to diff. The
CLI takes an **entry file** and follows `./`-relative imports transitively (a resolver
+ cycle check); bare/package imports are refused. `export default`, **mixed**
logic+re-export barrels, and dynamic `import()` stay fail-loud.

## File → module mapping (multi-file, single crate — DECIDED Axis 2)

The crate is a **real multi-file cargo project**: the harness writes one `.rs` file
per TS module plus a generated module root, and `cargo run`s the single binary.

| TS | Rust |
|---|---|
| the **entry** file's declarations + top-level script | crate root (`main.rs`): items + generated `fn main()`, plus the `mod foo;` declarations for its deps |
| a non-entry imported file `./math.ts` | a real file `src/math.rs`, declared `mod math;` at the crate root |
| a nested import `./util/math.ts` | a real file `src/util/math.rs` (with `src/util/mod.rs` or `util.rs` carrying `mod math;`), path `crate::util::math` mirroring `./util/math` |
| `export function f` / `export class C` / `export interface S` / `export enum E` | `pub`/`pub(crate)` (per Axis-1 inference) `fn` / `struct C` + `impl` / `struct S` / `enum E` |
| `export { a, b }` (specifier list, same file) | mark `a`, `b` exported → Axis-1 visibility on their decls |
| `export { x as y } from "./z"` (**renamed re-export in a pure barrel**) | `pub use crate::z::x as y;` in the facade module — **lifts the baseline residual** (Axis 3) |
| a **pure barrel** `index.ts` (re-exports only) | a generated `pub use` **facade module** (Axis 3) |
| `namespace Foo { export … }` | `mod foo { pub … }`; `Foo.bar()` → `foo::bar()`; reopened `Foo` coalesced into one `mod` (Axis 4) |
| `import { f } from "./x"` | `use crate::x::f;` at the top of the importing module |
| `import { f as g } from "./x"` | `use crate::x::f as g;` |
| multiple named imports of one source | may be synthesized as a grouped `use crate::x::{a, b, c};` (Axis 4 nicety) |

The module name is the file **stem** sanitized to a valid Rust identifier (`rid`);
directory segments become the real dir/file path so `use crate::util::math::f`
mirrors `./util/math`. The **inline `mod name { … }` single-file** emission is kept as
the **no-import fast path** (Axis 2), so every current fixture (no imports/exports)
is byte-unchanged.

Only the **entry** file may carry top-level executable statements (→ `fn main`); a
non-entry module holds **only** declarations (JS import-time side effects have no
sound Rust analog) — a top-level statement in an imported file is fail-loud. This is
the invariant 100's I/O must not break (import-time I/O stays fail-loud).

## export → `pub`, import → `use`

`export` is collected per file into an **exported-name set** and consumed by
visibility inference (below). Forms:
- `export <decl>` — `ExportNamedDeclaration` with a non-null `.declaration`; the
  wrapped `FunctionDeclaration` / `ClassDeclaration` / `TSInterfaceDeclaration` /
  `TSEnumDeclaration` lowers as today, then its `vis` is inferred (Axis 1).
- `export { a, b as c }` (same-file specifier list, no `.source`) — each `local` name
  is marked exported → Axis-1 visibility on its decl. A **renamed** same-file export
  (`b as c`, `c ≠ b`) has no rename-on-declaration in Rust; it emits a `pub use
  self::b as c;` alias (the same mechanism as the facade below).
- `export { x as y } from "./z"` (**re-export** — `ExportNamedDeclaration` with a
  non-null `.source`) — accepted **only inside a pure barrel** `index.ts` (Axis 3):
  it becomes `pub use crate::z::x as y;` in the generated facade module. This
  **lifts the baseline's renamed-export fail-loud residual.** The same shape inside a
  **mixed** (logic + re-export) file stays fail-loud.

`import { … } from "./x"` (`ImportDeclaration`, `ImportSpecifier` children, string
`.source`) contributes two things: (1) a resolver edge (below), and (2) a **`use`
map** for the importing module — each `imported`→`local` pair becomes a
`use crate::<modpath>::<imported> as <local>;` line emitted at the top of that
**module file**. Bare references to `f` in the body then resolve normally; nominal
type references (`Foo`) resolve through the same map during lowering.

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
entry-only fast path (no imports/exports ⇒ one `SourceModule`, no extra files
emitted), so all current fixtures are untouched.

## Pipeline & HIR changes (multi-file, one binary — DECIDED Axis 2)

`lowerCrate` lowers each non-entry `SourceModule` to a **`HirMod`** and the entry to
crate-root items + `main`, all under **one** `HirModule` (still **one** compilation
unit / one binary — only the *emission target* is now multiple files):

```
HirMod  = { kind: "mod"; name: string; modPath: string[]; uses: string[]; items: HirItem[] }
HirModule.mods?: HirMod[]   // new; root items/main/mainRet/mainAsync unchanged
```

The emitter (emitter.ts) writes **one `.rs` file per `HirMod`** at its `modPath`
(`src/foo.rs`, `src/util/math.rs`), each opening with its own `use` prelude + items;
the crate root (`main.rs`) carries the entry items, `fn main`, and the generated
`mod foo;` / `mod util;` declarations wiring the files together (Axis 2 real
multi-file layout). The **inline** `mod <name> { … }` single-file rendering is kept
as the **no-import fast path**. Either way the harness runs **one binary** → one
stdout, so the oracle is unchanged. The std-import
deep-scan (`usesKind` → `use std::collections::…`, `IndexMap`, `Rc`/`RefCell`) runs
**per-module file** as well as at crate root, because items in a separate file don't
see the parent's `use` prelude — each module file gets its own. Under Axis 2 the
harness writes a **multi-file cargo project** (one `.rs` per module + a generated
module root); it still runs **one binary**, so the oracle (stdout diff) is unchanged.
The inline single-file fast path still writes one `src/main.rs`.

Analysis becomes **module-aware**: `analyzeModule` runs per file, and `lowerCrate`
builds a **global symbol table** — `(modPath, name) → decl` — plus each module's
`use` map, so `lowerType`'s nominal resolution (`TSTypeReference` → `{ kind:
"struct"; name }`) can resolve an imported `Foo` to the declaring module and confirm
it is exported. A bare name that is neither local nor imported stays fail-loud
(unresolved). Ownership/fallibility/numeric passes still run per HIR tree; they are
name-based and per-function, so nesting items under a `mod` is transparent to them.

## Visibility inference (DECIDED Axis 1 — `pub(crate)` granularity)

Every `HirItem` (and struct field / method) gains `vis: "pub" | "pub(crate)" |
"priv"` (default `priv`; the emitter prefixes `pub `/`pub(crate) ` and omits nothing
for `priv`). Inference targets **`pub(crate)` granularity** this series (finer
`pub(super)` / `pub(in path)` tiers are a follow-on). Three tiers:

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
ExportSpecifier[]`, `source`), `ExportSpecifier` (`local`, `exported`), and
`TSModuleDeclaration` (`namespace Foo { … }` — Axis 4).

`MODELED` in `validate.ts` gains the supported subset — `ImportDeclaration`,
`ImportSpecifier`, `ExportNamedDeclaration`, `ExportSpecifier`, and **`TSModuleDeclaration`**
(`namespace`, Axis 4). A `.source`-carrying `ExportNamedDeclaration` (a re-export) is
accepted **only inside a pure barrel `index.ts`** (Axis 3, facade context); everywhere
else it's fail-loud. The fail-loud shapes get **dedicated
`DialectError`/`UnsupportedError` messages** (a clearer signal than the generic
default-deny) via new `checkForbiddenFlags`-style guards:

| Shape | Node | Kind | Message |
|---|---|---|---|
| default export | `ExportDefaultDeclaration` | Forbidden | `` `export default` (no named Rust analog) `` |
| re-export in a **mixed** (non-pure-barrel) file | `ExportAllDeclaration`; `ExportNamedDeclaration` with a non-null `.source` **outside a pure barrel** | Forbidden | `re-export outside a pure barrel (a mixed logic + re-export file is ambiguous)` |
| default import | `ImportDefaultSpecifier` | Not yet | `default import (named imports only)` |
| **user-facing** namespace import | `ImportNamespaceSpecifier` | Not yet | `namespace import (`import * as ns`) — glob binding risks silent name capture` |
| dynamic import | `ImportExpression` | Not yet | `dynamic `import()`` |
| bare/package import | `ImportDeclaration` whose `.source` has no leading `.` | Not yet | `bare/package import (only `./`-relative imports; no node_modules)` |
| top-level statement in an imported module | any non-declaration at a non-entry file's top level | Not yet | `top-level statement in an imported module (declarations only)` |

> **Note — renamed export is no longer a residual.** Axis 3 accepts `export { x as y }`
> (same-file → `pub use self::x as y;`; in a pure barrel → `pub use crate::z::x as y;`),
> so the baseline's "renamed export → Not yet" row is **removed** (residual lifted).
> `export * from` inside a **pure** barrel becomes a generated `pub use crate::z::*;`
> facade (static Rust glob) when the source's exported set is unambiguously
> enumerable; an ambiguous glob re-export stays fail-loud. `export *` in a **mixed**
> file stays Forbidden (row above).

`dialect.md` mirrors these in a new **"Modules (`import` / `export`)"** section and
the `MODELED` list; the newly-modeled node types (`Import*`/`Export*` +
`TSModuleDeclaration`) are added to the allowlist prose, and the "all module
`import`/`export` syntax" line in the "not modeled" note
is narrowed to the fail-loud subset above.

## Barrel facades (DECIDED Axis 3 — Position A)

A **pure** barrel `index.ts` — a file whose body is *only* `export … from "./x"`
re-exports over `./`-relative sources, no runtime logic — translates to a generated
**`pub use` facade module**: each re-export becomes `pub use crate::<modpath>::<name>;`
(and `… as y;` for a rename, `crate::<modpath>::*;` for an enumerable `export *`). A
`pub use` facade has **no runtime effect** (pure name routing), so it is
differential-safe. Correctness constraints:

- A facade re-exporting another facade (barrel-of-barrels) needs **cycle-aware path
  resolution**; an unresolvable/ambiguous re-export cycle stays fail-loud.
- `export * from` requires enumerating the source module's exported set at translate
  time (Rust `pub use x::*` is static). If the set is unambiguously enumerable it
  emits a static glob; otherwise fail-loud.
- A **mixed** logic + re-export file is **not** a pure barrel → fail-loud (ambiguous;
  the "re-export outside a pure barrel" row).

This is the one sanctioned re-export. Our own repo's **no-barrel authoring ethos is
untouched** — this feature translates a *user's* barrel faithfully; it does not invite
us to author barrels.

## Namespaces & `use` ergonomics (DECIDED Axis 4)

- **`namespace Foo { export … }`** (`TSModuleDeclaration`) → `mod foo { pub … }`;
  `Foo.bar()` → `foo::bar()`. A **reopened** `namespace Foo` (declared twice) is
  **coalesced** into one `mod` at translate time (Rust `mod` can't reopen). A nested
  namespace → nested `mod`.
- **Grouped/aliased `use`** — multiple named imports of one source may be synthesized
  as `use crate::x::{a, b, c};`; `import { f as g }` → `use crate::x::f as g;` (a
  readability nicety, no semantic change).
- **User-facing glob/namespace imports** (`import * as ns`) stay **fail-loud** — a glob
  binding risks silent name capture (a non-fail-loud footgun in user code). Only a
  **generated** glob inside a sanctioned facade (Axis 3) is allowed.
- **Namespace+value declaration merging** (TS's namespace+function merge) has no Rust
  analog → fail-loud.

## Prelude-module generation (DECIDED Axis 5)

Synthesize a `mod prelude { pub use … }` gathering the crate's common exports so
generated module files can `use crate::prelude::*;`, reducing `use` noise. Purely
mechanical, differential-neutral (name routing only). Shipped this series as an
emission nicety.

## Conditional compilation (`#[cfg]`) — a future theme

Beyond prelude generation, Rust's **`#[cfg(...)]` family is a first-class future
theme** the module tree + emitter should leave room for. Each is a **separately-scoped
future series**, **fail-loud-honest until built** — noted here, not designed now:

1. **Emit tests INTO the code.** A TS `*.test.ts` (or an inline test block) →
   `#[cfg(test)] mod tests { … }` with `#[test]` fns, run under `cargo test`, so the
   generated crate carries its own suite. Needs a test-runner-shape mapping
   (`expect().toBe` → `assert_eq!`, etc.) — its own series under this theme.
2. **Feature-flag conditional inclusion.** Items/modules gated by
   `#[cfg(feature = "…")]`, with the matching `[features]` table synthesized into
   `Cargo.toml`, driven by some sanctioned TS convention (a `@t2r` directive, a
   build-time-constant branch — the mechanism is its own series' design question).
   Reserve the emitter seam for it.
3. **The general `#[cfg(...)]` family** — `cfg_attr`, platform/target cfgs,
   `cfg(debug_assertions)` — the umbrella these live under.

**Differential caveat (load-bearing):** cfg-gated code changes *what actually
compiles and runs*, so the differential oracle must **pin a specific feature set per
spec** and test the enabled and disabled configurations as **distinct oracle runs**
(each config is its own compile+run+diff). This is why the theme is deferred: it needs
a per-spec cfg-pinning capability in the harness, not just an emitter change.

## Directive scope (open design question)

`"use rc"` / `"use arena"` / `"use panic"` are valid today only on a free function
or at script scope (per-function). With modules, a directive as a **file prologue**
raises: is it **module-wide** (applies to every fn in that `mod`) or **program-wide**
(the whole crate)? The conservative first cut keeps directives **per-function**
(unchanged) and leaves a file-prologue directive fail-loud, deferring the
module-scope question until a real fixture needs it. Flagged for Collin before 050
lands anything touching the directive surface.

## Slices (each lands green)

1. **050a — single import/export + multi-file emission.** The resolver (two-file:
   entry + one dep), `SourceModule` graph, `lowerCrate`, the **multi-file harness**
   (one `.rs` per module + generated `mod foo;` root, one `cargo run`), `export
   function`→ inferred-`pub` `fn`, `import { f }`→`use crate::x::f;`, rename-on-import
   (`f as g`). Inline single-file fast path preserved (no-import fixtures unchanged).
   Bare-import refusal. One differential two-file program green.
2. **050b — multi-file graph + visibility.** Transitive N-file resolution, the
   cycle-terminating visited-set, directory-nested module files, the visibility
   inference (`pub` / `pub(crate)` / `priv`) + the signature-reachability closure,
   per-module-file std-import preludes, imported-module top-level-statement rejection.
3. **050c — cross-module struct/class/enum resolution.** The global symbol table +
   per-module `use` map feeding `lowerType`'s nominal resolution; exported struct
   fields / class methods widened; a cross-module struct literal, method call, and
   enum reference compile + behave. Couples to inheritance across files — a
   `class B extends A` split across modules rides this resolution.
4. **050d — facades, namespaces, prelude.** A pure barrel `index.ts` → a `pub use`
   facade (incl. renamed re-export `export { x as y } from`); `namespace`→nested
   `mod` (coalescing reopened namespaces); prelude-module generation. Grouped/aliased
   `use` synthesis.

## Fail-loud residuals

- **Forbidden:** `export default` (no named Rust analog); a re-export (`export * from`
  / `export { x } from "./y"`) in a **mixed** (non-pure-barrel) file (ambiguous).
- **Not yet:** dynamic `import()`; bare/package imports; top-level statements in
  an imported module; namespace+value declaration merging; an **anonymous value**
  default export (`export default 42/{}/() =>` — no named Rust analog).
- **Not yet (crate-merge inference gap):** the 099 type-oracle infers an untyped
  `const p = new Point(1,2)` / builtin-call binding *by construction*, but it is
  built from a single file's **source + spans**. `lowerCrate` lowers a **synthetic
  merged** program (spliced from N files, no coherent source), so the oracle is
  absent there — a cross-module binding whose type would come from oracle inference
  must carry an **explicit annotation** (`const p: Point = new Point(1,2)`), the
  pre-099 dialect baseline. Wiring a **per-module** oracle (keyed by module + span)
  through the merge is a follow-on; until then annotate. (Same-file inference in a
  single-file program is unaffected.)
- **Lifted (no longer residuals):** **renamed exports** (`export { x as y }` — now a
  `pub use … as y;`) and **pure re-export barrels** (now `pub use` facades, Axis 3);
  **namespace imports** (`import * as ns` — now a `use crate::n as ns;` module alias)
  and **default import/export of a fn/class** (via the reserved `__default_export`
  symbol) — both re-decided 2026-07-17 (Axis 4 note above), land in 050d.
- **Accepted (not a residual):** import cycles — sibling modules in one crate are
  mutually visible.
- The file-prologue directive-scope question is deferred (above). Multi-**crate**
  workspaces (Axis 2 option c) and the `#[cfg]` future theme are deferred to their own
  series (above).
</content>
