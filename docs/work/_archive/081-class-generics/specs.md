# 081 — specs (slices 1 + 2: class generics — unbounded + interface-bounded)

> The shippable increment of issue **#40** (`design.md`). Folds impl-decomposition
> slices **1 (unbounded generic class + methods)** and **2 (interface-bounded
> generics)** — an unbounded generic that can't compute over `T` is thin; the
> bounded form (a `T` calling interface methods) is where generics earn their
> place, mirroring 071's slice-1+2 folding.
>
> **In scope:** `class Box<T>` → `struct Box<T>` / `impl<T> Box<T>` (monomorphized,
> derive-driven bounds, inference-only construction); store/move/clone/return `T`;
> multiple params `Pair<A, B>`; a generic **method** `<U>`; `<T extends I>` (a
> single **behavioral** interface) → `struct Box<T: I<Name>>` / `impl<T: I<Name>>`
> with the bounded `T` calling interface methods (reuses 071 `traitNameOf`).
>
> **Fail-loud residuals (slice 3 / #44):** an operator on a bare `T` (`a + b`,
> `a < b`, `a === b`); an explicit call-site type arg (`new Box<string>(x)`,
> `identity<number>(5)`); a **class** as a bound (`<T extends SomeClass>`); a
> **multi-bound** (`<T extends A & B>`); `where`-clauses / const generics / lifetime
> params (out of scope).

Spec IDs map to `packages/compiler/tests/class-generics.test.ts`.

## Unbounded generic class + methods (differential)

- **CG1** — `class Box<T> { v: T; constructor(v: T){this.v=v} get(): T { return this.v } }`
  emits `struct Box<T>` and `impl<T> Box<T>`. `new Box(5).get()` infers `Box<f64>`
  (`Box::new(5.0)`, no turbofish); `console.log(new Box(5).get())` differential-matches.
- **CG2** — the same `Box<T>` over a `string`: `new Box("hi").get()` infers
  `Box<String>`; differential-matches (one generic definition, two instantiations).
- **CG3** — store / move / clone / return `T`: a method that returns `this.v`
  (a stored `T`) and a two-instantiation program compiles and differential-matches
  (the `param` field is opaque to ownership/Rc — move/clone by the derive bound).
- **CG4** — a **generic method** on a non-generic class:
  `class C { first<U>(xs: U[]): U { return xs[0]; } }` emits `fn first<U>(&self, xs: Vec<U>) -> U`.
  `new C().first([3, 4])` differential-matches (`Vec<U>` renders the `U` unchanged
  inside the wrapper).
- **CG5** — **multiple params** `class Pair<A, B> { a: A; b: B; constructor(a: A, b: B){…}
  fst(): A { return this.a } snd(): B { return this.b } }` emits `struct Pair<A, B>` /
  `impl<A, B> Pair<A, B>`. `new Pair(1, "x")` (→ `Pair<f64, String>`) differential-matches.

## Interface-bounded generics (differential)

- **CG6** — `class Boxed<T extends Shape> { v: T; constructor(v: T){this.v=v}
  area(): number { return this.v.area(); } }` with `interface Shape { area(): number }`
  and a concrete `class Circle implements Shape` emits `struct Boxed<T: IShape>` /
  `impl<T: IShape> Boxed<T>`; the bounded `T` calls `this.v.area()`.
  `new Boxed(new Circle(2)).area()` differential-matches JS.
- **CG7** — the bound is monomorphized per satisfier: two distinct
  `implements Shape` classes each instantiate `Boxed<T>`; both `area()` calls
  differential-match.

## Fail-loud residuals (guards)

- **CG8** — *(retargeted by series 088 / #62)* an operator over a **same-`T`** pair
  now lowers to the tslib JS-operator trait layer (`a + b` where `a,b: T`); the
  spec retargets to the still-loud **mixed-operand** case (a `T` and a non-`T`
  operand, e.g. `this.v + 1`), which stays `UnsupportedError` (the JS coercion the
  definition site can't resolve). See `docs/work/_archive/088-generic-operators/`.
- **CG9** — an **explicit call-site type arg** `new Box<string>("hi")` throws
  `UnsupportedError` (inference-only construction; explicit args unsupported).
- **CG10** — an **explicit type arg on a generic fn call** `identity<number>(5)`
  (with `function identity<A>(x: A): A { return x; }`) throws `UnsupportedError`.
- **CG11** — a **class as a bound** `class Box<T extends Circle> { … }` throws
  `UnsupportedError` (a class isn't a trait bound yet).
- **CG12** — a **multi-bound** `class Box<T extends A & B> { … }` throws
  `UnsupportedError`.

## Regression (unchanged)

- **CG13** — a **non-generic class** is byte-for-byte unchanged: emitting a plain
  `class Point { x: number; y: number; … }` produces exactly the same Rust as before
  081 (no `<>` on the struct/impl, no `param` leakage).
</content>
