# 081 — Class generics (`class Box<T>`, monomorphization + interface bounds)

> **Status: DESIGN COMPLETE (2026-07-13). Impl pending.** This is issue **#40**
> (split from #36). Dialect calls made with Collin 2026-07-13 (`needs-user-input`
> cleared). Unblocked by **#43/071 slice 1** (behavioral-interface traits exist, so
> `<T extends I>` has an `I<Name>` to bind by). Introduces **type parameters into
> the type system for the first time**.
>
> Spec-first: this `design.md` → RED `specs.md` → impl → archive. Decomposes into
> impl sub-slices (see **Impl decomposition**); each ships spec-first.

## Problem

The dialect supports **no** user type parameters. `class Box<T>`, generic methods,
and a bare `T` are all `UnsupportedError`: `T` isn't a declared struct, so
`lowerType` (`lower.ts` `TSTypeReference` tail) fails loud on it. `RustType` has no
type-variable kind. 060 explicitly deferred generics to "its own series" (Fork 2).

## Decisions (2026-07-13, with Collin)

### 1. Model — monomorphization (settled pre-#43)

Emit real `struct Box<T>` + `impl<T> Box<T>`; rustc monomorphizes per instantiation
(zero-cost, idiomatic). Add a **`{ kind: "param"; name: string }` `RustType`**,
threaded through lowering like `structs` (a per-scope set of in-scope type-param
names so `lowerType` resolves a bare `T` to `{kind:"param"}` instead of failing
loud). Erased / trait-object representation was rejected as un-Rust.

### 2. Bounds — derive-driven (settled pre-#43)

Emit the generic struct with the derives the class already gets (`derives.ts`);
rustc auto-adds `T: Clone` / `PartialEq` / `Debug` per derive. Accepted cost:
`Box<NonClone>` fails at a derive bound even if `T` is never cloned.

### 3. Constraints — `<T extends I>` → `T: I<Name>`, **in slice 1** (Q, 2026-07-13)

Now that 071 slice 1 ships behavioral-interface traits, a **behavioral-interface**
constraint lowers to a Rust trait bound and generics arrive *useful* — a bounded
`T` can **call the interface's methods**:

```ts
class Box<T extends Shape> { v: T; area(): number { return this.v.area(); } }
```
```rust
struct Box<T: IShape> { v: T }
impl<T: IShape> Box<T> { fn area(&self) -> f64 { self.v.area() } }
```

The bound reuses `traitNameOf(I)` (071). **In scope:** a single behavioral-interface
bound on a class or method type param. **Fail-loud (later):** a **class** as a bound
(`<T extends SomeClass>` — a class isn't a trait unless it is an inheritance base
with a synthesized trait; resolve when that path is needed), and **multi-bound**
`<T extends A & B>`.

### 4. Call-site type arguments — inference-only (Q, 2026-07-13)

`new Box(5)` → `Box::new(5.0)` (rustc infers `Box<f64>` from the ctor arg).
**Explicit** type arguments at a call site (`new Box<string>(x)`,
`identity<number>(5)`) **fail-loud** in slice 1 — covered when the arg doesn't pin
`T` (e.g. an empty container). The dominant case (a constructor arg fixes `T`) is
inference-served.

### 5. Operators on a bare `T` — fail-loud in slice 1 (the #44 wall)

Collin's north star is **JS operator semantics**. But JS `+` / `<` / `===` dispatch
on the operands' **runtime type** (`+` is string-concat *or* numeric add depending
on the values), which a *monomorphized generic definition* fundamentally cannot know
at the definition site — and the compiler has **no TS type layer** to resolve it
either (oxc is syntax-only; the recurring "we don't know the TS type here" wall).

So slice 1 **fails loud on any operator applied to an unconstrained `T`**
(`a + b`, `a < b`, `a === b` where `a,b: T`). Computing over a generic value is done
by **calling methods** on a bounded `T` (decision 3), which *is* supported. The
`PartialEq`-derived `===` could be cheaply allowed, but slice 1 stays uniform and
honest — all bare-`T` operators fail-loud — until a **type-aware graduation**.

> **This is the concrete driver to revisit #44** (a real TS type layer). Honoring JS
> operator semantics over generics — and several other "don't know the type here"
> edges — needs type information the syntax-only front end can't provide. See the
> `#44` handoff note. Recorded here so the operator graduation is picked up *with*
> #44, not guessed in isolation.

## Mechanism (reuse map)

- **`RustType`** — add `{ kind: "param"; name: string }` (`hir.ts`); `emitType`
  renders it as the bare name (`T`).
- **Type-param scope** — collect a class/method's declared type params
  (`typeParameters`) into a per-scope `Set<string>` threaded alongside `structs`
  into `lowerType`; a `TSTypeReference` whose name is in scope → `{kind:"param"}`.
- **`lowerClass`** — emit `<T, …>` on the `struct` and `impl`; a `<T extends I>`
  param records the bound `traitNameOf(I)`; emit `struct Box<T: IShape>` /
  `impl<T: IShape> Box<T>`.
- **Generic methods** — a method's own `<U>` params extend the in-scope set for that
  method body / signature only.
- **Bounds** — derive-driven (decision 2) union the explicit interface bound
  (decision 3).
- **Call sites** — `new Box(5)` stays `Box::new(...)`; rustc infers. No turbofish
  emitted (decision 4).
- **Dispatch/070** — implicit constructors, static members, accessors already lower;
  generics ride the same `impl` block with type params prepended.

## Fail-loud residuals

- **Operators on a bare `T`** → fail-loud (decision 5); graduate with **#44**.
- **Explicit call-site type args** (`new Box<string>()`) → fail-loud (decision 4).
- **Class-as-bound** (`<T extends SomeClass>`) and **multi-bound** (`A & B`) →
  fail-loud (decision 3).
- **`where`-clauses**, **const generics**, **lifetime params** — out of scope.
- **A `Box<NonClone>`** — fails at a derive bound (accepted, decision 2).

## Impl decomposition (each spec-first)

1. **Unbounded generic class + methods** — `RustType` `param` kind, type-param scope
   threading, `struct Box<T>` / `impl<T> Box<T>`, inference-only construction, store
   / move / clone / return `T`. Operators-on-`T` fail-loud.
2. **Interface-bounded generics** — `<T extends I>` → `T: I<Name>`; a bounded `T`
   calls interface methods. Reuses 071 `traitNameOf`.
3. *(later / #44)* operator support over `T`; explicit type args; class/multi bounds.

Sequencing: (1) then (2). Slice (1)+(2) is the shippable increment (an unbounded
generic that can't compute over `T` is thin; the bounded form is where generics earn
their place — mirrors 071's slice-1+2 folding).

## Specs sketch (→ `specs.md`)

- `class Box<T> { v: T; constructor(v: T){this.v=v} get(): T { return this.v } }`,
  `new Box(5).get()` → `Box<f64>`; differential-matches.
- `Box<string>` via `new Box("hi")` (inference) — differential-matches.
- A generic **method** `first<U>(xs: U[]): U` (or on a non-generic class) —
  differential-matches.
- Multiple params `class Pair<A,B> { … }` — differential-matches.
- Bounded: `class Box<T extends Shape> { v: T; area(){return this.v.area()} }` with a
  concrete `Circle implements Shape` — `impl<T: IShape>`; differential-matches.
- Fail-loud: an **operator on a bare `T`** (`a + b`); an **explicit type arg**
  (`new Box<string>(x)`); a **class bound** (`<T extends Circle>`); a **multi-bound**.
- Regression: a non-generic class is **byte-for-byte unchanged**.

## Open sub-details (impl, not dialect forks)

- Where the in-scope type-param set lives (thread a param alongside `structs`, or a
  field on `analysis` pushed/popped per class/method scope).
- `emitType` for a nested `param` (`Vec<T>`, `Option<T>`) — the name renders inside
  the existing wrappers unchanged.
- Interaction of a generic struct with the ownership/`Rc` passes (a `param` field is
  opaque to alias-escape; treat as move/clone by the derive bound).
- Constructor inference when the ctor has multiple params fixing multiple type vars.
