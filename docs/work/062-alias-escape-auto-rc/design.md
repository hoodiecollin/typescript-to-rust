# 062 — Escaping mutable-aliasing → auto-`Rc<RefCell<T>>` (panic-case fail-loud)

> **Status: DESIGN (decided, awaiting impl).** Graduates the fail-loud deferral in
> issue #5. Reuses the `refineRc` machinery from **028b** (`"use rc"` first slice)
> and the CFG + backward-liveness from `ownership.ts` (037/038). Dialect/memory-model
> decision made with Collin 2026-07-09.

## The problem

Default lowering (Option A) treats a class instance as a plain owned value that
**moves** on reassignment. JS shared-mutable aliasing therefore can't be expressed:

```ts
const a = new Counter(0);
const b = a;      // JS: b and a are the SAME object
a.inc();          // mutate through a
console.log(b.n); // JS sees 1
```

`const b = a` lowers to a **move**; the later `a.inc()` is cargo **E0382** ("use of
moved value: `a`"). Today the user's only recourse is to add a `"use rc"` directive
(028b), which re-lowers the whole scope under `Rc<RefCell<T>>`. The gap: the user
discovers the problem as a raw borrow-checker error against generated Rust, not
against their TS.

## Decision

**Detect escaping shared-mutable aliasing and auto-lower the aliased bindings to
`Rc<RefCell<T>>` — but stay fail-loud on the narrow pattern that could make `RefCell`
panic at runtime.**

- Rationale: a JS object *is* a shared mutable reference; `Rc<RefCell<T>>` is the
  faithful model. This is **not** a miscompile (fail-loud's real target) — it is the
  correct semantics, in the same spirit as the ownership pass silently inserting
  `.clone()`. A **false positive is cheap**: over-wrapping a binding that didn't
  strictly need `Rc` yields working-but-slightly-slower code, never a rejected valid
  program. So imprecision toward *more* `Rc` is tolerable — the inverse of the
  usual fail-loud risk calculus.
- The one place auto-`Rc` stops being merely faithful is the **`RefCell` runtime
  panic**: `borrow_mut()` panics if a borrow is already outstanding (a borrow held
  across a re-entrant mutation — mutate-during-iteration, a callback that mutates an
  aliased object). JS never panics there, so this would **diverge from the
  differential oracle**. That specific pattern stays **fail-loud** (`DialectError`),
  not silently auto-`Rc`'d.
- **This forces finishing the 028b deferral tail.** Auto-`Rc`'s value is
  seamlessness, which demands high recall; the aliased set must therefore work
  across the boundaries 028b left cargo-loud — chiefly **`Rc` values crossing a
  call boundary**, plus **method calls on an `Rc` binding**. Those graduate here.

> Collin chose auto-lower + panic-case fail-loud over "always auto-`Rc`" (accepts the
> panic window) and over the diagnostic-only "keep it a `DialectError`" route. The
> optional "log a note at each auto-`Rc` site" variant was **not** taken — auto-`Rc`
> is silent (see Open sub-details for revisiting visibility).

## Mechanism

### 1. Alias-escape analysis (new pass, reuses `ownership.ts` CFG/liveness)

A HIR→HIR analysis, sibling to `ownership.ts`, computes per scope the set of
class-typed bindings that participate in **shared-mutable aliasing**:

- Seed: every `const/let b = a` (bare-ident init) where `a` is a class-typed binding
  — `b` is an **alias** of `a`.
- Also seed aliases formed by passing a class binding into a call that retains it,
  and by storing it in a field (the transitive sources 028b deferred).
- Compute the **transitive alias closure**: if `a` and `b` alias and either is
  mutated (`x.f = …`, or a method with `&mut self`) while the other is **live-used
  afterward** (backward liveness, already available), the whole closure is
  **rc-promoted**. Contagion propagates through fields that hold a promoted binding.
- Bindings never involved in shared mutation stay plain owned values (Option A) —
  auto-`Rc` is surgical, per-binding, **not** the scope-wide blunt wrap `"use rc"`
  applies.

### 2. Auto-promotion → `refineRc` (reuse 028b)

The promoted binding set is handed to the existing `refineRc` lowering, which already
emits `Rc::new(RefCell::new(…))` at construction, `Rc::clone(&a)` at an alias, and
`.borrow()` / `.borrow_mut()` at field read/write. The change from 028b: the promoted
set comes from **analysis**, not from a `"use rc"` directive + "all class bindings in
scope." Directive-driven `"use rc"` remains as an explicit override.

**028b tail graduated (required for recall):**

- **Method call on a promoted binding** — `a.foo()` → `a.borrow().foo()` /
  `a.borrow_mut().foo()` per the method's receiver mutability (name-based, already
  known). (028b left this as bare → cargo E0599.)
- **Promoted value across a call boundary** — a param that receives a promoted
  argument takes `Rc<RefCell<T>>` (or `&RefCell<T>`); the analysis must propagate
  promotion **interprocedurally** or fail-loud at the boundary it can't resolve.

### 3. Panic-case fail-loud

The analysis flags, and rejects with a `DialectError`, the pattern where a **borrow
is held across a re-entrant mutation** of the same promoted cell — i.e. a
`borrow()`/`borrow_mut()` whose result is live across a call that can `borrow_mut()`
the same cell (mutate-during-iteration over an aliased container; a callback closing
over and mutating an aliased object). Message points at the TS mutation site and
explains the aliasing + re-entrancy, since this is the one shape that would panic at
runtime rather than mirror JS.

## Fail-loud residuals

- **Borrow-across-re-entrant-mutation** — the `RefCell`-panic pattern (the point of
  the decision).
- **Aliasing the interprocedural analysis cannot resolve to a promotable set** —
  fail-loud at the unresolved boundary rather than guess (still better message than a
  raw E0382; cargo remains the ultimate backstop for anything that slips through).
- **`Rc` cycles / weak references** — unmodeled; JS GC collects cycles, `Rc` leaks
  them. Out of scope (would need `Weak`, its own decision).

## Impl sequence

1. Alias-escape analysis: seed aliases (assignment, arg-retain, field-store),
   transitive closure, mutation-with-live-alias promotion (reuse `ownership.ts`
   CFG/liveness).
2. Feed the promoted set into `refineRc` (decouple it from the directive path).
3. Graduate 028b tail: method calls on promoted bindings; promoted values across
   call boundaries (interprocedural promotion propagation).
4. Panic-case detector: borrow-held-across-re-entrant-mutation → `DialectError`.
5. RED specs → GREEN (differential; auto-`Rc` result must match JS reference
   semantics exactly for the non-panic cases).

## Specs sketch

- `const a = new C(); const b = a; a.inc(); use(b.n)` → both promoted to
  `Rc<RefCell<C>>`; differential-match (no directive, no cargo error).
- Aliasing through a call that retains the argument → promotion propagates across the
  boundary.
- A binding never shared-mutated stays a plain owned value (no `Rc`).
- Method call on a promoted binding → `borrow()/borrow_mut()` per receiver.
- Fail-loud: mutate-during-iteration over an aliased container (would `RefCell`-panic)
  → `DialectError` at the TS site.

## Open sub-details (impl, not dialect forks)

- **Visibility of auto-`Rc`.** The decision is silent insertion. If it proves
  surprising in practice, revisit surfacing a non-fatal note at each auto-`Rc` site
  via the #8/056 warning channel (the "log a diagnostic" variant, deferred for now).
- Exact interprocedural promotion propagation vs. fail-loud boundary — how far the
  analysis threads promotion through call graphs before giving up.
- Whether directive-driven `"use rc"` and analysis-driven auto-`Rc` share one
  promoted-set representation feeding `refineRc` (they should).
- `swap`/reassignment of a promoted binding — `Rc::clone` vs. move of the handle.
