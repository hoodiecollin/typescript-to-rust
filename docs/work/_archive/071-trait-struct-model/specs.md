# 071 — specs (increment 1: behavioral-interface trait synthesis + `implements`)

> First shippable slice of the #43 epic (`design.md`). Folds impl-decomposition
> slices **1 (behavioral-interface trait synthesis)** and **2 (`implements`
> conformance)** because slice 1 alone has no concrete satisfier → no runnable
> differential. Unblocks **#40** (`traitNameOf(I)` now exists for a behavioral
> interface, with one real conformance path).
>
> **In scope:** a standalone **behavioral** (methods-only) or **mixed** (methods +
> data fields) interface → a synthesized `trait I<Name>`; `class C implements I` →
> `impl I<Name> for C`; a **param** typed as the interface → `&impl I<Name>` with
> method/getter dispatch.
>
> **Deferred (still fail-loud, later epic slices):** heterogeneous collections →
> `Vec<Box<dyn I<Name>>>`; object-literal-typed behavioral values (slice 3) +
> capturing method literals; `implements` of a **pure-data** interface; behavioral
> interface in return / field position.

Spec IDs map to `packages/compiler/tests/behavioral-interface-traits.test.ts`.

## Trait synthesis

- **BINT1** — a standalone behavioral interface `interface Shape { area(): number }`
  synthesizes `trait IShape { fn area(&self) -> f64; }`. No `struct Shape` is emitted
  (a pure-behavioral interface has no data record).
- **BINT2** — a mixed interface `interface Named { id: number; bump(): number }`
  synthesizes `trait INamed` carrying a **by-value getter** `fn id(&self) -> f64`
  (059 reuse) **and** a method `fn bump(&self) -> f64`. (Numeric to keep the
  differential off the orthogonal String-concat-of-a-field emitter gap.)

## `implements` conformance

- **BINT3** — `class Circle implements Shape { area(){…} }` emits `impl IShape for Circle`
  whose method **forwards to the inherent method** (`fn area(&self) -> f64 { self.area() }`
  — inherent resolution wins, no recursion). The program compiles.
- **BINT4** — a mixed `class Person implements Named` emits `impl INamed for Person` with
  the data-field **getter** (`fn name(&self) -> String { self.name.clone() }`) and the
  method **forwarder** (`fn greet(&self) -> String { self.greet() }`).

## Param dispatch (differential)

- **BINT5** — `function f(s: Shape): number { return s.area(); }` lowers to
  `fn f(s: &impl IShape) -> f64`; `f(new Circle(2))` → `s.area()` dispatches through the
  trait. `console.log(f(new Circle(2)))` differential-matches JS.
- **BINT6** — mixed dispatch: `function g(x: Named): number { return x.bump() + x.id; }`
  routes `x.bump()` (method) and `x.id` (field → getter). Differential-matches.
- **BINT7** — two distinct classes implementing one interface, each passed monomorphically
  to `f`, each get their own `impl`; both calls differential-match.

## Fail-loud residuals (documented, this increment)

- **BINT8** — an **object literal** typed as a behavioral interface
  (`const s: Shape = { area: () => 5 }`) → `UnsupportedError` (slice 3).
- **BINT9** — a **heterogeneous** behavioral-interface array
  (`const xs: Shape[] = [new Circle(1), new Square(2)]`) → `UnsupportedError`
  (the `Vec<Box<dyn>>` path is a later slice).
- **BINT10** — `class C implements PureData` where `PureData` is a **data-only** interface
  → `UnsupportedError` (no trait to bind; a later resolution).

## Regression (unchanged)

- **BINT11** — a pure-data interface used with an object literal
  (`interface Point { x: number; y: number }`, `const p: Point = { x: 1, y: 2 }`) is
  **byte-for-byte unchanged** (the 011/059 struct path); no trait synthesized for it
  unless it is extended.
