# 047 — specs

Spec-ID prefix `EQ`. Structural-by-default is a **documented divergence**, so the
differential specs assert Rust-structural truth values (which differ from JS
identity) — that difference is the pinned behavior.

## 047a — structural default (`packages/compiler/tests/struct-eq-structural.test.ts`)

- **EQ1** two distinct-but-equal structs compare equal (the divergence):
  `const a: Point = {x:1,y:2}; const b: Point = {x:1,y:2}; console.log(a === b)`
  → stdout `true`. Emitted `struct Point` carries `#[derive(… PartialEq)]`; the
  comparison emits `a == b`. (In JS this is `false` — the pinned divergence.)
- **EQ2** structs differing in one field are unequal:
  `{x:1,y:2} === {x:1,y:9}` → `false` (differential proves it isn't a constant).
- **EQ3** `!==` differential: EQ1's operands with `!==` → `false`; EQ2's → `true`;
  emitted uses `!=`.
- **EQ4** nested-struct structural equality: a struct with a struct field compares
  deep-structurally (`{p:{x:1}} === {p:{x:1}}` → `true`); the outer derive line
  includes `PartialEq` and the inner struct does too.
- **EQ5** `f64` fields are `PartialEq` but **not `Eq`**: a float-field struct's
  derive line contains `PartialEq` and does **not** contain a bare `Eq` (guards the
  #21 non-regression — no accidental `Eq`/`Hash`).

## 047b — rc identity (`packages/compiler/tests/struct-eq-rc.test.ts`)

- **EQ6** under `"use rc"`, an aliased handle is identity-equal but a fresh equal
  struct is not: `"use rc"; const a = new C(1); const b = a; const c = new C(1);`
  → `a === b` is `true`, `a === c` is `false`. Emitted contains `Rc::ptr_eq`, not a
  bare `==`, for these comparisons. (Contrast EQ1: same field values, opposite
  result — identity vs structural.)
- **EQ7** `!==` under `"use rc"` emits `!Rc::ptr_eq(…)` and is the boolean
  complement of EQ6.

## 047c — scalars unchanged + fail-loud (`packages/compiler/tests/struct-eq-edge.test.ts`)

- **EQ8** scalars are untouched by the directive scopes: `1 === 1` → `true`,
  `"a" === "b"` → `false`, emitted `==` — inside a `"use rc"` scope too (directives
  only affect struct operands).
- **EQ9** (fail-loud) a struct whose type is **not** `PartialEq`-eligible (a struct
  with an `fn`-pointer field, series 009 function value) compared with `===` raises a
  clean `UnsupportedError` (the divergence-upgraded diagnostic), **not** an opaque
  cargo `E0369`.
- **EQ10** (fail-loud) an identity/discipline mismatch under `"use rc"` — comparing
  an `rc` binding to a non-`rc` operand with `===` — raises `UnsupportedError` rather
  than silently comparing a handle to a value.
