# 068 — Broad owned-`self` (consuming methods): specs

> **Status: SHIPPED.** Differential-oracle BDD (compile → `cargo run` → compare stdout
> vs Bun-run TS), plus emitted-shape assertions. IDs map 1:1 to
> `packages/compiler/tests/owned-self.test.ts`. Graduates the 060 owned-`self`
> deferral (issue **#35**): a method that moves a non-`Copy` field out of `this` with
> no subsequent `self` use lowers to an **owned** receiver and drops the 038 field
> clone; reuse routes to the 062/069 auto-`Rc` machinery.

## Consuming (owned `self`)

- **OS1** dead-after consuming call — `build(): Config { return this.cfg }`, then
  `const c = b.build()` with `b` dead → `fn build(self)`, `return self.cfg` (no
  `.clone()`); differential-matches.
- **OS2** a **non-`Clone`** moved-out field (a `Handle` with a fn-pointer field, so
  the struct is outside the `Clone` derive) with a **dead** receiver → `fn take(self)`
  compiles now (was cargo-loud `E0507` — could not clone `self.h` behind `&self`);
  differential-matches.
- **OS3** an `Array<number>` (`Vec<f64>`) field consuming method (`intoVec`) → owned
  `self`, `return self.items` with no clone; differential-matches.

## Caller reuse → auto-`Rc` fallback

- **OS4** the receiver is **reused** after the consuming call (`b.build()` then
  `b.label()`) → `b` promotes to `Rc<RefCell<Builder>>` (the same #38 union-find,
  bypassing the ≥2-member gate) and `build` **falls back** to `&self` + clone
  (`b.borrow().build()`, `self.cfg.clone()`); differential-matches.
- **OS5** reused receiver **and** a non-`Clone` moved-out field → `DialectError` (a
  shared `Rc<RefCell<T>>` cannot move the field out, and it cannot be cloned) — the
  documented reconciliation boundary.

## Regression guards (broad re-emit safety)

- **OS6** a **non-consuming** `&self` method (`area(): number { return this.w *
  this.h }` — reads, no move-out) is unchanged (`fn area(&self)`, no owned self).
- **OS7** a **Copy-field** return (`get(): number { return this.n }`) stays `&self`
  — the non-`Copy` gate keeps it byte-for-byte unchanged (owned self would only
  churn call sites for no clone-avoidance benefit).

> Not a numbered spec but exercised by the full suite: the inheritance-composition
> path (`super.describe()` → `self.base.describe()`) and a `this.m()` self-receiver
> call both **demote** the candidate (a field/`self` receiver can't move out) — the
> `inherit-compose` / `type-oracle` suites are the regression oracle.

## Mechanism

- **`analysis.ts`** — `consumingField` matches the terminal `return this.field`
  shape; `consumingCandidates` (method → field) is the syntactic candidate set. The
  non-`Copy` gate and the call-site decision are deferred to the alias-escape pass
  (which has the lowered field types).
- **`alias-escape.ts` (`computeAutoRc`)** — the single #38 union-find gains the
  consuming edge: per scope, reusing `ownership.ts`'s `computeLiveOut`, each
  `obj.m()` to a candidate is a clean owned-local move (dead-after bare local) or a
  demotion (`this`/field receiver, or a live-after local — the latter force-promotes
  the receiver to `Rc<RefCell<T>>`). Returns `consumingMethods`, the finalized
  owned-receiver set; throws `DialectError` on a non-`Clone` field under demotion.
- **`lower.ts` (`applyOwnedSelf`)** — retags each consuming method `recv: "owned"`
  before `refineOwnership`; **`ownership.ts` (`selfParams`)** types an owned `self`
  as the plain struct so the field move-out is a legal partial move (drops the 038
  clone); **`emitter.ts` (`selfReceiver`)** renders `self`.

## Fail-loud residuals

- **Consuming method on a shared/reused or borrowed/field receiver whose moved-out
  field is non-`Clone`** — the reconciliation boundary (OS5). Rare; a `DialectError`.
- **Broader move-out shapes** (a field moved into an owned local / a call arg, not a
  terminal `return this.field`) — not classified consuming; they keep the 038 clone
  (cloneable) or stay cargo-loud (non-`Clone`), unchanged from 060.
- **Cross-class same-name receiver edge** — unchanged from 060 (name-keyed method
  facts; a same-named consuming + non-consuming method across classes is the
  documented limit).
