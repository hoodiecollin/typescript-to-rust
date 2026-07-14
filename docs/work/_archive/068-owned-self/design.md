# 068 — Broad owned-`self` (consuming methods → `fn m(self)`)

> **Status: SHIPPED (2026-07-14).** Graduates the 060 owned-`self` deferral, issue
> **#35**. Dialect calls made with Collin 2026-07-10 (`needs-user-input` cleared).
> Couples to **#38** (both extend the 062/069 alias-escape pass). Specs: `specs.md`
> → `packages/compiler/tests/owned-self.test.ts`.
>
> **Impl notes / deviations:**
> - **Consuming-candidate detection is syntactic (`analysis.ts`, `consumingField`),
>   not a separate CFG pass.** A candidate is a method whose body **ends in** a bare
>   `return this.field;` — because the move *is* the terminal `return`, "no
>   subsequent `self` use" holds trivially, so the design's move-analysis reduces to
>   a shape match. Broader move-out shapes (into an owned local, into a call arg)
>   stay non-consuming (038 clone / cargo backstop). `analysis.consumingCandidates`
>   is the method→field map; a `&mut self` method is never a candidate.
> - **The non-`Copy` gate + the call-site-reuse decision live in `computeAutoRc`**
>   (the single #38 union-find), which the design flagged as the coupling point. It
>   is threaded `consumingCandidates` and, per scope, reuses `ownership.ts`'s CFG
>   liveness (new export `computeLiveOut`) over the class bindings to decide each
>   `obj.m()` call site. A candidate is finalized **consuming** iff its moved-out
>   field is non-`Copy` **and** every call site is a clean owned-local move.
> - **Demotion is broader than "reuse".** Besides a live-after (reused) receiver
>   (which force-promotes that binding to `Rc<RefCell<T>>`, bypassing the ≥2-member
>   gate), a candidate is also demoted when called on a **`this`/`self`** receiver
>   (`this.m()` inside another method) or a **field receiver** (`self.base.m()`, the
>   inheritance-composition path) — neither can move out of a borrowed/place
>   receiver. Demoted ⇒ `&self` + 038 clone; a non-`Clone` field under any demotion
>   ⇒ `DialectError`.
> - `AutoRcResult` gained one field, **`consumingMethods: Set<string>`** — the
>   finalized owned-receiver method names. A new `applyOwnedSelf` pass (in `lower`,
>   after `computeAutoRc`, before `refineOwnership`) retags each to `recv: "owned"`;
>   the emitter renders `self`, and `ownership.ts`'s `selfParams` types `self` as the
>   owned struct so the `return self.field` move-out drops the clone.
> - `SelfRecv` gained `"owned"` (`hir.ts`); the emitter's receiver rendering is
>   factored into `selfReceiver`.

## Problem

060 shipped method-param borrow inference but left **owned-`self`** deferred. Today a
method that moves a non-`Copy` field out of `this` (`unwrap() { return this.h }`, a
builder `build()`, `intoVec()`) is lowered `&self` and the **038 move-out pass inserts
a `.clone()`** on the field — so cloneable fields *compile* (at a clone's cost) and the
sole cargo-loud residual is a **non-`Clone`** moved-out field (`.clone()` fails).

## Scope — broad (decided 2026-07-10)

Collin chose the **broad** graduation over the minimal close-the-residual one: detect
**every** consuming method and emit `fn m(self)`, dropping the 038 clone even for
cloneable fields. This is a clone-avoidance win that **re-emits currently-working
methods**, so it requires **broad differential-oracle re-validation**.

- A method is **consuming** iff it **moves a non-`Copy` field out of `self`** (returns
  `this.field`, or moves it into a call/return) **and does not use `self` after** that
  move. CFG move-analysis (issue #1, shipped) provides the "no subsequent self-use" fact.
- Consuming → receiver `self` (by value); the moved-out field is `self.field` (no clone).
- Non-consuming methods are unchanged (name-based `&self`/`&mut self`).

## Decision — caller reuse routes to auto-`Rc` (062)

`fn m(self)` **moves the receiver at the call site**. When the caller still uses the
object after `obj.m()`, Collin's call is to treat it as **shared-mutable and promote the
receiver to `Rc<RefCell<T>>`** via the 062 alias-escape machinery — *not* a call-site
clone, *not* a hard fail. This **couples #35 to #38 / the alias-escape pass**: its
promotion-trigger set gains "a by-value (consuming) method call on a receiver that is
**live afterward**."

### The reconciliation boundary (open for impl)

A **consuming** method (`fn m(self)`, moves a field out) is incompatible with a
**shared** (`Rc<RefCell<T>>`) receiver — *you cannot move out of a shared cell*. So when
the receiver is promoted, the method call must fall back to the **non-consuming shape**
for that receiver: `&self` + **clone the moved-out field** (the 038 path). If that field
is **non-`Clone`**, shared reuse of a consuming method is genuinely unrepresentable
without more machinery → **documented fail-loud boundary** (rare). The promotion thus
resolves the *common* reuse case and fails loud only at the non-`Clone`-under-sharing tail.

## Mechanism

1. **Consuming-method detection** — run the ownership/move analysis over method bodies
   (060 already runs param-borrow inference there; extend it to classify the *receiver*).
   A field moved out of `self` with no later `self` use ⇒ mark the method consuming;
   record which field is moved (to drop its 038 clone).
2. **Emit** — a consuming method lowers `self` (owned receiver); the moved-out field
   read emits `self.field` without the 038 `.clone()`.
3. **Call-site liveness** — at each `obj.m()` to a consuming method, consult CFG liveness
   on `obj`. Dead-after ⇒ clean move (the fast path, no clone anywhere). Live-after ⇒
   **feed `obj` to the alias-escape promotion set** (reuse #38's pass).
4. **Promoted receiver fallback** — for a promoted (`Rc<RefCell<T>>`) receiver, re-lower
   the consuming call as `&self` + field-`.clone()`; non-`Clone` field ⇒ `DialectError`
   at the TS call site (documented boundary).

Reuse: 060 method-body ownership analysis; 038 move-out/clone pass; 062 `alias-escape.ts`
+ `refineRc`.

## Fail-loud residuals

- **Consuming method on a shared (reused) receiver whose moved-out field is non-`Clone`**
  — the reconciliation boundary above.
- **Cross-class same-name receiver-mutability edge** — unchanged from 060.

## Impl sequence

1. Classify method receivers (consuming vs `&self`/`&mut self`) via method-body move
   analysis; record the moved-out field.
2. Emit `fn m(self)` + drop the field clone for consuming methods.
3. Call-site liveness → clean move (dead) vs alias-escape promotion (live).
4. Promoted-receiver fallback (`&self` + field clone; non-`Clone` → `DialectError`).
5. RED `specs.md` → GREEN; **re-run the full differential suite** (broad re-emit).

## Specs sketch

- `build(): Config { return this.cfg }`, `const c = b.build()` (b dead) → `fn build(self)`,
  `self.cfg`, no clone; differential-matches.
- `unwrap(): Handle { return this.h }` with non-`Clone` `Handle`, receiver dead → compiles
  now (was cargo-loud).
- Consuming call with the receiver **reused** after → receiver promoted to `Rc<RefCell<T>>`;
  differential-matches.
- Consuming call, reused receiver, **non-`Clone`** moved-out field → `DialectError`.
- A non-consuming method is byte-for-byte unchanged (regression guard).

## Open sub-details (impl, not dialect forks)

- Precise "moves a field out" detection (return of `this.f`, `this.f` passed to an owned
  param, `this.f` moved into a local) vs a mere read.
- Whether receiver classification lives in `analysis.ts` alongside `methodParams` or a
  dedicated pass.
- Ordering vs the alias-escape pass (promotion must see call-site liveness results).
