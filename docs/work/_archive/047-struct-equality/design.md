# 047 — Struct equality (`===`/`!==` on objects)

Resolves issue **#28**. JS `===` on objects is **identity** equality (two distinct
objects with the same fields are `!==`); Rust `==` via `derive(PartialEq)` is
**structural** (same fields ⇒ equal). Blindly mapping `===`→`==` is a silent
semantic flip. Today `structA === structB` already lowers to `==` (via `BINARY_OPS`
in `emitter.ts`), but `structDeriveClause` in `derives.ts` deliberately omits
`PartialEq`, so the program is *accidentally* fail-loud through an opaque rustc
`E0369` — not a clean dialect signal.

Per the DECISION (2026-07-07, `_pending-decisions.md#28`): the default is
**structural `==`, deriving `PartialEq`** — a *documented semantic divergence from
TypeScript* — with **identity** restored only under `"use rc"` (`Rc::ptr_eq`) and
`"use arena"` (pointer identity on the allocation), where an instance has a stable
heap home for which identity is meaningful.

## Why the default diverges (and why that is acceptable)

Most translated value-struct code (`interface Point { x; y }`, DTOs, config
records) is written *expecting* value equality — it compares two `Point`s to ask
"are these the same point", not "are these the same allocation". Under Option A's
move/clone model, JS object identity is anyway not preserved: a struct is moved,
`.clone()`d by the ownership pass, rebuilt from a literal — the "identity" the JS
`===` would observe has no stable referent to point at. Structural `==` is the
only equality that survives the memory model, and it is what idiomatic Rust
derives by default. So we take it as the default **and document it loudly**: this
is the first entry in a new **"Semantic divergences from TypeScript"** section in
`dialect.md` (the catalog today is pure *rejection*; divergence is a new category),
plus a fixture that pins the structural behavior so a future refactor can't quietly
flip it back.

## Behavior matrix

The operand *shape* × the *active directive* at the comparison site select the
lowering. Scalar equality is unchanged from today.

| Operands | Scope | `===` emits | Semantics |
|---|---|---|---|
| `number` / `string` / `boolean` | any | `==` | value (unchanged) |
| struct / interface / class instance | default | `==` (PartialEq) | **structural — documented divergence** |
| struct-typed binding | `"use rc"` | `Rc::ptr_eq(&a, &b)` | **identity** (shared handle) |
| struct-typed binding | `"use arena"` | `std::ptr::eq(a, b)` | **identity** (allocation) — see residuals |
| any scalar | `"use rc"` / `"use arena"` | `==` | value (directives only affect struct operands) |

`!==` mirrors each row (`!=`, `!Rc::ptr_eq(…)`, `!std::ptr::eq(…)`).

## Default path — structural `==` + `isTypePartialEq` gating

The default requires **no change to the lowering of the binary node**: `lowerExpr`'s
`BinaryExpression` case (`lower.ts` ~1917, the same site that already special-cases
`=== undefined`/`null` → `is_none`/`is_some`, series 042c) emits a plain `binary`
node, and `emitter.ts`'s `BINARY_OPS` already maps `===`→`==`, `!==`→`!=`. The one
missing piece is the **derive**.

Add a new predicate to `derives.ts`, mirroring `isTypeCloneable` / `isTypeDebug`:

```
isTypePartialEq(ty, table, seen): boolean
```

`PartialEq`-eligible field types: `f64`, `usize`, `i64`, `String`, `str`, `bool`
(all `PartialEq`); `vec` iff its `elem` is; `option` iff its `inner` is; `hashmap`
(→ `IndexMap`) iff key **and** value are; `struct` iff every field is (with the same
cycle guard `isStructCloneable` uses). Everything else — notably an `fn`-pointer
field (series 009 function values) or any non-data `RustType` — is **not**
`PartialEq`.

> **`f64` IS `PartialEq`** (unlike `Hash`/`Eq`). So a struct with float fields *can*
> derive `PartialEq` and be compared with `===`. This is the whole point of the
> divergence being usable on ordinary numeric records.

`structDeriveClause` gains a third gated trait: push `"PartialEq"` when
`s.fields.every(f => isTypePartialEq(f.ty, table, new Set([s.name])))`. Order
becomes `Clone, Debug, PartialEq` (Clone-first, matching the enum convention).
This **replaces the accidental `E0369`** for the common case with working code.

### Caveat — this does NOT unblock struct map/set keys (#21)

`f64` is `PartialEq` but **not `Eq`** (NaN ≠ NaN breaks the total-equivalence law).
`isTypePartialEq` is deliberately *not* `isTypeEq`. Struct `HashMap`/`HashSet` keys
need `Eq + Hash` (#21), which stays fail-loud. Do not oversell 047 as unlocking it.

## Identity paths — `"use rc"` and `"use arena"`

Identity is a *rewrite in the directive passes*, not a lowering-time decision. The
default `binary ===` node is emitted uniformly; the `rc`/`arena` HIR→HIR passes
(which already walk the opted-in body and track which bindings are `Rc<RefCell<…>>`
/ arena-allocated) rewrite the comparison when both operands are such bindings.
This keeps the operand-type + active-directive knowledge exactly where it already
lives — no new type oracle threaded into `lowerExpr`.

- **`"use rc"` (`rc.ts`, `refineRc`/`rcBody`).** `rcBody` already holds the `rc` set
  (names bound to `Rc<RefCell<C>>`). When it sees a `binary` node with op `===`/`!==`
  and **both** operands are idents in `rc`, rewrite to a call of the associated fn
  `Rc::ptr_eq(&a, &b)` (op `!==` wraps in a `!`). `Rc::ptr_eq` compares the handles,
  so `const b = a` (an `Rc::clone`) is `=== a` ⇒ **true**, while a freshly built
  equal `C` is `!== a` ⇒ real identity. This is meaningful precisely because an
  `rc` binding has a stable heap home.
- **`"use arena"` (`arena.ts`, `refineArena`/`arenaBody`).** Two instances allocated
  in the same bump arena compare by allocation address: `std::ptr::eq(a, b)`.

### Selection & mismatch rules (both identity paths)

- Both operands directive-bound (both `rc`, or both same-arena) → identity.
- One operand directive-bound, the other a fresh value / different discipline →
  **fail-loud** (`UnsupportedError`, "identity comparison mixes an rc/arena binding
  with a non-<kind> operand") rather than silently comparing a handle to a value.
- Neither operand directive-bound (scalars, or plain structs inside an `rc`/`arena`
  scope) → falls through to the default structural `==`.

## Where the selection info comes from

- **Structural (default):** the emitter needs *no* operand type — `==` is total over
  any `PartialEq`. Correctness is carried entirely by the derive gate.
- **Identity:** the `rc`/`arena` passes already know the operand disposition (the
  `rc` set / arena bindings). The comparison rewrite is a natural extension of those
  passes, not new plumbing.
- **The fail-loud upgrade** (struct operand whose type is *not* `PartialEq`-eligible,
  e.g. a struct with an `fn`-pointer field): detect at the `BinaryExpression` lowering
  site by consulting `analysis.structFields` + `isTypePartialEq`, and raise a clean
  `UnsupportedError` — replacing the opaque `E0369`.

## Slices (each lands green)

1. **047a — structural default.** `isTypePartialEq` in `derives.ts`; `PartialEq`
   added to `structDeriveClause`. New **"Semantic divergences from TypeScript"**
   section in `dialect.md` + a fixture pinning distinct-but-equal structs comparing
   `===`-true. Scalars unchanged. This is the bulk of the value.
2. **047b — rc identity.** `rcBody` rewrites `===`/`!==` over two `rc` idents to
   `Rc::ptr_eq`; the mismatch case fails loud.
3. **047c — the fail-loud upgrade.** Struct operand with a non-`PartialEq` field
   (e.g. `fn`-pointer) → clean `UnsupportedError` instead of `E0369`.

## Impl note (2026-07-08) — the pin is a spec, not a differential fixture

The plan called for "a fixture pinning distinct-but-equal structs comparing
`===`-true." A **differential** fixture can't express this: the harness compares
Rust stdout to the TS run, and the whole point is that they *differ* (Rust `true`,
JS `false`). So the pin lives in `struct-eq-structural.test.ts` **EQ1**, which
asserts *both* the Rust value (`true`) **and** the divergent TS value (`false`) —
a stronger guard than a fixture, since it fails if either side drifts. No fixture
was added.

## Fail-loud residuals

- **Struct map/set keys (#21)** — `f64`-field structs are `PartialEq` but not `Eq`;
  `Eq + Hash` stays deferred.
- **Non-`PartialEq` field types** — a struct carrying an `fn`-pointer (or any future
  non-data field) can't derive `PartialEq`; `===` on it is a clean `UnsupportedError`
  (047c), not silent.
- **Arena-allocated *structs*** — `arena.ts` today only bump-allocates `Vec`
  literals of `Copy` elements, not struct nodes. The `std::ptr::eq` identity path is
  *specified* here but only exercised once arena struct allocation graduates; until
  then a struct `===` inside a `"use arena"` scope takes the default structural path
  (its operands aren't arena-bound). No silent miscompile — documented.
- **Identity/discipline mismatch** — comparing an `rc`/`arena` binding to a
  non-matching operand fails loud rather than guessing.
- **Cross-type `===`** (`number === struct`, etc.) — already ill-typed TS; not our
  concern to model.
