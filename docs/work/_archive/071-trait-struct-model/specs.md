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

## Graduated in increment 2 (see the increment-2 section below)

- **BINT8** — object-literal-typed behavioral interface → per-literal struct
  synthesis (non-capturing), or fail-loud (capturing). Graduated by **BINT12/BINT13**.
- **BINT9** — heterogeneous behavioral-interface array → `Vec<Box<dyn I<Name>>>`.
  Graduated by **BINT14**.
- **BINT10** — `implements` of a pure-data interface → field-shape assertion
  (accept, plain struct, no trait). Graduated by **BINT15**.

## Regression (unchanged)

- **BINT11** — a pure-data interface used with an object literal
  (`interface Point { x: number; y: number }`, `const p: Point = { x: 1, y: 2 }`) is
  **byte-for-byte unchanged** (the 011/059 struct path); no trait synthesized for it
  unless it is extended.

---

# 071 — specs (increment 2: heterogeneous dispatch, pure-data `implements`, object-literal synthesis)

> Graduates the three increment-1 fail-loud residuals (BINT8/9/10). Reuses the
> shipped 053c dispatch machinery (`Vec<Box<dyn I<Name>>>`) and the 071 trait
> synthesis; the only genuinely new mechanism is per-literal struct synthesis
> (slice 3). Capturing method literals stay fail-loud (a later boxed-closure
> series). Spec IDs map to `packages/compiler/tests/behavioral-interface-traits.test.ts`.

## Heterogeneous behavioral-interface array (graduates BINT9)

- **BINT14** — a behavioral-interface array bound to `Array<Shape>` holding instances of
  *different* implementing classes (`const xs: Array<Shape> = [new Circle(2), new Square(4)]`)
  lowers to `Vec<Box<dyn IShape>>`; each element is `Box::new(...)`-upcast. A `for (const x
  of xs) console.log(x.area())` dispatches each `.area()` through the trait vtable and
  **differential-matches** JS. Reuses the 053c `isHeterogeneous` / `Box<dyn>` path verbatim,
  extended to admit a behavioral-interface element type (not just a base *class*).

## `implements` of a pure-data interface (graduates BINT10)

- **BINT15** — `class P implements PureData` where `PureData` is a **data-only**
  (methods-less) interface is a **field-shape assertion**: the class is accepted as a
  **plain `struct P`** with **no trait and no `impl`** synthesized (there is nothing to
  dispatch). TS already type-checks that `P` structurally carries `PureData`'s fields; the
  transpiler emits the class unchanged. `new P().x` **differential-matches** JS.

## Object-literal struct synthesis (graduates BINT8)

- **BINT12** — an object literal typed as a behavioral interface with a
  **non-capturing** method literal (`const s: Shape = { area: () => 5 }`) synthesizes a
  per-literal nominal struct `struct Shape__lit1` carrying the method literal as an
  **`fn`-pointer field** (`area: fn() -> f64`) plus an `impl IShape for Shape__lit1` whose
  `fn area(&self)` calls the stored pointer; construction builds `Shape__lit1 { area: || 5
  }`. `console.log(s.area())` **differential-matches** JS. The `I__litN` naming scheme
  avoids collision with a user struct.

- **BINT13** (fail-loud guard) — an object literal typed as a behavioral interface whose
  method literal **captures the environment** (`const r = 3; const s: Shape = { area: () =>
  r * 2 }`, or a `this`-capturing form) → `UnsupportedError` with a precise message
  (needs a boxed-closure field, a later series). Non-capturing is the only graduated form.
