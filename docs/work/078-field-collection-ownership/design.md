# 078 — Ownership of field-held mutable collections (`localVar.field.<mut>()` borrow tail)

> **Status: DESIGN COMPLETE (2026-07-11). Impl pending.** Graduates the `localVar.field`
> borrow-conflict tail that **#37/072 ships fail-loud**, issue **#45** (companion to #37).
> Dialect calls made with Collin 2026-07-11 (`needs-user-input` cleared). **Impl-ordered
> after 072** (needs `collectionOf` to resolve `localVar.field`). Coordinates the promoted-set
> representation with **#35/068** and **#38/069**; ties the re-entrant-overlap tail to **#41**.
> Closure-capture of a mutable container is **split to its own issue** (see Residuals).
>
> Spec-first: this `design.md` → mock → RED `specs.md` → impl → archive.

## Problem

#37/072 adopts Fork C2 — routing a Map/Set method whose receiver is `localVar.field` (a
field reached through a local of known struct type). It ships only the **clean** case (a
plainly-owned local with an exclusive `&mut` available) and **fails loud** on the
borrow-conflict tail: when the owning local is **borrowed-across**, **moved**, **`Rc`-shared**
(062), or **captured** by a mutating closure. This series graduates that tail.

`this.field` mutation is always sound (inside a `&mut self` method the exclusive borrow is
already held). `localVar.field.<mut>()` needs a `&mut localVar.field`, sound only when the
owner is exclusively owned.

## What the machinery already does (grounding)

- **Mutation is already attributed to the owner.** `alias-escape.ts`'s `noteMutations`
  extracts `rootIdent` from a mutating method receiver, so `localVar.field.set(k,v)` already
  marks `localVar` mutated (`analysis.ts:82–96`).
- **`refineRc` already threads the cell through a field place.** A field-access object that is
  a promoted ident is wrapped in `.borrow()`/`.borrow_mut()` (`rc.ts:77–97`), so
  `localVar.field.insert(..)` on a promoted owner becomes `localVar.borrow_mut().field.insert(..)`
  — **modulo threading write-mode** to a field that is the *receiver of a mutating method*
  (today the method case only special-cases a direct ident receiver, `rc.ts:147–163`).
- **The promoted set is a flat `Set<string>` per scope** from a union-find over alias edges,
  promoting components with **≥2 members and ≥1 mutated** (`alias-escape.ts:117–130`).

So the **Rc-shared / field-store / arg-retain owner cases ride the existing pass almost
mechanically** once 072 lands; the work is (a) a write-mode threading fix and (b) a **new
promotion trigger** for borrow-conflicted owners.

## Decisions (2026-07-11, with Collin)

### 1. Wire field-held collections into the shared promoted set + `refineRc`

An owner that is **`Rc`-shared** (062), **field-stored**, or **arg-retained** (069's new
seeds) promotes; its field mutation lowers to `localVar.borrow_mut().field.insert(..)` through
`refineRc`. This reuses #35/#38's single promoted-set representation — field-held collections
are "one more alias shape," per #45's scope item 3.

### 2. Build a borrow-across → promote path (Q1: aggressive)

Beyond the cases the pass already reaches, **build a conservative borrow-overlap detector**
and **promote** a borrow-conflicted owner to `Rc<RefCell<T>>` as well. The honest framing:

- Our compile-time borrow reasoning is **conservative** — it flags overlaps it can't prove
  disjoint. **Promotion removes the spurious-conflict majority** (the borrows were actually
  runtime-disjoint; `Rc<RefCell>` just makes that explicit) — a pure seamlessness win, exactly
  062's "over-promotion is cheap" calculus.
- A **genuinely re-entrant overlap** over a promoted field (a live borrow spanning the
  `borrow_mut`) would `RefCell`-panic — but that pattern **is** the **#41 mutate-during-
  iteration** case. So it routes to **#41's robust handling** (index-based re-borrow); until
  #41 ships it **stays fail-loud** (062's `DialectError`, no regression). #45 does not
  introduce a new panic — it defers the one panic-shaped sub-case to #41.

### 3. Closure-capture of a mutable container — split to its own issue (Q2)

A closure that *mutates* a captured collection is a **hard fail-loud today** at `freeVarsOf`
(`lower.ts:5952`, `"mutable capture in a callback"`), and captures aren't alias seeds.
Graduating it needs a **048/057 closure-lift rework** (promote the captured container to
`Rc<RefCell>` and capture the clone) — a new capability, not a field-borrow tail. It stays a
**documented fail-loud residual** in #45 and is tracked as **#46** (`closures`+`ownership`).

## Mechanism

### Per-site classification

At each `localVar.field.<mut>()` site the ownership pass picks one of three:

1. **Clean** — owner exclusively owned, not aliased, no overlapping live borrow, not
   moved-before → emit `localVar.field.insert(..)` directly (072's clean path). **Moved-
   *after* the mutation is clean** (a `&mut` then a later move).
2. **Promote** — owner is aliased/field-stored/arg-retained, **or** the borrow-overlap
   detector cannot certify an exclusive `&mut` → add the owner to the promoted set →
   `refineRc` emits `localVar.borrow_mut().field.insert(..)`.
3. **Fail-loud** — promotion unrepresentable (below).

### The borrow-overlap detector (new)

Reuse `ownership.ts` liveness + the `moved` set; add a conservative overlap check: **any
reference derived from the owner (a binding of `localVar` or `localVar.field`, or the owner
passed by-`&` to a retainer) that is live across the mutating site** marks the owner for
promotion. Precision toward *more* promotion is intended (062 ethos). Exact predicate is an
open sub-detail.

### New single-owner promotion trigger (coordinate with #35/#38)

062 promotes only alias components of **≥2 members** (`alias-escape.ts:126`). A borrow-
conflicted owner may be a **single** binding with **no** class-alias — so #45 adds a
promotion trigger that does **not** require a ≥2-member closure: a per-site borrow-conflict (or
a field-mutation on an already-promoted/field-stored owner) promotes that one binding. This
feeds the **same** flat promoted `Set<string>` that #35/#38 use — one representation, two
trigger kinds (aliasing ≥2; borrow-conflict per-site).

### Write-mode threading fix

In `refineRc`, when lowering a **mutating** method call whose receiver is `owner.field`
(owner ∈ rc), thread `write = true` into the field-access rewrite so the object borrows
`borrow_mut` (not `borrow`). Today the method case only certifies a direct-ident receiver
(`rc.ts:147`); extend it to a field-of-rc receiver.

### Reuse

062 `alias-escape.ts` promoted set + `refineRc` (`rc.ts`); 069 field-store/arg-retain seeds;
068's non-`Clone`-under-sharing boundary; `ownership.ts` liveness + `moved`; 072 `collectionOf`
`localVar.field` resolution + `wrapKey`; `mutatingMethods` (`analysis.ts`).

## Fail-loud residuals

- **Closure-captured mutable container** — split to its own `closures`+`ownership` issue; the
  `freeVarsOf` mutable-capture rejection stands in the interim.
- **Non-`Clone` collection moved out under sharing** — a promoted (`Rc<RefCell>`) owner cannot
  move a non-`Clone` field-held collection out; unrepresentable without more machinery (068's
  exact boundary). Fail-loud.
- **Moved-*before* the mutation** — use-after-move; the `moved` set catches it → `DialectError`.
- **Re-entrant overlap over a promoted field** (a live borrow spanning the `borrow_mut` — the
  mutate-during-iteration shape) → **#41**; fail-loud until #41 ships (no new panic emitted).
- **Non-name / non-`localVar.field` receivers** — `getCache().entries.set(..)`, nested
  `a.b.entries.set(..)` — unchanged 072 boundary.
- Everything 062/068/069 reject downstream (`Rc` cycles, `Weak`, unresolvable interprocedural
  boundary) — unchanged.

## Impl sequence

1. **Site classification** in the ownership pass: clean / promote / fail-loud for
   `localVar.field.<mut>()` (needs 072's `collectionOf` resolution).
2. **Borrow-overlap detector** — the conservative "reference derived from owner live across the
   site" check over `ownership.ts` liveness + `moved`.
3. **Promotion trigger** — feed borrow-conflicted / field-stored owners into the shared
   promoted `Set<string>` (single-owner path, no ≥2-member requirement); reconcile with the
   062 union-find.
4. **`refineRc` write-mode threading** — mutating method on `owner.field` (owner ∈ rc) →
   `borrow_mut` on the field object.
5. **Fail-loud wiring** — non-`Clone`-under-sharing, moved-before, re-entrant-overlap (→ #41),
   closure-capture (→ split issue).
6. RED `specs.md` → GREEN (differential — clean owned-local mutation; aliased/shared-owner
   mutation through `borrow_mut`; borrow-across promotion; fail-loud boundaries).

## Specs sketch

- **Clean** — `const c = new Cache(); c.entries.set("k", 1); c.entries.get("k")` (owned local,
  no alias) → direct `c.entries.insert(..)`; differential-matches.
- **Rc-shared owner** — `const c = new Cache(); const d = c; d.entries.set("k", 1); c.entries.get("k")`
  (alias) → both promoted; `d.borrow_mut().entries.insert(..)`; `c` sees the write;
  differential-matches.
- **Field-stored owner** — `this.cache = c; … c.entries.set(..)` (069 seed) → promoted.
- **Borrow-across** — a reference to `c.entries` live across `c.entries.set(..)` → owner
  promoted (compile conflict removed), differential-matches (non-re-entrant).
- **Moved-after** — `c.entries.set(..); use(c)` then `consume(c)` → clean `&mut` then move.
- Fail-loud: non-`Clone` collection moved out under sharing; moved-before; a closure mutating a
  captured `c.entries` (→ split issue); mutate-during-iteration over a promoted `c.entries`
  (→ #41 interim).
- Regression: `this.field` collection mutation (072) and a plainly-owned `localVar.field`
  (072 clean path) — **byte-for-byte unchanged**.

## Open sub-details (impl, not dialect forks)

- The exact borrow-overlap predicate (how much precision before defaulting to promote) and
  whether it lives in `ownership.ts` or a sibling pass feeding `alias-escape`.
- Reconciling the single-owner borrow-conflict trigger with 062's ≥2-member union-find (a
  parallel promotion source vs. a synthetic self-edge).
- Whether the `refineRc` write-mode fix generalizes to arbitrary nested places
  (`owner.a.b.set(..)`) or stays one level (`owner.field`) — one level matches 072's receiver
  scope.
- Interaction ordering with #35's consuming-method promotion and #38's interprocedural
  fixpoint — all three feed one promoted set; confirm a single fixpoint pass, not three.
