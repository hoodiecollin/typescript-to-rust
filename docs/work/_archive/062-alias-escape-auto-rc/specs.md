# 062 — specs (alias-escape → auto-`Rc<RefCell<T>>`)

> **Status: SHIPPED.** Differential BDD specs live in
> `packages/compiler/tests/alias-escape-rc.test.ts` (compile → cargo run →
> TS-via-Bun). IDs map 1:1 to the test names.

## Specs

- **AR1** shared-mutation through an alias observes the mutation — `const b = a;
  a.inc(); use(b.n)` auto-promotes the closure to `Rc<RefCell<Counter>>`
  (`Rc::clone(&a)`, `a.borrow_mut().inc()`, `b.borrow().n`); no directive.
- **AR2** a field write through one alias (`b.n = 99`) is seen through the other.
- **AR3** a non-shared class binding stays a plain owned value (no `Rc`).
- **AR4** an aliased-but-never-mutated pair stays a plain `.clone()` (no `Rc`) — the
  promotion is gated on a mutation in the alias closure.
- **AR5** a three-way alias closure (`a`→`b`→`c`) all observe the mutation.

Plus **rc-directive.test.ts** "no `use rc` → the alias is auto-promoted" (the
former Option-A move-error case, graduated).

## Mechanism

- `alias-escape.ts` computes, per scope, the class-binding closure that is **aliased**
  (a bare-ident `const b = a`) **and** **mutated** (`x.f = …` or a `&mut self`
  method call), via a union-find over alias edges. False positives are cheap
  (over-`Rc` is slower, never wrong), so the analysis errs toward more promotion.
- The promoted set feeds the existing `refineRc` (028b), decoupled from the
  `"use rc"` directive. Method calls on a promoted binding graduate the 028b
  deferral: `a.foo()` → `a.borrow_mut().foo()` / `a.borrow().foo()` per the method's
  receiver mutability (name-based, `mutatingMethods`).

## Fail-loud residuals

- **Interprocedural promotion** — an aliased binding passed into a function that
  retains it does not propagate promotion across the boundary (cargo-loud there).
  Deferred.
- **Field-store aliasing** — storing a class binding in a struct field is not seeded
  as an alias. Deferred.
- **Borrow-across-re-entrant-mutation** (the `RefCell`-panic pattern) — not
  statically rejected this increment; the differential oracle catches it (Rust
  panics where JS does not), and cargo/runtime is the backstop. The design's
  pre-emptive `DialectError` is deferred.
- **`Rc` cycles / weak references** — unmodeled (`Weak` is its own decision).
