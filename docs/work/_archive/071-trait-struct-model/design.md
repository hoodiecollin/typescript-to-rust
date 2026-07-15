# 071 — Interface/class → trait + struct model (usage-directed dual lowering)

> **Status: DESIGN COMPLETE (2026-07-10). Impl pending.** This is the epic **#43**
> design. Dialect calls made with Collin 2026-07-10 (`needs-user-input` cleared).
> **Unblocks #40** (class generics — the `<T extends X>` constraint hook). Foundational
> dialect-shape redesign: touches the validator, `lowerInterface`, `synthesizeTraits`,
> dispatch, and 053 inheritance.
>
> Spec-first: this `design.md` → mock → RED `specs.md` → impl → archive. As an epic it
> decomposes into impl sub-series (see **Impl decomposition**); each ships spec-first.

## The reframing — the trait model already ships, for inheritance only

The epic's original premise ("the contract role is unbuilt") is **half** true. The
compiler is **not** trait-free today — it already emits `trait`, `impl Trait for T`,
`impl Trait`, `dyn Trait`, and `Box<dyn Trait>`, but **only along the inheritance axis**:

- **`synthesizeTraits`** (`lower.ts:2666`) — every extended base *class* gets a
  `trait IA`; base methods become trait defaults, subclasses `impl IA for B` with
  forwarders for non-overridden methods.
- **`synthesizeInterfaceTraits`** (`lower.ts:2747`, series 059) — an extended base
  *interface* already becomes `trait IA` whose **data fields turn into by-value getters**
  (`byValueAccessors`); every derived struct gets `impl IA`.
- **Dispatch default is already decided and shipped** (series 053c): monomorphic use of
  a base type → `impl IA` (static, zero-cost); a heterogeneous collection →
  `Vec<Box<dyn IA>>` (vtable), gated by `isHeterogeneous` (`lower.ts:2821`).
- `RustType` already carries `{kind:"dyn",trait}` and `{kind:"implTrait",trait}`
  (`hir.ts`); `emitTrait` (`emitter.ts:317`) already prints trait items.

So three of the six original wrinkles have **shipped, precedented answers** — this epic
**reuses** them rather than designing them:

| Original wrinkle | Resolution |
| --- | --- |
| **2. Mixed interfaces → getters** | Reuse 059 `byValueAccessors` (field → by-value getter). |
| **4. Dispatch default** | Reuse 053c heuristic: mono → `impl ITrait`; heterogeneous/stored → `Box<dyn ITrait>`. |
| **5. 053 inheritance interplay** | Reuse the extends-chain forwarder / `rootBaseOf` `impl` propagation. |

## What is genuinely NOT built (the real #43)

Two hard fail-loud walls plus the constraint hook:

1. **Standalone interface with methods** → fail-loud at `lower.ts:2210` (`lowerInterface`
   accepts only `TSPropertySignature`). `interface Shape { area(): number }` outside an
   `extends` chain has no trait.
2. **`implements`** → fail-loud at `lower.ts:2292` (INH16). No way to declare that a class
   satisfies a contract.
3. **`<T extends Shape>`** → no type params exist at all (#40 territory); #43 only has to
   **provide the trait to bind by**.

## Decisions (2026-07-10, with Collin)

### 1. Classification — declaration-shape directed (Q1: *struct always + trait when needed*)

- **Pure-data interface** (only property signatures) → **`struct <Name>`**, unchanged. A
  trait is synthesized **only when needed** — i.e. it is used as an inheritance base or a
  generic bound (existing 059 path). No behavior change for the dominant data-record use.
- **Behavioral or mixed interface** (declares ≥1 `TSMethodSignature`) → **`trait <Name>Trait`**.
  Method signatures become trait methods; data fields (mixed case) become **by-value
  getters** (reuse 059 `byValueAccessors`). **This graduates the `lower.ts:2210` fail-loud.**

There is **no** canonical fieldless `struct Shape` for a pure-behavioral interface — a
marker struct can't carry a method closure. The "struct always" property (Q1) is honored
by requiring every **value** of interface type to be backed by a concrete struct (a class,
or a synthesized per-literal struct — see conformance), while the interface **name**
becomes the trait.

### 2. Conformance — nominal, three carriers (Q2 + Q3)

A concrete type conforms to `trait ITrait` **nominally** (Rust attaches `impl ITrait for T`
to a named type). Three carriers, all producing `impl ITrait for <ConcreteStruct>`:

- **`class C implements I`** → `impl ITrait for C`. **Graduates the INH16 fail-loud**
  (`lower.ts:2292`) — Q3. This is the explicit conformance syntax.
- **Class whose declared/inferred type is `I`** (existing 053-style base inference) → same
  `impl ITrait for C`.
- **Object literal typed `I` with methods** → **synthesize a per-literal nominal struct**
  (data fields + method closures) + `impl ITrait` — Q2 (*also synthesize structs for
  object literals*). `const s: Shape = { area: () => 5 }` →
  `struct Shape__lit1 { /* non-capturing method → fn ptr */ } ; impl ShapeTrait for Shape__lit1`.

### 3. Representation of a value typed as a behavioral interface

Reuse the shipped 053c dispatch heuristic verbatim — **no new dispatch policy**:

- **Monomorphic** use (param/local sees one concrete satisfier) → **`impl ITrait`** (static,
  zero-cost, monomorphized).
- **Heterogeneous** / stored-in-collection / boxed → **`Box<dyn ITrait>`** (vtable), via the
  existing `isHeterogeneous` analysis.

### 4. Generic-constraint hook (the #40 unblock)

`<T extends I>` → `T: ITrait`. **Type parameters do not exist yet** (#40), so #43 does
**not** implement the binding — it only guarantees `traitNameOf(I)` exists for every
interface/class usable as a bound. #40 is the consumer; #43 is its prerequisite.

### 5. 053 inheritance interplay

`impl ITrait` propagates down `extends` chains via the existing forwarder / `rootBaseOf`
machinery. A `class B extends A implements Shape` gets `impl ShapeTrait for B` (delegating
through `self.base` where a method is inherited from `A`).

### 6. `instanceof` / discrimination — DEFERRED (Q4)

Out of scope. #43 builds the trait **substrate**; runtime type discrimination (downcast via
`Any`, or an enum tag) is a **separate issue** with its own forks. Noted as a consumer.

## Explicitly rejected

- **"Interfaces are never constructable → `Box<dyn>` only."** Would break the dominant use
  (interfaces as data records). Data interfaces stay structs; behavioral values are always
  backed by a concrete struct.
- **A canonical fieldless `struct Shape` for pure-behavioral interfaces** — useless marker;
  the trait name is the contract, per-satisfier structs are the carriers.

## Fail-loud residuals

- **Capturing method closures in a synthesized interface-struct** — `{ area: () => this.r*2 }`
  captures environment → needs `Box<dyn Fn()->..>` field. First slice: **non-capturing
  method literals → `fn`-pointer field** (series 048 precedent); **capturing → fail-loud**
  until a later series graduates boxed-closure fields.
- **Anonymous structural satisfaction without an interface annotation** — a bare object
  returned where a behavioral interface is inferred but never annotated. Requires the
  annotation to drive synthesis; unannotated → fail-loud.
- **`instanceof` / downcasting** — deferred (own issue).
- **`implements` of a *pure-data* interface** — no methods to dispatch; treat as a shape
  assertion (the class must structurally carry the fields) or fail-loud — resolved at impl.

## Mechanism (reuse map)

- **`lowerInterface`** (`lower.ts:2191`) — branch on member kind: any `TSMethodSignature`
  present → classify behavioral/mixed → route to trait synthesis (currently `throw` at
  `:2210`). Data-only stays the `HirStruct` path.
- **Trait synthesis** — generalize `synthesizeInterfaceTraits` (`lower.ts:2747`) to cover
  **method signatures** (not just field getters) and **standalone** interfaces (not just
  `baseInterfaces`). Emit `HirTrait { methods, byValueAccessors }`.
- **`implements`** — remove the INH16 `throw` (`lower.ts:2292`); for each `implements I`,
  register `impl ITrait for C` through the same `implTraits` channel 059 uses.
- **Object-literal struct synthesis** — new: at a `lowerTyped` site (`lower.ts:4284`) where
  the target is a behavioral interface, synthesize a per-literal `HirStruct` (data fields +
  fn-ptr method fields) + `impl ITrait`, and construct it instead of a `structLit` on a
  named struct.
- **Dispatch** — reuse `isHeterogeneous` / `impl Trait` / `Box<dyn>` (053c) unchanged.
- **Constraint hook** — expose `traitNameOf` for #40; no impl here.

## Impl decomposition (epic → sub-series, each spec-first)

1. **Behavioral-interface trait synthesis** — graduate `lower.ts:2210`; standalone
   method/mixed interface → `trait ITrait` (+ 059 getters for data fields). Value repr via
   existing dispatch. *(The load-bearing slice; unblocks #40 by itself.)*
2. **`implements` conformance** — graduate INH16; `class C implements I` → `impl ITrait for C`,
   with extends-chain propagation.
3. **Object-literal struct synthesis** — per-literal struct + `impl ITrait`; non-capturing
   method literals → fn-ptr fields; capturing → fail-loud.

Sequencing: (1) first (it is what #40 waits on), then (2), then (3). #40's `design.md` is
written after (1) lands.

> **Status — increment 1 SHIPPED (2026-07-11):** slices (1)+(2) landed together (slice 1
> alone has no concrete satisfier → no runnable differential). Behavioral/mixed interface →
> `trait I<Name>`; `class C implements I` → `impl I<Name> for C` (059 getters + method
> forwarders); a param typed as the interface → `&impl I<Name>` with trait dispatch. Specs:
> `specs.md` BINT1–BINT11 → `tests/behavioral-interface-traits.test.ts` (11 green, full
> suite 684 pass / 0 fail). **#40 is now unblocked.** Remaining epic work: heterogeneous
> collections → `Vec<Box<dyn I<Name>>>`; slice (3) object-literal struct synthesis +
> capturing; `implements` of a pure-data interface. Incidental finding filed separately: a
> pre-existing `String + String` concat gap for field/method-result operands.

## Specs sketch

- `interface Shape { area(): number }` + `function f(s: Shape) { return s.area() }` with one
  concrete class → `trait ShapeTrait`; `f(s: impl ShapeTrait)`; differential-matches.
- `interface Named { name: string; greet(): string }` (mixed) → `trait NamedTrait` with a
  `fn name(&self)->String` getter + `fn greet(&self)->String`.
- `class Circle implements Shape { area(){return 3.14} }` → `struct Circle` +
  `impl ShapeTrait for Circle`.
- `const shapes: Shape[] = [new Circle(), new Square()]` (heterogeneous) →
  `Vec<Box<dyn ShapeTrait>>` (existing 053c path); differential-matches.
- `const s: Shape = { area: () => 5 }` → synthesized `struct Shape__lit1` + `impl ShapeTrait`;
  differential-matches.
- `const s: Shape = { area: () => this.r * 2 }` (capturing) → **fail-loud** (documented).
- A pure-data interface `Point {x,y}` is **byte-for-byte unchanged** (regression guard).

## Open sub-details (impl, not dialect forks)

- Naming scheme for synthesized per-literal structs (`I__litN` collision-avoidance).
- Whether classification lives in `analysis.ts` (a `behavioralInterfaces` set) or inline in
  `lowerInterface`.
- `implements` of a pure-data interface: field-shape assertion vs fail-loud.
- Monomorphization boundary shared with #40 (where `impl ITrait` becomes a real `<T: ITrait>`).
