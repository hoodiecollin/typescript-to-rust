# 050 — specs

Spec-ID prefix **`MOD`**. Multi-file specs feed the resolver an **entry file** plus
its `./`-relative deps; the differential oracle compiles + runs the emitted single
`lib.rs`/`main.rs` and compares stdout against Bun running the same TS program.

## 050a — single import/export (`packages/compiler/tests/module-single.test.ts`)

- **MOD1** two files — `math.ts`: `export function add(a: number, b: number):
  number { return a + b; }`; entry `main.ts`: `import { add } from "./math";
  console.log(add(2, 3));` — compiles; emitted contains `mod math {`, `pub fn add`,
  and `use crate::math::add;`.
- **MOD2** (differential) that two-file program **behaves**: Rust stdout `5` equals
  Bun stdout `5`.
- **MOD3** `import { add as plus } from "./math"` → `use crate::math::add as plus;`;
  a call `plus(2, 3)` compiles and behaves.
- **MOD4** an entry file with no `import`/`export` still compiles via the existing
  single-`Program` path (backward-compatible; no `mod` emitted).
- **MOD5** (fail-loud) `import _ from "lodash"` (bare/package specifier) →
  `UnsupportedError` — no `node_modules` resolution.

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
- **MOD10** a directory-nested import `import { f } from "./util/math"` →
  `mod util { mod math { … } }` and `use crate::util::math::f;`; compiles + behaves.
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

## Fail-loud residuals (`packages/compiler/tests/module-failloud.test.ts`)

- **MOD17** (fail-loud) `export default 42;` (`ExportDefaultDeclaration`) →
  rejected with the dedicated `export default` message (no named Rust analog).
- **MOD18** (fail-loud) `export * from "./barrel";` (`ExportAllDeclaration`,
  re-export barrel) → rejected — against the no-barrel ethos.
- **MOD19** (fail-loud) `import def from "./d";` (default import,
  `ImportDefaultSpecifier`) → rejected.
- **MOD20** (fail-loud) `import * as ns from "./n";` (namespace import) → rejected.
- **MOD21** (fail-loud) dynamic `import("./x")` (`ImportExpression`) → rejected.
- **MOD22** (fail-loud) a re-export `export { x } from "./y";`
  (`ExportNamedDeclaration` with a non-null `.source`) → rejected as a barrel.
</content>
</invoke>
