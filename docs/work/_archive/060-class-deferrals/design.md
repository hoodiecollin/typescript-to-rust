# 060 — Class deferrals (method-param borrows, statics, accessors, accessibility)

> **Status: SHIPPED (2026-07-09).** Graduates the fail-loud deferral in issue #23.
> Dialect-shape decisions made with Collin 2026-07-09. Reuses the free-fn ownership
> inference over method bodies (`analysis.methodParams`). Specs: `specs.md` →
> `packages/compiler/tests/class-deferrals.test.ts`.
>
> **Impl notes / deviations:**
> - Method-param borrows reuse the free-fn analysis (`classifyParam`), so a param
>   mutated **only via a field write** (`p.x = …`) infers `&T` — cargo-loud, never
>   silent, matching the identical free-fn limitation. Mutating-method use
>   (`xs.push(...)`) correctly infers `&mut`.
> - Call-site borrow adaptation reuses the 061 `ref` HIR node (`&arg`/`&mut arg`).
> - Accessibility: `public`/`private` accepted but *not* emitted as `pub` — the
>   generated single-file binary has no cross-module visibility, so it is a semantic
>   no-op; `protected` is fail-loud.
> - Implicit / non-field-init constructors remain fail-loud (issue-context item, not
>   one of this series' three forks).

## Scope

Classes already lower to `struct` + `impl` with name-based receiver mutability
(`&self`/`&mut self`) and 053 inheritance. **Decorators stay permanently rejected.**
This series graduates:

1. **Method-parameter borrow inference** (Fork 1).
2. **Static members**, **getters/setters**, **accessibility** (Fork 3).

And explicitly **defers**: generics (Fork 2), owned-`self` methods, the cross-class
same-name receiver-mutability edge (unchanged).

## Decisions

- **Fork 1 — extend param-borrow inference to methods; owned-`self` deferred.**
- **Fork 2 — generics deferred to its own series.**
- **Fork 3 — graduate statics + getters/setters + public/private accessibility;
  `protected` rejected fail-loud.**

## Fork 1 — method-parameter borrow inference

### Why this matters (and why owned-`self` is safely deferred)

Free-function params already infer `&T`/`&mut T`/owned (`info?.ownership`,
`lower.ts:2397`); **method params default to `move`** only because the analysis is
not run for method bodies. Extending it is pure reuse.

**Owned-`self`** is *not* TS-expressible — it is the ownership consequence of a
method that **moves a non-Copy field out of `this`** (`unwrap() { return this.value }`,
a builder `build()`, `intoVec()`). Rust would offer either `fn m(self)` (consume) or
`fn m(&self) { … .clone() }` (keep borrow, clone the field). The **038 move-out-of-place
pass already inserts the `.clone()`**, so these methods *compile today*. Owned-`self`
is therefore only a clone-avoidance optimization — deferring it costs a clone, not
correctness. The sole residual is a **non-cloneable** moved-out field (clone path
fails → cargo-loud); rare, stays fail-loud until the owned-`self` follow-on.

### Mechanism

- Run the existing ownership analysis (`analysis.ts`) over **method bodies**, so each
  method param resolves to `ref`/`refMut`/`move` via the same `info.ownership` path
  free fns use (`lower.ts:2397`).
- **Call sites adapt** through the borrow-adaptation the free-fn path already emits
  (a method arg that is now `&T` gets `&`, etc.).
- `self` receiver mutability is unchanged (already name-based). Owned-`self`
  detection is **not** added here → a method that genuinely needs to consume `self`
  keeps the 038 clone (or is cargo-loud if non-cloneable).

## Fork 2 — generics: deferred

`class Box<T>` / generic methods stay `UnsupportedError`. Generics (type params,
trait bounds, where-clauses, monomorphization interplay with the ownership/derive
passes) is a large orthogonal feature and gets its **own** series rather than
ballooning this one.

## Fork 3 — mechanical members

### Static members

`static` field → associated `const`; `static` method → associated `fn` (no `self`):
```ts
class P { static origin() { return new P(0, 0); } static ZERO = 0; }
```
```rust
impl P { fn origin() -> P { P { x: 0.0, y: 0.0 } } const ZERO: f64 = 0.0; }
// call site: P::origin(), P::ZERO
```
Call-site `Type.staticThing` lowers to `Type::staticThing`.

### Getters / setters (transparent-access rewrite)

`get`/`set` accessors → methods, with a **field-vs-accessor table** so member
expressions rewrite correctly:

- `get area()` → `fn area(&self) -> T`; a **read** `obj.area` → `obj.area()`.
- `set width(v)` → `fn set_width(&mut self, v: T)`; a **write** `obj.width = v` →
  `obj.set_width(v)`.
- The rewrite must distinguish a plain field access from an accessor call, so the
  lowering carries a per-class accessor set; a bare field stays `obj.f`.

This is the heaviest member; it reuses 059's getter-emission where possible.

### Accessibility

- `public` → `pub` field/method.
- `private` → default (no `pub`) — Rust's module privacy.
- `protected` → **`UnsupportedError`** (no Rust equivalent; rejecting is more honest
  than silently widening to `pub(crate)`).

## Fail-loud residuals

- **Generics** (Fork 2).
- **Owned-`self`** with a **non-cloneable** moved-out field.
- **`protected`** members.
- **Decorators** — permanent.
- **Cross-class same-name receiver-mutability edge** — unchanged.

## Impl sequence

1. Run ownership analysis for method bodies → method param `ref`/`refMut`/`move`;
   call-site borrow adaptation.
2. Static members → associated `fn`/`const`; `Type::x` call sites.
3. Accessibility `pub`/private; `protected` reject.
4. Getters/setters + accessor table + member-expression rewrite.
5. RED specs → GREEN.

## Specs sketch

- Method taking a struct param reads it → `&Point` inferred; caller passes `&p`.
- Method mutating a param → `&mut`; caller passes `&mut`.
- `P::origin()` static ctor; `P::ZERO` static const.
- `get area` read as `r.area`; `set width` as `r.width = 3`.
- `public`/`private` field visibility; `protected` → `UnsupportedError`.
- Owned-self-needing method with a cloneable field still compiles (via 038 clone).

## Open sub-details (impl, not dialect forks)

- Accessor naming for setters (`set_x`) vs collision with an existing method.
- Whether static-const type inference reuses the numeric pass or annotates directly.
