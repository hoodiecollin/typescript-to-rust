# 069 — Alias-escape interprocedural / field-store: specs

> **Status: SHIPPED.** Differential-oracle BDD (compile → `cargo run` → compare stdout
> vs Bun-run TS). IDs map 1:1 to `packages/compiler/tests/alias-escape-interproc.test.ts`.
> Graduates the 062 promotion-recall tail (issue **#38**): promotion threads across the
> call boundary and through field stores, with no `"use rc"` directive and no cargo error.

## Interprocedural promotion (a retaining callee)

- **IP1** `const a = new C(); const b = a; const h = store(b); a.inc(); use(h.c.n)` where
  `store(c) { return new Holder(c) }` **retains** its arg in a field → promotion threads
  across the call boundary (`store`'s param `c` → `Rc<RefCell<C>>`, `Holder.c` field
  promoted, call site `store(Rc::clone(&b))`); differential-matches.
- **IP2** the retaining callee's param carries the promoted handle type — `fn store(c:
  Rc<RefCell<Counter>>)` — and a mutation through the *other* alias (`b.inc()`) is
  observed through the retained field; differential-matches.
- **IP3** a **non-retaining** callee that only reads its arg (`peek(c) { return c.n }`),
  whose arg is never shared-mutated, stays a plain owned value — no `Rc` (regression
  guard against over-promotion at a call boundary).

## Field-store promotion

- **FS1** a field-store `h.c = a` after construction unions the container's field into
  `a`'s alias closure: a later `a.inc()` is observed through `h.c.n`; the field type is
  `Rc<RefCell<Counter>>` and the store clones the handle; differential-matches.
- **FS2** a three-hop field-store closure (`const b = a; const h = new Box(a); h.c = b;
  b.inc()`) — the container's field, `a`, and `b` all observe the mutation;
  differential-matches.

## Regression

- **IP4** intraprocedural aliasing still promotes (062 AR1): `const b = a; a.inc();
  use(b.n)` → `Rc::clone(&a)`; the module-level lift did not regress the per-scope core.

## Mechanism

- `alias-escape.ts`'s `computeAutoRc` is a **module-level** analysis returning a
  three-part `AutoRcResult` (`promoted` / `promotedParams` / `promotedFields`, plus
  `paramOrder`) — the single promoted-set representation. One union-find over
  binding/param (`<scope>::<name>`) and field (`<Class>#<field>`) namespaces, seeded by
  bare-ident aliases, field stores (`x.f = a` / `this.f = a` / `X { f: a }`), and
  arg↔param edges at resolvable calls. Promotion is the fixpoint "union, then promote
  every ≥2-member component with a mutated member."
- `refineRc` (028b/062) consumes it: promoted params/fields take `Rc<RefCell<T>>`, call
  sites clone the handle into a promoted param, stores clone/wrap into a promoted field,
  and reads through a promoted field borrow.

## Fail-loud residuals

- **Aliasing the analysis cannot resolve to a promotable component** (indirect/dynamic
  dispatch, unsupported shapes) — the arg↔param edge is not threaded; the existing
  `UnsupportedError` / cargo (E0382/E0599) backstops catch it. Cargo-loud, never a silent
  miscompile. (A pre-emptive `DialectError` was deliberately *not* added — it risks
  false-positive rejection of valid programs; deferred as a possible no-false-positive
  increment.)
- **Mutate-during-iteration over an aliased container** — stays the 062 interim guard
  (oracle/cargo-caught); issue **#41** owns its robust, never-panicking lowering.
  Unchanged here.
- **`Rc` cycles / weak references** — unmodeled (`Weak` is its own decision).
