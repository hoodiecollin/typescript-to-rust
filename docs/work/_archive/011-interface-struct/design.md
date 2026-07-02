# 011 — Data structures: `interface`/object → `struct` literals

## Problem

Series 010 shipped records → `HashMap`. The other data-structure fixture is the
interface (`05_interfaces/01_basic`, still `test.todo`):

```ts
interface Point {
  x: number;
  y: number;
}
const p: Point = { x: 10, y: 20 };
```

A closed, statically-known object shape is Rust's `struct`. This needs three
things: the `interface` → a `struct` **item** (like a function declaration),
resolving the named type `Point` in an annotation, and the object literal → a
**struct literal** `Point { x: 10.0, y: 20.0 }` (the same literal that lowered to
a `HashMap` in a record context — the binding's type disambiguates).

The target compiles and runs (verified with `rustc`):

```rust
struct Point {
    x: f64,
    y: f64,
}

fn main() {
    let p: Point = Point { x: 10.0, y: 20.0 };
}
```

## Scope (decided 2026-07-02)

**In:** `interface` → `struct`, a named-struct-typed annotation, and an object
literal in a struct-typed binding → a struct literal.

- **Item.** `TSInterfaceDeclaration` → a new `HirStruct` item
  (`{ kind: "struct"; name; fields: {name, ty}[] }`), rendered
  `struct Name { field: Ty, … }`. `HirModule.items` broadens from `HirFn[]` to a
  `HirItem[]` union (`HirFn | HirStruct`).
- **Named type.** A `struct` `RustType` (`{ kind: "struct"; name }`, rendered as
  the bare name). Interface names are collected into the module analysis
  (`analysis.structs`) so `lowerType` resolves a `TSTypeReference` to a declared
  interface — and only a declared one; an unknown type name still throws
  (`Promise`, `Map`, … stay fail-loud).
- **Literal.** An object literal **in a struct-typed binding** → a `structLit`
  HirExpr (`Name { field: value, … }`), interpreted contextually in
  `lowerVarDecl` — exactly parallel to the record path. Field keys are
  identifiers (or string literals); values lower as expressions.
- **Field read.** `p.x` already lowers to the `field` HIR node → `p.x`. No change.

**Deferred — own later series (documented, not silently handled):**

- **`class` → `struct` + `impl`** (`06_classes`) — methods, constructors, `this`,
  `new`. Interfaces are data-only; classes are the next struct slice.
- **`interface extends` / inheritance** — rejected (`UnsupportedError`).
- **Optional (`x?: T`) and readonly fields** — `Option<T>` mapping and field
  mutability need their own decisions; an optional field throws.
- **Nested / struct-typed fields, arrays of structs, structs in a `HashMap`** —
  compose once the base case lands; `lowerType` already recurses, but no fixture
  exercises it and the ownership story (owned vs borrowed field) is unproven.
- **Struct mutation & field assignment** (`p.x = …`, a `mut` struct binding) —
  the analysis pass is name-based; struct-field mutability is a follow-up.
- **`#[derive(...)]`** (`Debug`/`Clone`/`PartialEq`) and printing a whole struct —
  the fixture reads a field, not the struct; deriving awaits a need.

**Out:** structural typing / duck typing (Rust structs are nominal — a literal
must name its struct), index signatures on interfaces (that is a `Record`).

## Design

### AST (`ast.ts`)

Add the interface nodes (verified against real parser output):

```ts
export interface TSPropertySignature extends Span {
  type: "TSPropertySignature";
  key: Identifier;
  typeAnnotation: TSTypeAnnotation | null;
  optional: boolean;
  computed: boolean;
}
export interface TSInterfaceBody extends Span {
  type: "TSInterfaceBody";
  body: TSPropertySignature[];
}
export interface TSInterfaceDeclaration extends Span {
  type: "TSInterfaceDeclaration";
  id: Identifier;
  body: TSInterfaceBody;
  extends: unknown[];
}
```

`ObjectExpression`/`Property` already exist (series 010).

### HIR (`hir.ts`)

```ts
export type RustType = … | { kind: "struct"; name: string };
export type HirExpr = … |
  { kind: "structLit"; name: string; fields: { name: string; value: HirExpr }[] };

export interface HirStruct {
  kind: "struct";
  name: string;
  fields: { name: string; ty: RustType }[];
}
export type HirItem = HirFn | HirStruct;
export interface HirModule { items: HirItem[]; main: HirStmt[]; }
```

### Emitter (`emitter.ts`) — the shape (lands in the scaffold)

- `emitModule` maps items through an `emitItem` switch (`fn` → `emitFn`,
  `struct` → `emitStruct`), preserving exhaustiveness.
- `emitStruct` → `struct Name {\n    field: Ty,\n …\n}` (empty → `Name {}`).
- `emitType` `struct` → the bare name.
- `emitExpr` `structLit` → `Name { field: value, … }` (empty → `Name {}`).

### Lowering (`lower.ts`) — the gate

- Collect interface names in `analyzeModule` → `analysis.structs: Set<string>`.
- `lower()` routes `TSInterfaceDeclaration` → `lowerInterface` (a `HirStruct`
  item); interface decls never enter the `script`/`main` body.
- `lowerType` resolves a `TSTypeReference` whose name is in `structs` →
  `{ kind: "struct", name }`; `extends`, optional fields → `UnsupportedError`.
- `lowerVarDecl`: when the binding type is a `struct` and the init is an
  `ObjectExpression`, lower to a `structLit` (`lowerStructLiteral`).
- `lowerType` gains a `structs` parameter, threaded from the three annotation
  callers (param, return, var decl) and its own recursion.

### Numeric / string passes

- `refineNumerics` / `refineStrings` iterate `module.items` but only touch
  `kind === "fn"` items (skip structs).
- `eachExpr` gains a `structLit` case (recurse into field values — inert for the
  `f64` fixture, but keeps the walk exhaustive).

## Limits (documented, not silently handled)

- **Interfaces only** — `class` (methods/`new`/`this`) is a separate series.
- **No inheritance, optional, or readonly fields** — each throws.
- **Nominal literals** — an object literal must resolve to a declared struct (or a
  record); a bare/unknown-typed literal is fail-loud.
- **No struct mutation / field assignment / whole-struct printing / derives** yet.

## Verification

- **Unit (cargo-free):** `tests/interfaces.test.ts` drives `emit(…)` and asserts
  the emitted shape — the `struct Point { … }` definition with `f64` fields
  (INT1), the `Point { x: 10.0, y: 20.0 }` literal (INT2), the named-type binding
  `let p: Point =` (INT3), a field read `p.x` (INT4), and a non-interface green
  control (INT5).
- **Oracle (cargo-backed):** flip `05_interfaces/01_basic` to `SUPPORTED` (tier 1:
  COMPILES) and add a tier-2 differential — construct a struct and print a field —
  asserting Rust stdout equals the TypeScript's.

## Workflow note

Full spec-first: docs → scaffold (HIR `struct` type/`structLit` expr/`HirStruct`
item and the emitter cases land; `lower.ts` keeps a `TSInterfaceDeclaration` seam
throwing `UnsupportedError` "interface → struct lowering pending", so the specs
are RED) → **RED** → real `lowerInterface` + `structs` registry + `lowerType`
resolution + `lowerStructLiteral` to GREEN → archive. Classes, inheritance,
optional fields, and nested/struct-typed fields each get a **new** series.
