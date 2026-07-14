# 069 — Alias-escape tail: interprocedural + field-store promotion

> **Status: SHIPPED (2026-07-14).** Graduates the 062 promotion-recall tail, issue
> **#38**. Dialect calls made with Collin 2026-07-10 (`needs-user-input` cleared).
> Design-couples to **#35** (shares the alias-escape pass). The mutate-during-iteration
> guard is **out of scope** → issue **#41**. Specs: `specs.md` →
> `packages/compiler/tests/alias-escape-interproc.test.ts` (6 specs, all green; full
> suite 780 pass / 0 fail, typecheck clean).
>
> **Impl notes / deviations:**
> - **`computeAutoRc` lifted to module-level** (`alias-escape.ts`) — returns a
>   three-part `AutoRcResult`: `promoted` (scope → local/param binding names),
>   `promotedParams` (callee key → param names), `promotedFields` (class → field
>   names), plus `paramOrder` (callee → positional param names, for the call-site
>   arg→param mapping). This is the **single promoted-set representation** #35/#45/#41
>   graft onto — a downstream series extends the maps, it does not rework them.
> - **One union-find over three namespaces** threads aliasing across scopes: a
>   local/param is `"<scope>::<name>"` (scope = free-fn / `SCRIPT_SCOPE` /
>   `"<Class>::new"` / `"<Class>.<method>"`); a field is `"<Class>#<field>"`. Edges:
>   bare-ident alias `const b = a`; field-store `x.f = a` / `this.f = a` / struct-lit
>   `X { f: a }` (binding ↔ `X#f`); and an **arg↔param** edge at every call passing a
>   class binding into a resolvable callee's param (binding ↔ `<f>::<param_i>`). The
>   **interprocedural fixpoint** is: union first, then promote every component with a
>   mutated member — a mutation in one scope reaches params/fields aliased from another.
> - **≥2-member component gate** preserves the 062 calculus: a lone binding mutated but
>   never aliased (a plain owned value with a `&mut self` call) stays unwrapped. An
>   interprocedural component is already ≥2 (arg+param, or binding+field), so the gate
>   never blocks cross-boundary promotion. (Regression fix: without it, `const b = new
>   C(); b.setter()` over-promoted.)
> - **`refineRc` extended** (`rc.ts`): also processes class ctors/methods (keyed
>   `"<Class>::new"` / `"<Class>.<m>"`); a promoted **param**'s type becomes
>   `Rc<RefCell<T>>` and it enters scope already `rc`; a promoted **class field**'s type
>   becomes `Rc<RefCell<T>>`; a call passing a promoted handle into a promoted param
>   clones it (`Rc::clone(&x)`, borrow → `owned`); a struct-lit / field-store into a
>   promoted field clones (`Rc::clone`) an existing handle or wraps (`Rc::new`) a fresh
>   value; a read through a promoted field borrows (`obj.f.borrow().g`) via a
>   `classOfExpr` resolver that sees through `.borrow()` and nested promoted fields.
> - **Derive predicates** (`derives.ts`) gained an `rc` case: `Rc<RefCell<T>>` is always
>   `Clone`, and `Debug`/`PartialEq` iff its inner is — so a struct that gains a promoted
>   field keeps `#[derive(Clone, Debug, PartialEq)]` (else the promotion silently dropped
>   the struct's derives and broke clone/print sites).
> - **Unresolvable-boundary residual is cargo-loud, not a new `DialectError`.** The spec
>   sketch floated a pre-emptive `DialectError`; manufacturing one risks false-positive
>   rejection of valid programs (violating 062's "never a rejected valid program"
>   calculus). Where the analysis can't resolve a callee (indirect/dynamic dispatch,
>   unsupported shapes), the arg↔param edge is simply not threaded and the existing
>   fail-loud backstops (`UnsupportedError` / cargo E0382/E0599) catch it — fail-loud,
>   never a silent miscompile. Per the design's own "cargo remains the ultimate
>   backstop." Flagged for Collin; hard-erroring a specific boundary can be a later,
>   no-false-positive increment.
>
> Spec-first: this `design.md` → mock → RED `specs.md` → impl → archive.

## Problem

062 shipped **intraprocedural** auto-`Rc<RefCell<T>>`: `analyzeScope` (`alias-escape.ts`)
seeds aliases from bare-ident `const b = a` copies, unions them (union-find), tracks
mutations, and promotes every alias closure (≥2 members, ≥1 mutated) into `refineRc`.
It **deferred** the seeds that require looking past a single scope — each cargo-loud /
oracle-caught today, never a silent miscompile:

- **Interprocedural** — an alias that escapes through a call boundary.
- **Field-store** — an alias stored into a field (`this.f = a`).

Auto-`Rc`'s value is seamlessness (high recall), so these must promote across the
boundaries 062 left as raw E0382/E0599, or fail loud at the boundary they can't resolve.

## Scope (decided 2026-07-10)

Graduate **interprocedural** and **field-store** promotion. **Out:** mutate-during-
iteration over an aliased container (the `RefCell`-panic pattern) → its own robust
handling in **#41**; it **stays fail-loud** as the 062 `DialectError` in the interim,
untouched here. `Rc` cycles / `Weak` remain unmodeled.

## Mechanism

Extend the 062 pass from per-scope to a **module-level** promotion analysis.

### New alias seeds (in addition to bare-ident `const b = a`)

- **Field-store** — `this.f = a` / `obj.f = a` where `a` is a class binding: the
  container binding **and** the field `f` join `a`'s alias closure. Contagion already
  propagates "through fields that hold a promoted binding" (062 design §1); this adds the
  *store* as a closure edge, so the container is promoted when the stored alias is mutated
  elsewhere.
- **Arg-retain** — passing a class binding into a call whose callee **retains** it (stores
  it in a field, or returns it as an alias). The argument and the callee's parameter join
  one closure.

### Interprocedural propagation

- A parameter that receives a **promoted** argument takes `Rc<RefCell<T>>` (or
  `&RefCell<T>` when only borrowed). Promotion propagates **along the call graph** —
  callee params, returns, and stored fields — seeded from every caller's promoted set,
  to a fixpoint.
- **Fail-loud at the unresolvable boundary** — where the analysis can't thread promotion
  (indirect/dynamic dispatch, unbounded recursion, a shape it can't prove), emit a
  `DialectError` at that boundary rather than guess. Still a better message than a raw
  E0382, and cargo remains the ultimate backstop for anything that slips through.

### Feed `refineRc`

The expanded promoted set flows into the existing `refineRc` lowering (already decoupled
from the `"use rc"` directive in 062): `Rc::new(RefCell::new(..))` at construction,
`Rc::clone(&a)` at an alias, `.borrow()`/`.borrow_mut()` at field/method sites — now also
across the call boundaries and field stores this series adds.

Reuse: `alias-escape.ts` (`analyzeScope`, union-find, `rootIdent`, `constructedClass`),
`refineRc`, `ownership.ts` CFG/liveness.

## Fail-loud residuals

- **Aliasing the interprocedural analysis cannot resolve to a promotable set** — fail-loud
  at the unresolved boundary.
- **Mutate-during-iteration over an aliased container** — stays the 062 `DialectError`
  (interim) until **#41** lands its robust, never-panicking lowering. Not changed here.
- **`Rc` cycles / weak references** — unmodeled (JS GC collects cycles; `Rc` leaks them).

## Coupling with #35

#35 adds one more promotion trigger to this same pass — "a consuming (`fn m(self)`) call
on a receiver that is **live afterward**." Design the trigger set together so the module-
level analysis has a single promoted-set representation feeding `refineRc`.

## Impl sequence

1. Lift `analyzeScope` to a module-level analysis with a call-graph + field-alias model.
2. Add field-store and arg-retain seeds to the union-find.
3. Interprocedural propagation to a fixpoint; unresolvable boundary → `DialectError`.
4. Feed the expanded promoted set into `refineRc`.
5. RED `specs.md` → GREEN (differential; interprocedural/field-store aliasing matches JS
   reference semantics with no directive and no cargo error).

## Specs sketch

- `const a = new C(); const b = a; store(b); a.inc(); use(...)` where `store` retains its
  arg in a field → promotion propagates across the call boundary; differential-matches.
- `this.node = a; a.mutate(); use(this.node)` (field-store) → container + field promoted.
- A binding never shared-mutated stays a plain owned value (no `Rc`) — regression guard.
- An unresolvable interprocedural boundary → `DialectError` (not a raw E0382).
- Mutate-during-iteration over an aliased container → still the 062 `DialectError`
  (unchanged; owned by #41).

## Open sub-details (impl, not dialect forks)

- How far to thread promotion through the call graph before giving up to a fail-loud
  boundary (fixpoint depth / recursion handling).
- `&RefCell<T>` (borrow) vs `Rc<RefCell<T>>` (owned handle) at a param that only reads.
- Single promoted-set representation shared with the `"use rc"` directive path and #35.
