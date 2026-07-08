# 053 — specs

Spec-ID prefix `INH`. Differential specs (tier 2: TS-run-via-Bun stdout must equal
Rust-run stdout) unless marked emit-shape (tier 1) or fail-loud.

## 053a — composition data-reuse + `super` (`packages/compiler/tests/inherit-compose.test.ts`)

- **INH1** (emit-shape) `class Animal { name: string; … } class Dog extends Animal
  { breed: string; … }` emits `struct Dog { base: Animal, breed: String }` (the
  base embed) and `impl Dog`.
- **INH2** `super(name)` in `Dog`'s constructor emits `base: Animal::new(name)` in
  the returned struct literal; constructing a `Dog` and printing `dog.name` (an
  inherited field) prints the value passed to `super` — differential.
- **INH3** an inherited-field read `dog.name` lowers to `dog.base.name`; an own-field
  read `dog.breed` stays `dog.breed`. Differential: print both.
- **INH4** `super.describe()` in a `Dog` method lowers to `self.base.describe()` and
  reuses `Animal`'s method — differential on the returned string.
- **INH5** a two-level chain `class Puppy extends Dog extends Animal`: reading the
  top-base field on a `Puppy` hops twice (`p.base.base.name`) — differential.
- **INH6** (fail-loud) a subclass constructor with **no** `super(...)` call →
  `UnsupportedError` (the `base` field would be uninitialized — struct-literal
  totality).

## 053b — shared trait + method override (`packages/compiler/tests/inherit-trait.test.ts`)

- **INH7** (emit-shape) a base class extended by a subclass emits `trait IAnimal`
  with `Animal`'s method as a **default body**, plus `impl IAnimal for Animal` and
  `impl IAnimal for Dog`.
- **INH8** **the reuse + override differential**: `Animal.speak()` returns a generic
  sound; `Dog` **overrides** `speak()`. Construct one `Animal` and one `Dog`, call
  `speak()` on each, print both — the `Animal` uses the trait default, the `Dog` uses
  its override; stdout matches TS (proves override shadows default, reuse keeps
  default).
- **INH9** a `Dog` that does **not** override a second method `describe()` reuses the
  trait default (via the forwarder), which resolves `Dog`'s `base` fields correctly —
  differential.
- **INH10** a **monomorphic** base-typed param `fn greet(a: impl IAnimal)` accepts a
  `Dog`, dispatches statically to `Dog::speak` — differential (emit contains
  `impl IAnimal`, no `dyn`).
- **INH11** `super.speak()` inside `Dog`'s override calls `Animal`'s (default) body
  via the synthetic `default_speak` helper and composes with `Dog`'s own text —
  differential (guards the `super`-calls-a-default detail).

## 053c — polymorphism via `dyn IA` + accessors (`packages/compiler/tests/inherit-dyn.test.ts`)

- **INH12** **the heterogeneous-dispatch differential**: a mixed array
  `[new Dog(...), new Cat(...)]` lowers to `Vec<Box<dyn IAnimal>>`; iterating and
  calling `speak()` on each dispatches per-element (vtable) — stdout (Dog-sound then
  Cat-sound) matches TS.
- **INH13** a shared/inherited field read **through** a `&dyn IAnimal` uses the trait
  accessor `a.name()` (not `.base.name`); emit contains `fn name(&self) -> &String`
  in `trait IAnimal` and per-class `impl` accessors — differential on the printed
  name.
- **INH14** accessors are **gated**: a pure reuse-and-override program (no `dyn`
  position) emits **no** accessor methods (emit-shape — assert the accessor is
  absent).
- **INH15** (fail-loud) accessing a **subclass-only** field through a `dyn IAnimal`
  (e.g. `(a as Dog).breed` on a `&dyn IAnimal` element) → `UnsupportedError`
  (downcast, deferred to #17).
- **INH16** (fail-loud) `class C implements I` / multiple inheritance stays
  `UnsupportedError` (single-`extends` composition only).
</content>
