# 059 — Struct / interface deferrals (extends, readonly, arg-literals, mutation)

> **Status: SHIPPED.** Graduates the fail-loud deferral in issue #22. Dialect-shape
> decisions made with Collin 2026-07-09.
>
> **Impl note (getter shape).** The interface getter trait returns fields **by
> value via `.clone()`** (`fn x(&self) -> Tx { self.x.clone() }`), not `&Tx` like
> the 053 class accessors. A base-typed `&impl IA` param then reads `a.x` as a plain
> value with no deref dance (`return a.x()` type-checks directly against a value
> return). Every field type in the dialect is `Clone`, so this is uniform.
> Interface `extends` uses a dedicated, self-contained synthesis
> (`synthesizeInterfaceTraits`) rather than the class `synthesizeTraits` (which
> builds its trait from *methods*, absent on a data-only interface).

## Already shipped (not this series)

Most of issue #22's text is done: **optional fields `x?: T` → `Option<T>`** (042b),
**`#[derive]` + whole-struct `Debug` printing** (`derives.ts`, on-demand `Debug`),
**struct equality** (047), **nested struct literals** (032). This series is the
*remainder*.

## The remainder

1. **`interface B extends A`** — currently fail-loud (`lower.ts:1713`).
2. **`readonly` fields** — currently unmodeled.
3. **Function-argument struct literals** — the 032 residual (`f({x:1,y:2})` with no
   binding annotation).
4. **Local struct field mutation** — `s.x = …`.

## Decisions

- **`extends` (Fork 1): trait-based, reusing 053's class-inheritance machinery.** An
  extended interface gets a **getter trait**; base and derived structs implement it;
  parameters of a base-interface type become `&impl IA`, preserving TS subtype
  polymorphism (pass a `B` where an `A` is expected).
- **`readonly` (Fork 2): validator-enforced rejection.** Assignment to a `readonly`
  field is a `DialectError`; the struct itself emits as a plain field.
- **Arg-literals & local mutation: mechanical**, no fork (below).

### Why trait-based `extends` over flatten

Flatten (inline base fields) is simpler but nominal — it cannot pass a derived where
the base is expected. Collin chose to preserve subtype polymorphism; classes already
took the trait route in 053, so interfaces reuse the same getter-trait pattern rather
than inventing a second inheritance story. This is the shared machinery the coupling
map predicted between #22 and #23.

## Mechanism

### `interface B extends A` (trait-based)

Mirrors 053 (`lower.ts:1962`, "build the shared trait IA from the base"):

- **Concrete fields still flatten** — `struct B` carries A's fields *and* B's own as
  real fields (so construction and Debug work unchanged).
- **Getter trait** — an extended interface `A` generates `trait IA { fn x(&self) ->
  Tx; … }` with one getter per A-field; `impl IA for A` and `impl IA for B` return
  the respective fields.
- **Polymorphic use** — a parameter/return typed as a base interface `A` lowers to
  `&impl IA` (or generic `T: IA`); field access inside such a body goes through the
  getter (`a.x()`), exactly as 053 does for classes. A value typed as the *concrete*
  struct keeps direct field access.
- Multi-level `extends` reuses 053's root-of-chain trait logic.

```ts
interface A { x: number }
interface B extends A { y: number }
function useA(a: A): number { return a.x; }
```
```rust
struct A { x: f64 }
struct B { x: f64, y: f64 }
trait IA { fn x(&self) -> f64; }
impl IA for A { fn x(&self) -> f64 { self.x } }
impl IA for B { fn x(&self) -> f64 { self.x } }
fn use_a(a: &impl IA) -> f64 { a.x() }
```

### `readonly` fields (validator-enforced)

- Record each `readonly` field per struct (from the `readonly` modifier on interface
  members / class properties).
- **Validation**: an assignment target `s.f` (or `&mut` borrow of it) where `f` is
  `readonly` → `DialectError` ("assignment to readonly field `f`"). **Construction**
  (struct-literal initialization) is allowed — it is not assignment.
- The emitted struct field is plain; enforcement is the dialect's, not Rust's.

### Function-argument struct literals (032 residual)

`f({ x: 1, y: 2 })` where `f`'s parameter is typed `Point` (or `&impl IPoint`): look
up the callee's parameter type (the signature maps already built in `numeric.ts` /
lowering), and lower the object literal as a `Point { x: 1, y: 2 }` struct literal
(reusing 032's nested-literal path with the target type supplied by the param instead
of a binding annotation). No fork; the only new thing is sourcing the target type
from the call signature.

### Local struct field mutation

`s.x = v` on a local `s`: extend the existing mutability walk (the one that decides
`let mut`) to treat a field-assignment target `s.x` as a mutation of `s`, so `s`
binds `mut` and the assignment emits directly. Mutation through a **borrowed struct
parameter** (`&mut self` / `&mut Point`) is **out of scope here** — it rides #23's
method-parameter borrow decision.

## Fail-loud residuals

- **Readonly assignment** — `DialectError` (the point of Fork 2).
- **Mutation through a borrowed struct param** — deferred to #23.
- **Destructured anonymous-object arg literal with no nameable target type** — no
  struct to construct (same boundary as 058's destructuring rule).
- **`implements` on a class for an interface** — separate; not this series.

## Impl sequence

1. Getter-trait generation for extended interfaces (reuse 053 helpers); flattened
   concrete fields; `&impl IA` params + getter access.
2. `readonly` tracking + validator rejection.
3. Arg-position struct literals (target type from the call signature).
4. Local field-mutation → `let mut` extension.
5. RED specs → GREEN.

## Specs sketch

- `interface B extends A`; `useA(b)` passes a `B` where `A` is expected (polymorphism).
- Multi-level extends (`C extends B extends A`).
- `readonly id`; `p.id = 5` → `DialectError`; construction of `p` still compiles.
- `f({x:1, y:2})` arg literal → `Point { .. }`.
- `s.x = 9` on a local → `let mut s`, differential-match.

## Open sub-details (impl, not dialect forks)

- Whether a base interface that is *never* used polymorphically skips the trait
  (optimization) or always emits it (uniformity). Default: emit only when extended.
- Getter naming collision rules vs 053 (share the helper).
