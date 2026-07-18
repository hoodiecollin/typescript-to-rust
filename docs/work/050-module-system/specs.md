# 050 — specs

Spec-ID prefix **`MOD`**. Multi-file specs feed the resolver an **entry file** plus
its `./`-relative deps; the differential oracle compiles + runs the emitted crate
(**one binary** — a real multi-file cargo project under Axis 2, or the inline
single-file fast path) and compares stdout against Bun running the same TS program.

## 050a — single import/export + multi-file emission (`packages/compiler/tests/module-single.test.ts`)

- **MOD1** two files — `math.ts`: `export function add(a: number, b: number):
  number { return a + b; }`; entry `main.ts`: `import { add } from "./math";
  console.log(add(2, 3));` — compiles; emitted contains `pub fn add` /
  `pub(crate) fn add` and `use crate::math::add;`.
- **MOD2** (differential) that two-file program **behaves**: Rust stdout `5` equals
  Bun stdout `5`.
- **MOD3** `import { add as plus } from "./math"` → `use crate::math::add as plus;`;
  a call `plus(2, 3)` compiles and behaves.
- **MOD4** an entry file with no `import`/`export` still compiles via the existing
  single-`Program` **fast path** (backward-compatible; inline single file, no extra
  module files emitted).
- **MOD5** (fail-loud) `import _ from "lodash"` (bare/package specifier) →
  `UnsupportedError` — no `node_modules` resolution.
- **MOD5b** (multi-file emission — Axis 2) the MOD1 program emits a **real multi-file
  cargo project**: a `src/math.rs` module file (containing `pub fn add` /
  `pub(crate) fn add`) plus a `mod math;` declaration at the crate root wiring it in;
  one binary, one `cargo run`. Shape assertion on the emitted file layout.

## 050b — multi-file graph + visibility (`packages/compiler/tests/module-graph.test.ts`)

- **MOD6** a 3-file transitive chain (entry → `a` → `b`, entry calls a `pub fn` in
  `a` that calls a `pub fn` in `b`) compiles and behaves.
- **MOD7** an `A ↔ B` import cycle terminates the resolver and compiles (sibling
  `mod`s are mutually visible; the cycle is not rejected).
- **MOD8** visibility: an `export function f(): Foo` returning a **non-exported**
  struct `Foo` in the same file marks `Foo` `pub(crate)` (reachable through the
  exported signature); emitted contains `pub(crate) struct Foo`.
- **MOD9** a purely-local, non-exported, non-cross-referenced helper stays private
  (no visibility keyword — emitted `fn helper`, not `pub`/`pub(crate)`).
- **MOD10** a directory-nested import `import { f } from "./util/math"` → a real
  `src/util/math.rs` module file (with the `util` dir wired via `mod util;` /
  `mod math;`) and `use crate::util::math::f;`; compiles + behaves.
- **MOD11** a module whose items use a `Record` emits its own
  `use std::collections::…` / `use indexmap::IndexMap;` prelude inside the `mod`
  (per-`mod` scan, not only crate root); compiles.
- **MOD12** (fail-loud) a top-level executable statement in an imported (non-entry)
  file (e.g. `console.log("side effect")`) → `UnsupportedError`.

## 050c — cross-`mod` struct/class/fn resolution (`packages/compiler/tests/module-types.test.ts`)

- **MOD13** an `export class Point { constructor(public x: number, public y:
  number) {} }` in `point.ts`, constructed in the entry (`import { Point }` →
  `use crate::point::Point;`, `new Point(1, 2)`), compiles — emitted `pub struct
  Point` with `pub` fields + a `pub fn new`.
- **MOD14** (differential) a cross-`mod` method call (`p.dist()` where `dist` is an
  exported method) behaves — Rust stdout equals Bun stdout.
- **MOD15** an `export interface Shape` used as a cross-`mod` struct-literal type
  resolves nominally through the importer's `use` map and compiles.
- **MOD16** an `export enum Color` referenced across a module boundary
  (`Color.Red`) compiles and behaves.

## 050d — facades, namespaces, prelude (`packages/compiler/tests/module-facades.test.ts`)

- **MOD23** (differential) a **pure barrel** `index.ts` whose body is only
  `export { add } from "./math";` → a generated `pub use crate::math::add;` facade
  module; the entry `import { add } from "./index"` (or `"./"`) compiles and behaves
  (Rust stdout equals Bun). Pins Axis 3 Position A.
- **MOD24** (differential) a **renamed re-export** in a pure barrel
  `export { add as plus } from "./math";` → `pub use crate::math::add as plus;`;
  a call through the facade behaves. Pins the **lifted** renamed-export residual.
- **MOD25** (fail-loud) a **mixed** barrel (a file with both a re-export
  `export { x } from "./y";` **and** its own runtime logic/decl) → rejected with the
  `re-export outside a pure barrel` message (ambiguous — not a pure facade).
- **MOD20** (differential) a **namespace import** `import * as m from "./math"` →
  a Rust **module alias** `use crate::math as m;`, with member access `m.add()`
  routed to the path `m::add()` — TS `import *` is *qualified* access, not an
  unqualified glob, so there is no capture (re-decided 2026-07-17). Behaves.
- **MOD26** (differential) a `namespace Geometry { export function square(n): number
  { … } }` → an inline `mod Geometry { pub fn square … }`; `Geometry.square()` →
  `Geometry::square()`; compiles and behaves (Axis 4).
- **MOD26b** (differential) a namespace member calling a **sibling** member
  (`quad` calls `dbl`) resolves as an intra-`mod` bare call; behaves.
- **MOD27** (differential) a **reopened** namespace (`namespace M { … }` declared
  twice) is **coalesced** into one inline `mod M`; both members resolve; compiles
  and behaves.
- **MOD28** (shape) prelude-module generation: a crate's library exports are
  gathered into a generated inline `mod prelude { pub(crate) use … }` and each
  library module file globs it (`use crate::prelude::*;`); compiles + behaves
  (differential-neutral name routing; a cross-module name collision is dropped).

## Fail-loud residuals (`packages/compiler/tests/module-failloud.test.ts`)

- **MOD17** (fail-loud) `export default 42;` (`ExportDefaultDeclaration`) →
  rejected with the dedicated `export default` message (no named Rust analog).
- **MOD18** (fail-loud) `export * from "./barrel";` in a **mixed** (non-pure-barrel)
  file → rejected with the `re-export outside a pure barrel` message. (A pure-barrel
  `export *` with an enumerable source set is a facade glob, not a residual.)
- **MOD21** (fail-loud) dynamic `import("./x")` (`ImportExpression`) → rejected.

> **Lifted residuals (now supported):** MOD19 (`import def from "./d";` default
> import) and MOD20 (`import * as ns` namespace import) were **re-decided
> 2026-07-17 → supported** — MOD19 rides the reserved `__default_export` symbol
> (see `module-default.test.ts`); MOD20 is the module-alias path route above.
> The old MOD22 (`export { x } from "./y";` rejected as a barrel) and the old
> renamed-export residual are also **lifted** — a pure-barrel re-export is now the
> MOD23/MOD24 facade path; only a **mixed**-file re-export stays fail-loud (MOD25).
> Import cycles remain **accepted** (MOD7), not a residual.
</invoke>
