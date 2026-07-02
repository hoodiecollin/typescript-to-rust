# 010 — Data structures: records → `HashMap`

## Problem

Control flow is complete (series 006–009). The next queue item is **data
structures**. The first slice is the record fixture (`04_data_structures/
02_records`, still `test.todo`):

```ts
const map: Record<string, number> = { "a": 1, "b": 2 };
let val: number = map["a"];
```

A `Record<string, T>` is a dynamically-keyed string map — Rust's
`HashMap<String, T>`. The object literal is its construction, and `map["a"]` is a
keyed lookup. All three (the type, the literal, the index) need a home.

The target compiles and runs (verified with `rustc`):

```rust
use std::collections::HashMap;

fn main() {
    let map: HashMap<String, f64> = HashMap::from([("a".to_string(), 1.0), ("b".to_string(), 2.0)]);
    let val: f64 = map["a"];
}
```

## Scope (decided 2026-07-02)

**In:** `Record<string, V>` → `HashMap<String, V>`, its object-literal
construction, and string-literal keyed lookup.

- **Type.** `Record<string, V>` → a new `RustType` `{ kind: "hashmap"; key;
  value }`, rendered `HashMap<String, V>`. The key type must be `string`
  (see limits); `V` lowers recursively.
- **Construction.** An object literal **in a record-typed binding** →
  `HashMap::from([(k, v), …])` (a new `HirExpr` `hashmap`). Empty `{}` →
  `HashMap::new()` (the array form can't infer an element type from `[]`; the
  binding annotation carries `K,V`). The literal is interpreted **contextually**:
  the `let`'s annotation says it is a map, so lowering wires it at the
  declaration. A bare object literal with no record annotation stays unsupported
  (it is ambiguous with a struct literal — that is series 011).
- **Lookup.** `map["a"]` is already an `index` HIR node (computed
  `MemberExpression`). A **string-literal** index renders as a bare `&str`
  (`map["a"]`), not `"a".to_string()` — `HashMap: Index<&Q> where K: Borrow<Q>`
  wants `&str`, and a `Copy` value (`f64`) copies out of the returned place.
- **Prelude.** A module that uses a `HashMap` gets `use std::collections::HashMap;`
  prepended.

**Deferred — own later series (documented, not silently handled):**

- **`interface`/object → `struct` literals** (`05_interfaces/01_basic`) — the
  *next* data-structure slice (011). Object literals only lower in a record
  context here; a struct-typed literal is unsupported until then.
- **Non-`string` keys.** `Record<number, V>` would be `HashMap<f64, V>`, but
  `f64` is neither `Eq` nor `Hash` — no sound mapping. A non-`string` Record key
  throws `UnsupportedError`.
- **Variable / non-literal keys.** `map[k]` with a `String` variable needs
  `map[&k]` (borrow) and touches the numeric pass's index-seeding (which assumes
  `usize`); only a string *literal* key lands this slice.
- **Mutation & methods** — `map.set(k, v)` / `map[k] = v` / `.get()` / `.has()` /
  `.delete()` / iteration — await a maps-API slice.
- **`Map`/`Set`** (the JS classes, distinct from a `Record`) — separate.

**Out:** nested/heterogeneous records beyond `Record<string, primitive|Array>`.

## Design

### AST (`ast.ts`)

Add the two ESTree nodes the parser emits (verified against real output):

```ts
export interface Property extends Span {
  type: "Property";
  key: Expression;          // a string `Literal` in the dialect
  value: Expression;
  computed: boolean;
  shorthand: boolean;
  kind: string;             // "init"
}
export interface ObjectExpression extends Span {
  type: "ObjectExpression";
  properties: Property[];
}
```

`Record`'s `typeArguments.params` (`[TSStringKeyword, V]`) reuse the existing
`TSTypeReference` shape.

### HIR (`hir.ts`)

```ts
export type RustType =
  | … | { kind: "hashmap"; key: RustType; value: RustType };

export type HirExpr =
  | … | { kind: "hashmap"; entries: { key: HirExpr; value: HirExpr }[] };
```

### Emitter (`emitter.ts`) — the shape (lands in the scaffold)

- `emitType` `hashmap` → `HashMap<${key}, ${value}>`.
- `emitExpr` `hashmap` → `HashMap::from([(k, v), …])`, or `HashMap::new()` when
  empty.
- `emitIndex` gains a **string** case: a `string` index renders as the bare
  `&str` literal (`map["a"]`), skipping `.to_string()` — mirroring the existing
  bare-integer case for `usize` indices.
- `emitModule` prepends `use std::collections::HashMap;` when the module uses a
  `HashMap` (a generic deep-scan for any `kind: "hashmap"` node).

Exhaustive `RustType`/`HirExpr` switches force these cases to exist — the
emitter stays pure and total.

### Lowering (`lower.ts`) — the gate

- `lowerType` `Record` → `{ kind: "hashmap", key, value }`; a non-`string` key
  throws.
- `lowerVarDecl`: when the binding's resolved type is a `hashmap` **and** the
  init is an `ObjectExpression`, lower the literal to a `hashmap` HirExpr
  (`lowerHashMapLiteral`) — keys/values lowered as expressions.
- A bare `ObjectExpression` elsewhere (`lowerExpr`) throws `UnsupportedError`
  ("object literal without a Record/struct type") — fail-loud, ambiguous until
  structs.

### Numeric pass (`numeric.ts`)

`eachExpr` gains a `hashmap` case, recursing into each entry's key/value (keeps
the walk exhaustive; record values are plain `f64`, so nothing refines). The
string index seeded into usize-context by `usizeContextRoots` is inert (a
non-`number` node is skipped by `markContext`).

## Limits (documented, not silently handled)

- **String keys only** — `Record<number, V>` throws (`f64` isn't `Hash`/`Eq`).
- **String-literal lookup only** — variable keys deferred (borrow + numeric
  seeding).
- **Construction-only** — no mutation, `.get`, iteration, or maps API yet.
- **Contextual literals** — an object literal lowers only in a record-typed
  binding; struct literals are series 011.

## Verification

- **Unit (cargo-free):** `tests/records.test.ts` drives `emit(…)` and asserts the
  emitted shape — `HashMap<String, f64>` type (REC1), `HashMap::from([…])`
  construction (REC2), bare-`&str` lookup `map["a"]` (REC3), the
  `use std::collections::HashMap;` prelude (REC4), and a non-record green control
  (REC5).
- **Oracle (cargo-backed):** flip `04_data_structures/02_records` to `SUPPORTED`
  (tier 1: COMPILES) and add a tier-2 differential — build a map, print a looked-up
  value — asserting Rust stdout equals the TypeScript's.

## Workflow note

Full spec-first: docs → scaffold (HIR `hashmap` type+expr and the emitter cases
land; `lower.ts` keeps a `Record` seam throwing `UnsupportedError` "records →
HashMap lowering pending", so the specs are RED) → **RED** → real `lowerType`
`Record` + `lowerHashMapLiteral` + string-index emit to GREEN → archive.
Interface/struct literals, non-string keys, variable keys, and the maps API each
get a **new** series.
