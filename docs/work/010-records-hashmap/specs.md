# 010 — Specs

Unit specs drive the public `emit(...)` entry (parse → lower → emit → Rust
string) and assert the emitted shape of a `Record` → `HashMap`: the type, the
`HashMap::from([…])` construction, the bare-`&str` keyed lookup, and the
`use` prelude. The cargo-backed COMPILES/BEHAVES proof lives in the fixture and
differential test. IDs are referenced from the test files.

## Unit — records via `emit` (`tests/records.test.ts`)

Reference program unless noted:
```ts
const map: Record<string, number> = { "a": 1, "b": 2 };
let val: number = map["a"];
```

- **REC1** the record type lowers to `HashMap<String, f64>`.
  emitted Rust contains `let map: HashMap<String, f64> =`.

- **REC2** the object literal lowers to a `HashMap::from` construction with each
  entry as a `(key.to_string(), value)` tuple.
  emitted Rust contains
  `HashMap::from([("a".to_string(), 1.0), ("b".to_string(), 2.0)])`.

- **REC3** a string-literal lookup is a bare `&str` index, not a `String`.
  emitted Rust contains `map["a"]` (no `.to_string()` on the key), and the
  binding is `let val: f64 = map["a"];`.

- **REC4** a module using a `HashMap` gets the std import prepended.
  emitted Rust starts with `use std::collections::HashMap;`.

- **REC5 (green control)** a program **without** any record still emits unchanged
  and gets **no** `HashMap` import — the new type/expr and the `Record` seam do
  not regress existing lowering nor leak the prelude.
  `const n: number = 1;` → contains `let n: f64 = 1.0;` and does **not** contain
  `HashMap`.

## Oracle — fixture + differential (`tests/compiler.test.ts`)

- **Tier 1 (COMPILES):** `04_data_structures/02_records` moves into `SUPPORTED`;
  its emitted Rust must pass `cargo check`.

- **Tier 2 (BEHAVES):** build a map and print a looked-up value
  ```ts
  const scores: Record<string, number> = { "ada": 10, "linus": 7 };
  const ada: number = scores["ada"];
  console.log(ada);
  ```
  → Rust stdout equals the TS stdout (`10`).
