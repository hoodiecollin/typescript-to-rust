# 053 — Class inheritance (`extends`) — composition + trait hybrid

Graduates the last and largest `needs-user-input` deferral: `class B extends A` is
today rejected wholesale in `lowerClass` (`class inheritance (extends/implements)`,
`lower.ts:874`). Per the DECISION in `docs/work/_pending-decisions.md` §#4
(2026-07-07), inheritance maps onto Rust along **two independent axes** — data reuse
by **composition**, method reuse + polymorphism by a **shared trait**. The `dyn`
heap/dispatch cost Option A avoids appears *only* where the source is genuinely
polymorphic; everything else stays owned, monomorphic, zero-cost. This is a rippling
change (new `HirTrait` item, a trait-vs-struct split in lowering, `dyn` in the
ownership pass), so it is staged into three differential-green slices and sequenced
**last** of the nine decided series.

## The two-axis mapping

`class B extends A` is not one Rust construct — it is decomposed by *what is being
reused*:

| TS inheritance concern | Rust target | Axis |
|---|---|---|
| inherited **fields** / `super(args)` / `super.m()` | `struct B { base: A, … }`; `base: A::new(args)`; `self.base.m()` | **composition** |
| inherited-field **read** `b.x` (x on A) | `b.base.x` (cross-class field rewrite) | **composition** |
| **method** reuse + override | `trait IA { fn m(&self){…default…} }`, `impl IA for A`, `impl IA for B` (B overrides) | **trait** |
| base-typed binding/param/collection (mono) | `impl IA` — static dispatch, zero-cost | **trait** |
| base-typed binding/param/collection (hetero) | `&dyn IA` / `Box<dyn IA>` — vtable, heap | **trait** |
| inherited-field read **through** a `dyn IA` | trait accessor `a.x()` (traits hold no data) | **trait** |

The composition axis is a mechanical desugar that stays fully inside the owned
Option-A model (011/012). The trait axis is new machinery; it is the only place a
`dyn`/`Box` appears, and only when a value is used polymorphically.

## Composition — data, `super`, inherited fields (053a)

`class B extends A` gains a synthetic first field `base: A`. Nothing about `A`'s own
`struct`/`impl` changes; `B` *embeds* it.

- **Struct.** `struct B { base: A, …B's own fields }`. The `base` field is prepended
  so `super(...)` (which must run first, like Rust field-init order) reads cleanly.
- **`super(args)`** in `B`'s constructor → `base: A::new(args)` in `B::new`'s returned
  struct literal. `B::new` still obeys struct-literal totality (`lowerConstructor`):
  it must initialize `base` (via exactly one `super(...)`) plus every own field.
- **`super.m(args)`** in a `B` method → `self.base.m(args)` (call `A`'s method on the
  embedded base).
- **Inherited-field read `b.x`** where `x` is declared on `A` (not on `B`) →
  `b.base.x`. This is a new **cross-class field-access rewrite**: at a `field` lowering
  site the analysis resolves whether the accessed name is own or inherited and, if
  inherited, injects the `.base` hop. Multi-level chains hop repeatedly
  (`C extends B extends A` → `c.base.base.x`).
- **Inherited-method call `b.m()`** (not overridden by `B`) resolves through the trait
  (053b); within pure-composition 053a it may also forward via `self.base.m()` when
  called internally.

Fail-loud in 053a: a subclass constructor with **no** `super(...)` (leaves `base`
uninitialized — struct-literal totality), and `super` used outside a subclass.

## Trait — method reuse, override, polymorphism (053b/053c)

For a base class `A` that is extended, synthesize a **shared trait** `IA` carrying
`A`'s public method signatures with `A`'s bodies as **default methods**:

```rust
trait IAnimal {
    fn speak(&self) -> String { /* Animal's body */ }
}
impl IAnimal for Animal {}          // inherits every default
impl IAnimal for Dog { fn speak(&self) -> String { /* Dog's override */ } }
```

- **`impl IA for A`** is (usually) empty — `A` uses every default. **`impl IA for B`**
  overrides exactly the methods `B` redefines; un-redefined methods fall through to
  the default, which — because `B` embeds `A` as `base` and the default body was
  written against `A`'s shape — must be dispatched **on the base**. Two sub-options
  for a non-overridden method on `B`: (i) forwarder `fn m(&self){ self.base.m() }` in
  `impl IA for B`, or (ii) rely on the default body operating on `&self` where field
  reads are accessor-mediated. **053b uses forwarders** (simplest, no accessor
  dependency); accessors (053c) are added only for `dyn` field reads.
- **`super.m()` calling a trait _default_ body.** A default `fn m` cannot be named as
  `A::m` (it lives on the trait). Emit the default under a synthetic free name and
  have both the trait default and any `super.m()` call it: rename the base body to
  `default_m(&self)` (an inherent `impl A` method or a free `fn`), let the trait
  default be `fn m(&self){ self.default_m() }`, and lower `super.m()` in `B` to
  `self.base.default_m()`. This is the **synthetic-helper** detail flagged in the
  DECISION.

### `impl IA` vs `dyn IA` — polymorphic positions

A base-typed use site is classified during lowering:

- **Monomorphic** (a param/binding used with a single concrete subtype, or annotated
  `A` but flow-resolvable) → **`impl IA`** (generic, static dispatch, zero-cost, no
  heap). Preferred — keeps Option A intact.
- **Heterogeneous** (a collection or binding holding *different* subtypes:
  `A[] = [new Dog(), new Cat()]`, or a param stored into such) → **`Box<dyn IA>`** /
  **`&dyn IA`**. This is the *only* place the heap/vtable cost appears. The ownership
  pass must learn `dyn IA`: a `Box<dyn IA>` element is owned/moved like any boxed
  value; a `&dyn IA` param is a borrow.

### Trait accessors for `dyn` field access (053c)

A trait holds no data, so a field read **through** a `dyn IA` (`a.x` where `a: &dyn
IA`) cannot become `a.base.x`. For each **shared** (base-declared) field that is read
in a polymorphic position, synthesize a trait **accessor**:

```rust
trait IAnimal { fn name(&self) -> &String; /* … */ }
impl IAnimal for Animal { fn name(&self) -> &String { &self.name } }
impl IAnimal for Dog    { fn name(&self) -> &String { &self.base.name } }
```

and rewrite the polymorphic read `a.x` → `a.x()`. Accessors are **gated on demand**
(like every derive in `derives.ts`): emitted only for fields actually read through a
`dyn`; a pure reuse+override program emits none. A **subclass-only** field read
through a `dyn IA` has no accessor and stays fail-loud (that is a downcast — deferred
to #17).

## Derive / cloneability over the base field (`derives.ts`)

`buildStructTable` already registers a class's fields (`derives.ts:36`); the
synthetic `base: A` field is an ordinary `struct`-typed field, so
`isStructCloneable` / `isTypeDebug` recurse into `A` transitively with **no change** —
`B` derives `Clone`/`Debug` iff `A` and all of `B`'s own fields are eligible (the
existing cycle guard covers the embed). The trait itself carries no derives. One
check to add: the `base` field must be registered **before** the derive walk so `B`'s
cloneability sees it (ordering in `lowerClass`).

## Analysis needs (`analysis.ts`)

`ModuleAnalysis` gains inheritance facts, built in `analyzeModule`:

- **`superclass: Map<string, string>`** — subclass → its direct base (from
  `decl.superClass`). Drives the `base`-field synthesis and multi-level `.base` hops.
- **`inheritedFields: Map<string, Set<string>>`** — per class, the field names owned
  by ancestors (transitive), so a `field` read can be classified own-vs-inherited for
  the `.base` rewrite.
- **`overrides: Map<string, Set<string>>`** — per subclass, the method names it
  redefines (vs. inherits as a trait default). Drives which methods appear in
  `impl IA for B` and which fall through to the default.
- **`baseClasses: Set<string>`** — classes that are extended (need a `trait IA`
  emitted). A leaf/never-extended class needs no trait.
- **`dynFieldReads`** — shared fields read through a `dyn` position (gates accessor
  synthesis).

`mutatingMethods` (receiver-mutability) already spans the module by method name; a
`super.m()` / trait default keeps that name-based edge (documented collision limit,
inherited from 012).

## HIR / emitter surface

- **New `HirTrait` item** (`hir.ts`): `{ kind: "trait"; name; methods: HirFn[] (with
  default bodies); accessors: {field; ty}[] }`. `HirItem` broadens to include it.
- **`HirClass`** gains `base?: { field: "base"; ty: RustType }` (the embed) and
  `implTrait?: string` + `overrides: Set<string>` (which trait methods this class
  provides vs. inherits).
- **New `RustType` `{ kind: "dyn"; trait: string }`** → `dyn IA`, composing under
  `ref` (`&dyn IA`) and a new boxed form (`Box<dyn IA>`); plus `{ kind: "implTrait";
  trait }` → `impl IA`.
- **Emitter** (`emitter.ts`): `emitItem` gains a `trait` case (`emitTrait` → `trait
  IA { <default fns>; <accessor sigs> }`); `emitClass` emits the `base` field in the
  struct and the per-class `impl IA for Name { <overrides>; <accessors> }` block after
  the inherent `impl`; `emitType` renders `dyn`/`impl IA`/`Box<dyn …>`; `emitFn`
  already prepends `&self`/`&mut self`.

## Slices (each lands differential-green)

1. **053a — composition data-reuse + `super`.** `base: A` embed; `super(args)` →
   `base: A::new(args)`; `super.m()` → `self.base.m()`; inherited-field read `b.x` →
   `b.base.x` (own-vs-inherited classification + multi-level hops); `superclass` /
   `inheritedFields` analysis; derive composition over `base`. No trait yet — a
   subclass reuses base *data* and calls base methods internally. Fail-loud: missing
   `super`.
2. **053b — shared trait + method override.** Synthesize `trait IA` with default
   bodies; `impl IA for A` / `impl IA for B` (overrides + forwarders); the
   `default_m` synthetic helper for `super.m()` into a default; monomorphic base-typed
   param → `impl IA`. `overrides` / `baseClasses` analysis; new `HirTrait`.
3. **053c — polymorphism via `dyn IA` + accessors.** Heterogeneous position →
   `Box<dyn IA>` / `&dyn IA`; `dyn` in the ownership pass; on-demand trait accessors
   for shared-field reads through a `dyn`; the `dyn`/`Box<dyn>`/`impl IA` `RustType`s.
   Pairs with #17 (downcast) for subclass-field access.

## Fail-loud residuals (documented, not silently handled)

- **`implements` / multiple inheritance** — single-`extends` composition only; a
  `class C implements I` or multiple bases stays `UnsupportedError`.
- **Downcast** (`a instanceof Dog` / `a as Dog` on a `dyn IA`, subclass-only field
  through `dyn`) — deferred to **#17**; the trait gives no access to subclass data.
- **`abstract` classes / abstract methods** — already Forbidden (unchanged); a trait
  method with *no* default (pure virtual) is out until abstract lands.
- **`protected`/`private` visibility, `super` in a field initializer, calling an
  overridden method via `A.prototype.m`** — each its own concern.
- **Overriding a field's _type_ (covariant field override), generic base classes** —
  out; the base embed is a single concrete `A`.
- **Mutating a base field through a `&dyn IA`** — accessors are read-only (`&self ->
  &T`); a `&mut` accessor / `&mut dyn IA` is a follow-up.

## Verification

- **Unit (cargo-free):** the three `tests/inherit-*.test.ts` drive `emit(…)` for the
  emit-shape specs (the `base` embed, the `trait IA` + `impl` blocks, the accessor
  presence/absence gating).
- **Oracle (cargo-backed):** each slice adds a tier-2 differential fixture under
  `06_classes/**` — a subclass reusing base data + overriding a method, and a
  `Vec<Box<dyn IA>>` dispatching heterogeneously — asserting Rust stdout equals the
  TypeScript's.

## Workflow note

Full spec-first: docs → scaffold (`HirTrait` item, `dyn`/`implTrait` `RustType`s, the
`base` embed, emitter cases; `lowerClass` keeps the `superClass` seam throwing
`UnsupportedError` "class inheritance lowering pending" so specs are RED) → **RED** →
real composition rewrite (053a), trait synthesis (053b), `dyn` + accessors (053c) to
GREEN → archive. `implements`, downcast (#17), abstract, and visibility each get a
**new** series. Mirror the relaxations in `validate.ts` + `dialect.md` (flip the
`class inheritance (extends/implements)` row).
</content>
